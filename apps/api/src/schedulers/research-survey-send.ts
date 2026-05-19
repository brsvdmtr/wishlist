// Research survey send scheduler — drives the PENDING → SENT / FAILED loop.
//
// Disabled by default. Two env switches are checked on every tick (no
// restart required to toggle):
//
//   RESEARCH_SURVEY_SEND_ENABLED     — 'true' / 'false' (default false)
//   RESEARCH_SURVEY_ACTIVE_SLUG      — slug whose PENDING invites should be
//                                      drained (default unset → no-op)
//
// Operational expectation:
//   1. ops job seeds invites into ResearchSurveyInvite as PENDING
//      (separate admin command; not this scheduler).
//   2. ops sets RESEARCH_SURVEY_ACTIVE_SLUG=pmf-discovery
//   3. ops flips RESEARCH_SURVEY_SEND_ENABLED=true
//   4. this scheduler drains 30 invites/tick at 5 msg/sec, capped at 200/h.
//   5. on outcome:
//        delivered           → status=SENT, sentAt=now, emit survey.invite_sent
//        bot_blocked         → status=FAILED, failureReason='bot_blocked',
//                              UserProfile.notifyMarketing=false (auto-opt-out),
//                              emit survey.invite_failed
//        chat_not_found      → status=FAILED, failureReason='chat_not_found'
//        permanent_failure   → status=FAILED, failureReason='telegram_4xx'
//        transient_failure   → no status change (retried next tick)
//
// Time window (rule B): Europe/Moscow 09:00–21:00. Outside the window the
// tick exits early without sending, leaving PENDING for the next valid
// window. Fallback for unknown TZ is UTC+3 (same as Moscow) per design v1.2.
//
// Hourly hard cap (anti-spam rule #9): max 200 invites sent globally per
// rolling hour. Checked against ResearchSurveyInvite.sentAt count.

import { prisma } from '@wishlist/db';
import type { Logger } from 'pino';
import { sendSurveyInviteDM, type SurveyDmOutcome } from '../notifications/research-survey-invite';
import { trackProductEvent } from '../services/analytics';
import type { SurveyLocale } from '../services/research-survey/locale';

export interface ResearchSurveySendDeps {
  logger: Logger;
}

const TICK_INTERVAL_MS = 60_000;
const STARTUP_DELAY_MS = 30_000;
const BATCH_PER_TICK = 30;
const SEND_INTERVAL_MS = 200; // 5 msg/sec — Telegram-friendly burst rate
const HOURLY_CAP = 200;

// Local-time send window, applied via Europe/Moscow.
const TZ_NAME = 'Europe/Moscow';
const WINDOW_START_HOUR = 9;
const WINDOW_END_HOUR = 21;

export function startResearchSurveySendScheduler(deps: ResearchSurveySendDeps): void {
  const { logger } = deps;

  async function tick(): Promise<void> {
    if (!isEnabled()) return;
    const activeSlug = process.env.RESEARCH_SURVEY_ACTIVE_SLUG ?? '';
    if (!activeSlug) return;
    if (!isWithinWindow(new Date())) return;

    const survey = await prisma.researchSurvey.findFirst({
      where: { slug: activeSlug, status: 'ACTIVE' },
      select: { id: true, slug: true },
    });
    if (!survey) {
      logger.debug({ slug: activeSlug }, 'research-survey: no ACTIVE survey for slug; skipping tick');
      return;
    }

    const remainingHourlyCap = await getRemainingHourlyCap();
    if (remainingHourlyCap <= 0) {
      logger.info({ slug: activeSlug }, 'research-survey: hourly cap reached; skipping tick');
      return;
    }

    const batchSize = Math.min(BATCH_PER_TICK, remainingHourlyCap);
    const invites = await prisma.researchSurveyInvite.findMany({
      where: { surveyId: survey.id, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: batchSize,
      select: {
        id: true,
        userId: true,
        segmentId: true,
        segmentSubtype: true,
        locale: true,
        user: { select: { telegramChatId: true } },
      },
    });
    if (invites.length === 0) return;

    logger.info(
      { slug: activeSlug, batchSize: invites.length, remainingHourlyCap },
      'research-survey: send batch starting',
    );

    for (const invite of invites) {
      if (!invite.user.telegramChatId) {
        // No chat id — can't deliver. Mark FAILED so we don't loop.
        await markFailed(invite.id, 'no_chat_id');
        continue;
      }
      const locale = inviteLocaleAsSurveyLocale(invite.locale);
      if (!locale) {
        await markFailed(invite.id, 'unsupported_locale');
        continue;
      }
      const outcome = await sendSurveyInviteDM({
        chatId: invite.user.telegramChatId,
        inviteId: invite.id,
        locale,
      });
      await applyOutcome({
        inviteId: invite.id,
        userId: invite.userId,
        surveyId: survey.id,
        surveySlug: survey.slug,
        segmentId: invite.segmentId,
        segmentSubtype: invite.segmentSubtype,
        locale,
        outcome,
      });
      await sleep(SEND_INTERVAL_MS);
    }
  }

  setInterval(() => {
    tick().catch((err) => logger.error({ err }, 'research-survey: tick failed'));
  }, TICK_INTERVAL_MS);
  setTimeout(() => {
    tick().catch((err) => logger.error({ err }, 'research-survey: startup tick failed'));
  }, STARTUP_DELAY_MS);
}

function isEnabled(): boolean {
  return (process.env.RESEARCH_SURVEY_SEND_ENABLED ?? 'false').toLowerCase() === 'true';
}

function isWithinWindow(now: Date): boolean {
  // Intl returns the local hour for the named tz; safer than manual offset math
  // (handles DST transitions correctly even if Russia ever resumes DST).
  const formatter = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    hour12: false,
    timeZone: TZ_NAME,
  });
  const hourStr = formatter.format(now);
  const hour = Number.parseInt(hourStr, 10);
  if (Number.isNaN(hour)) return false;
  return hour >= WINDOW_START_HOUR && hour < WINDOW_END_HOUR;
}

async function getRemainingHourlyCap(): Promise<number> {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const sentInLastHour = await prisma.researchSurveyInvite.count({
    where: { sentAt: { gte: since } },
  });
  return Math.max(0, HOURLY_CAP - sentInLastHour);
}

async function markFailed(inviteId: string, reason: string): Promise<void> {
  await prisma.researchSurveyInvite.updateMany({
    where: { id: inviteId, status: 'PENDING' },
    data: { status: 'FAILED', failedAt: new Date(), failureReason: reason },
  });
}

async function applyOutcome(args: {
  inviteId: string;
  userId: string;
  surveyId: string;
  surveySlug: string;
  segmentId: string;
  segmentSubtype: string | null;
  locale: SurveyLocale;
  outcome: SurveyDmOutcome;
}): Promise<void> {
  const props = {
    surveyId: args.surveyId,
    inviteId: args.inviteId,
    surveySlug: args.surveySlug,
    segmentId: args.segmentId,
    segmentSubtype: args.segmentSubtype,
    locale: args.locale,
  };

  switch (args.outcome) {
    case 'delivered':
      await prisma.researchSurveyInvite.updateMany({
        where: { id: args.inviteId, status: 'PENDING' },
        data: { status: 'SENT', sentAt: new Date() },
      });
      trackProductEvent({ event: 'survey.invite_sent', userId: args.userId, props });
      return;

    case 'bot_blocked':
      await prisma.$transaction([
        prisma.researchSurveyInvite.updateMany({
          where: { id: args.inviteId, status: 'PENDING' },
          data: { status: 'FAILED', failedAt: new Date(), failureReason: 'bot_blocked' },
        }),
        prisma.userProfile.upsert({
          where: { userId: args.userId },
          update: { notifyMarketing: false },
          create: { userId: args.userId, notifyMarketing: false },
        }),
      ]);
      trackProductEvent({
        event: 'survey.invite_failed',
        userId: args.userId,
        props: { ...props, reason: 'bot_blocked' },
      });
      return;

    case 'chat_not_found':
    case 'permanent_failure':
      await markFailed(
        args.inviteId,
        args.outcome === 'chat_not_found' ? 'chat_not_found' : 'telegram_4xx',
      );
      trackProductEvent({
        event: 'survey.invite_failed',
        userId: args.userId,
        props: { ...props, reason: args.outcome },
      });
      return;

    case 'transient_failure':
      // Leave PENDING for the next tick.
      return;
  }
}

function inviteLocaleAsSurveyLocale(locale: string): SurveyLocale | null {
  if (locale === 'ru' || locale === 'en') return locale;
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
