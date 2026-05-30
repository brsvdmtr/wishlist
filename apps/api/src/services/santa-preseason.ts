// E23 — Santa pre-season teaser DM service.
//
// One DM near Nov 1 to a SEGMENTED audience (past-Santa users, active owners,
// social-active users), priming them to create a Secret Santa campaign once
// the season opens (Nov 15). The DM is gated behind the `santa-preseason-dm`
// A/B experiment: TREATMENT users receive it, CONTROL users are tracked but
// not messaged, so the season's `santa.campaign_created` lift is measurable
// (success = +30% vs control).
//
// Why a phased wave instead of a single blast: requirement #4 is a
// ">15%-mute kill-switch". Mutes arrive asynchronously, minutes-to-hours after
// a send, so a single fast blast would finish before any mute signal landed —
// the kill-switch would be decorative. Instead the wave paces sends over the
// Nov 1–14 window: a small CANARY_CAP on the first sending day, then DAILY_CAP
// per day, with a SETTLE_HOURS grace before a sent user counts toward the mute
// rate. That guarantees the kill-switch sees real, settled mute data before the
// bulk goes out. Each user still receives exactly ONE DM (the
// SantaPreseasonTouch @@unique([userId, seasonYear]) is the dedup guard).
//
// No deps threaded through index.ts — this module reads BOT_TOKEN at call time
// and imports prisma/logger/analytics directly, mirroring santa-season.ts. The
// supersede dispatch lives in santa-season.ts::maybeRunSeasonalEvents (the
// hourly tick already calls it); this module is pure logic + DB.
//
// IMPORTANT: this module must NOT import from ./santa-season (which imports
// this module for the supersede branch). The caller computes `seasonYear`
// (getSeasonStartYear) and passes it in, keeping the two modules acyclic.

import { prisma, Prisma } from '@wishlist/db';
import { t, resolveLocaleWithSource, type Locale } from '@wishlist/shared';
import { profileToLanguageSettings } from './locale';
import {
  getExperimentAssignment,
  type ExperimentConfig,
} from './experiments.service';
import { trackProductEvent } from './analytics';
import type { SendDmOutcome } from './lifecycle';
import { buildSantaPreseasonDeepLink } from '../telegram/deepLinks';
import { sendAdminAlert } from '../notifications/adminAlerts';
import logger from '../logger';

export const PRESEASON_EXPERIMENT_KEY = 'santa-preseason-dm';

// ─── Tuning constants ────────────────────────────────────────────────────────
const WAVE_SIZE = 200;            // candidates processed per hourly tick
const CANARY_CAP = 500;           // max sends on the first sending UTC day
const DAILY_CAP = 2000;           // max sends per UTC day thereafter
const MIN_SAMPLE = 200;           // min settled sends before the kill-switch can trip
const SETTLE_HOURS = 6;           // grace period before a sent user counts toward mute rate
const MUTE_THRESHOLD = 0.15;      // >15% settled-cohort mute rate → stop the wave
const ACTIVE_OWNER_WINDOW_DAYS = 90;
const THROTTLE_EVERY = 25;        // pause every N delivered sends (Telegram flood control)
const THROTTLE_MS = 1000;

export type PreseasonSegment = 'past_santa' | 'social' | 'active_owner';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** Start of the UTC calendar day containing `now`. */
function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Is `now` inside the pre-season teaser window — Nov 1–14 UTC inclusive? The
 * season opens Nov 15 (getSeasonCalendar), so the teaser only goes out before
 * then. Independent of `isSeasonalEventTriggerDay` (which fires only on Nov 1),
 * so the wave can advance across every day of the window. Pure (no DB).
 */
export function isPreseasonWindow(now: Date): boolean {
  return now.getUTCMonth() === 10 && now.getUTCDate() >= 1 && now.getUTCDate() <= 14;
}

// Existence-probe select shape — lets us label the primary segment from the
// same query that fetched the candidate, with zero extra round-trips.
const SEGMENT_COUNT_SELECT = {
  santaParticipations: true,
  ownedSantaCampaigns: true,
  wishlistSubscriptions: true,
  profileSubscriptions: true,
  groupGiftParticipations: true,
  groupGiftsOrganized: true,
} as const;

type SegmentCounts = Record<keyof typeof SEGMENT_COUNT_SELECT, number>;

/** Primary segment by precedence: past_santa > social > active_owner. A user
 *  who matched the audience OR but has no santa/social counts reached it via
 *  the active-owner branch (by elimination). */
export function primarySegment(c: SegmentCounts): PreseasonSegment {
  if (c.santaParticipations > 0 || c.ownedSantaCampaigns > 0) return 'past_santa';
  if (
    c.wishlistSubscriptions > 0 ||
    c.profileSubscriptions > 0 ||
    c.groupGiftParticipations > 0 ||
    c.groupGiftsOrganized > 0
  ) {
    return 'social';
  }
  return 'active_owner';
}

/**
 * The eligibility filter shared by the live wave and the dry-run. Three
 * segments OR'd together, minus marketing opt-outs, minus anyone already
 * touched this season.
 *
 * Opt-out uses the NULL-SAFE `NOT: { profile: { is: { notifyMarketing: false } } }`
 * form, NOT `profile: { is: { notifyMarketing: true } }` — the latter would
 * silently drop every user whose UserProfile row doesn't exist yet (their
 * marketing default is "on"). Marketing opt-out is PRO-only, so the only users
 * this excludes are PRO users who explicitly turned it off.
 */
function buildAudienceWhere(now: Date, seasonYear: number): Prisma.UserWhereInput {
  const activeCutoff = new Date(now.getTime() - ACTIVE_OWNER_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return {
    telegramChatId: { not: null },
    NOT: { profile: { is: { notifyMarketing: false } } },
    santaPreseasonTouches: { none: { seasonYear } },
    OR: [
      // past Santa users
      { santaParticipations: { some: {} } },
      { ownedSantaCampaigns: { some: {} } },
      // active owners — a live REGULAR wishlist with ≥1 actionable item, seen recently
      {
        AND: [
          { updatedAt: { gte: activeCutoff } },
          {
            wishlists: {
              some: {
                type: 'REGULAR',
                archivedAt: null,
                items: { some: { status: { in: ['AVAILABLE', 'RESERVED'] } } },
              },
            },
          },
        ],
      },
      // group / social activity
      { wishlistSubscriptions: { some: {} } },
      { profileSubscriptions: { some: {} } },
      { groupGiftParticipations: { some: {} } },
      { groupGiftsOrganized: { some: {} } },
    ],
  };
}

/**
 * Dry-run recipients list (self-check #5). Computes the eligible audience
 * WITHOUT sending: the total, the per-primary-segment breakdown, and a sample.
 * Used by scripts/santa-preseason-dryrun.ts so the operator can preview who
 * would get the DM before flipping the flag.
 */
export async function computePreseasonAudience(opts: {
  seasonYear: number;
  now?: Date;
  sampleSize?: number;
}): Promise<{
  seasonYear: number;
  total: number;
  bySegment: Record<PreseasonSegment, number>;
  sample: Array<{ userId: string; segment: PreseasonSegment }>;
}> {
  const now = opts.now ?? new Date();
  const sampleSize = opts.sampleSize ?? 25;
  const where = buildAudienceWhere(now, opts.seasonYear);

  const rows = await prisma.user.findMany({
    where,
    select: { id: true, _count: { select: SEGMENT_COUNT_SELECT } },
    orderBy: { id: 'asc' },
  });

  const bySegment: Record<PreseasonSegment, number> = { past_santa: 0, social: 0, active_owner: 0 };
  const sample: Array<{ userId: string; segment: PreseasonSegment }> = [];
  for (const r of rows) {
    const seg = primarySegment(r._count);
    bySegment[seg] += 1;
    if (sample.length < sampleSize) sample.push({ userId: r.id, segment: seg });
  }

  return { seasonYear: opts.seasonYear, total: rows.length, bySegment, sample };
}

/**
 * Send the teaser DM with a 2-button keyboard (web_app CTA + `sps:<touchId>`
 * mute callback) and classify the outcome. Mirrors the Telegram error → outcome
 * mapping in services/lifecycle.ts::createSendLifecycleDM (kept inline because
 * that sender hardcodes a single web_app button and can't express the mute
 * row). Reads BOT_TOKEN at call time like telegram/botApi.ts.
 */
async function sendPreseasonDm(
  chatId: string,
  locale: Locale,
  seasonYear: number,
  touchId: string,
): Promise<SendDmOutcome> {
  const token = process.env.BOT_TOKEN;
  if (!token || !chatId) return 'permanent_failure';
  const chatIdTail = String(chatId).slice(-4);

  const replyMarkup = {
    inline_keyboard: [
      [{ text: t('santa_preseason_cta_btn', locale), web_app: { url: buildSantaPreseasonDeepLink(seasonYear) } }],
      [{ text: t('santa_preseason_mute_btn', locale), callback_data: `sps:${touchId}` }],
    ],
  };
  const body = JSON.stringify({
    chat_id: chatId,
    text: t('santa_preseason_teaser_msg', locale),
    parse_mode: 'HTML',
    reply_markup: replyMarkup,
  });

  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const data = (await r.json()) as { ok: boolean; error_code?: number; description?: string };
    if (data.ok) return 'delivered';

    const code = data.error_code ?? r.status;
    const desc = (data.description ?? '').toLowerCase();
    let outcome: SendDmOutcome;
    if (code === 403) outcome = 'bot_blocked';
    else if (code === 400 && (desc.includes('chat not found') || desc.includes('user is deactivated'))) outcome = 'chat_not_found';
    else if (code === 429 || code >= 500) outcome = 'transient_failure';
    else outcome = 'permanent_failure';

    logger.warn(
      { chatIdTail, errorCode: code, description: data.description, outcome },
      'santa-preseason DM rejected by Telegram',
    );
    return outcome;
  } catch (err) {
    logger.warn(
      { chatIdTail, err: err instanceof Error ? err.message : String(err) },
      'santa-preseason DM fetch error (transient)',
    );
    return 'transient_failure';
  }
}

/** stopReason value for a permanent (non-retryable) send failure. */
function failureStopReason(outcome: SendDmOutcome): string {
  if (outcome === 'bot_blocked') return 'bot_blocked';
  if (outcome === 'chat_not_found') return 'chat_not_found';
  return 'delivery_failed';
}

/**
 * Advance the phased pre-season broadcast by one hourly tick.
 *
 * Called from santa-season.ts::maybeRunSeasonalEvents on every tick inside the
 * Nov 1–14 window when the experiment is enabled. Idempotent + crash-safe: the
 * SantaPreseasonBroadcast row latches `running` → `completed`/`stopped`, and
 * per-user dedup is the SantaPreseasonTouch unique constraint.
 *
 * `config` is a single snapshot from the caller's enable-check, threaded
 * through so every user in the tick reads the same rollout (never re-reads env
 * per user).
 */
export async function runPreseasonWave(opts: {
  now: Date;
  seasonYear: number;
  config: ExperimentConfig;
}): Promise<void> {
  const { now, seasonYear, config } = opts;
  try {
    const broadcast = await prisma.santaPreseasonBroadcast.upsert({
      where: { seasonYear },
      create: { seasonYear, status: 'running' },
      update: {},
    });
    if (broadcast.status !== 'running') return; // already completed or stopped

    // ── Kill-switch: settled-cohort mute rate ──
    // Denominator = DELIVERED treatment DMs sent ≥ SETTLE_HOURS ago (the user
    // had a fair chance to mute). Numerator = those that were muted. Counting
    // `delivered=true` (not just `sentAt`) keeps blocked-bot users from skewing
    // the rate. Computed from the touch table → race-free across API + bot.
    const settleCutoff = new Date(now.getTime() - SETTLE_HOURS * 60 * 60 * 1000);
    const settledBase: Prisma.SantaPreseasonTouchWhereInput = {
      seasonYear,
      variant: 'treatment',
      delivered: true,
      sentAt: { lt: settleCutoff },
    };
    const settledSent = await prisma.santaPreseasonTouch.count({ where: settledBase });
    if (settledSent >= MIN_SAMPLE) {
      const settledMuted = await prisma.santaPreseasonTouch.count({
        where: { ...settledBase, mutedAt: { not: null } },
      });
      const rate = settledMuted / settledSent;
      if (rate > MUTE_THRESHOLD) {
        await prisma.santaPreseasonBroadcast.update({
          where: { seasonYear },
          data: { status: 'stopped', stopReason: `mute_rate_${rate.toFixed(3)}`, completedAt: now },
        });
        logger.warn({ seasonYear, settledSent, settledMuted, rate }, 'santa-preseason: kill-switch tripped, wave stopped');
        void sendAdminAlert(
          `🛑 Santa pre-season DM (season ${seasonYear}) STOPPED — mute rate ${(rate * 100).toFixed(1)}% (${settledMuted}/${settledSent}) crossed the ${(MUTE_THRESHOLD * 100).toFixed(0)}% kill-switch.`,
        );
        return;
      }
    }

    // ── Daily cap: first sending day is a canary, then DAILY_CAP/day ──
    const startOfToday = startOfUtcDay(now);
    const priorDaySends = await prisma.santaPreseasonTouch.count({
      where: { seasonYear, variant: 'treatment', sentAt: { not: null, lt: startOfToday } },
    });
    const dayCap = priorDaySends === 0 ? CANARY_CAP : DAILY_CAP;
    const sentToday = await prisma.santaPreseasonTouch.count({
      where: { seasonYear, variant: 'treatment', sentAt: { gte: startOfToday } },
    });
    const budget = dayCap - sentToday;
    if (budget <= 0) return; // daily cap reached — wait for the next UTC day

    // ── Fetch the next slice of eligible users ──
    const candidates = await prisma.user.findMany({
      where: buildAudienceWhere(now, seasonYear),
      select: {
        id: true,
        telegramChatId: true,
        profile: { select: { languageMode: true, manualLanguage: true, normalizedLocale: true, language: true } },
        _count: { select: SEGMENT_COUNT_SELECT },
      },
      take: Math.min(WAVE_SIZE, budget),
      orderBy: { id: 'asc' },
    });

    if (candidates.length === 0) {
      await prisma.santaPreseasonBroadcast.update({
        where: { seasonYear },
        data: { status: 'completed', completedAt: now },
      });
      logger.info({ seasonYear }, 'santa-preseason: audience drained, wave completed');
      return;
    }

    let delivered = 0;
    let controls = 0;
    for (const c of candidates) {
      if (!c.telegramChatId) continue;
      const segment = primarySegment(c._count);
      const assignment = await getExperimentAssignment(c.id, PRESEASON_EXPERIMENT_KEY, config);

      // CONTROL: record a tracking row, never send. The touch existence excludes
      // this user from future ticks (one-per-season), so they stay un-messaged.
      if (assignment.variant === 'control') {
        await prisma.santaPreseasonTouch
          .create({ data: { userId: c.id, seasonYear, variant: 'control', segment, scheduledFor: now, stopReason: 'control' } })
          .catch((e) => { if (!isUniqueViolation(e)) throw e; });
        controls += 1;
        continue;
      }

      // TREATMENT: create the touch first (sentAt null), then send.
      let touchId: string;
      try {
        const touch = await prisma.santaPreseasonTouch.create({
          data: { userId: c.id, seasonYear, variant: 'treatment', segment, scheduledFor: now },
          select: { id: true },
        });
        touchId = touch.id;
      } catch (e) {
        if (isUniqueViolation(e)) continue; // raced with another tick — skip
        throw e;
      }

      const { locale } = resolveLocaleWithSource(profileToLanguageSettings(c.profile));
      const outcome = await sendPreseasonDm(c.telegramChatId, locale, seasonYear, touchId);

      if (outcome === 'transient_failure') {
        // Retryable (429 / 5xx / network). Delete the touch so the audience
        // query re-surfaces this user next tick — the dedup-by-existence rule
        // would otherwise strand them forever with sentAt=null.
        await prisma.santaPreseasonTouch.delete({ where: { id: touchId } }).catch(() => {});
        continue;
      }

      const ok = outcome === 'delivered';
      await prisma.santaPreseasonTouch.update({
        where: { id: touchId },
        data: { sentAt: now, delivered: ok, stopReason: ok ? null : failureStopReason(outcome) },
      });
      if (ok) {
        trackProductEvent({ event: 'santa_preseason.dm_sent', userId: c.id, props: { seasonYear, segment } });
        delivered += 1;
        if (delivered % THROTTLE_EVERY === 0) await sleep(THROTTLE_MS);
      }
    }

    logger.info(
      { seasonYear, processed: candidates.length, delivered, controls, dayCap, sentToday },
      'santa-preseason: wave tick complete',
    );
  } catch (err) {
    logger.error({ err, seasonYear }, 'santa-preseason wave tick failed');
  }
}
