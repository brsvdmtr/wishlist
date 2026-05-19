# Survey PMF v1 — Operator Runbook

This is the one-page playbook to seed, send, monitor and close a research
survey wave. Survey design + question text live in
[survey-pmf-v1.md](./survey-pmf-v1.md); architecture in
[design v1.2](./04-user-research-plan.md) and CLAUDE.md.

The scheduler is **disabled by default**. Nothing ships to users until ops
flips two env switches in `/opt/wishlist/.env`. None of the operations
below are auto-recoverable — read the whole section before doing each
step.

---

## Pre-flight (one time per wave)

1. **Confirm survey content is frozen.** Diff
   [`SURVEY_PMF_V1`](../../apps/api/src/services/research-survey/survey-pmf-v1.ts)
   vs [survey-pmf-v1.md](./survey-pmf-v1.md). Any optionId mismatch → block.
2. **Confirm `ru` + `en` invite copy** exists in
   [`packages/shared/src/i18n.ts`](../../packages/shared/src/i18n.ts):
   `research_survey_invite_message` + `research_survey_invite_btn`.
3. **Confirm scheduler is registered + disabled.** On prod:
   ```bash
   ssh vultr 'docker exec wishlist-prod-api-1 sh -c "echo SEND_ENABLED=$RESEARCH_SURVEY_SEND_ENABLED ACTIVE_SLUG=$RESEARCH_SURVEY_ACTIVE_SLUG"'
   ```
   Expected: `SEND_ENABLED=` (or `false`) and `ACTIVE_SLUG=` (empty).

---

## Step 1 — Create the survey row

The `ResearchSurvey` row must exist before any invite can be created. The
scheduler refuses to send for slugs that don't have an `ACTIVE` row.

```bash
ssh vultr 'docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c "
INSERT INTO \"ResearchSurvey\" (\"id\", \"slug\", \"version\", \"status\", \"openedAt\", \"updatedAt\")
VALUES (concat('"'"'rsv_'"'"', substr(md5(random()::text), 1, 24)), '"'"'pmf-discovery'"'"', 1, '"'"'ACTIVE'"'"', NOW(), NOW())
RETURNING id, slug, version, status;
"'
```

Note the returned `id` — you'll pass it to step 2.

---

## Step 2 — Seed PENDING invites (dry-run, then real)

Seeding lives in
[`selectSurveyRecipients`](../../apps/api/src/services/research-survey/recipients.ts)
+ [`seedInvites`](../../apps/api/src/services/research-survey/index.ts).
There is no admin route yet — for Wave 1 we invoke it via a one-shot script
on prod.

**Dry-run (no writes):**

```bash
ssh vultr 'docker exec wishlist-prod-api-1 node -e "
const { selectSurveyRecipients } = require('"'"'/app/apps/api/dist/services/research-survey/recipients.js'"'"');
selectSurveyRecipients({ surveyId: '"'"'rsv_<paste-id-from-step-1>'"'"', surveySlug: '"'"'pmf-discovery'"'"', s8Cap: 150 }).then(r => {
  console.log('"'"'counts:'"'"', r.countsBySegment);
  console.log('"'"'s8 substrata:'"'"', r.s8CountsBySubtype);
  console.log('"'"'skipped:'"'"', r.skipped);
  console.log('"'"'total invites:'"'"', r.recipients.length);
}).catch(e => { console.error(e); process.exit(1); });
"'
```

Expected output: `counts` broken down by S1/S2/S3/S5/S7/S8, `s8 substrata`
across 5 buckets summing to ≤ 150. If the totals look wrong — stop, review
segment definitions in `recipients.ts` — do NOT proceed.

**Real seed (writes PENDING rows):**

```bash
ssh vultr 'docker exec wishlist-prod-api-1 node -e "
const { selectSurveyRecipients, seedInvites } = require('"'"'/app/apps/api/dist/services/research-survey/index.js'"'"');
(async () => {
  const SURVEY_ID = '"'"'rsv_<paste-id>'"'"';
  const r = await selectSurveyRecipients({ surveyId: SURVEY_ID, surveySlug: '"'"'pmf-discovery'"'"', s8Cap: 150 });
  const out = await seedInvites({ surveyId: SURVEY_ID, rows: r.recipients });
  console.log('"'"'inserted'"'"', out.inserted, '"'"'skipped'"'"', out.skipped);
})().catch(e => { console.error(e); process.exit(1); });
"'
```

`skipped` should be `0` on first run (no prior invites for this surveyId).

---

## Step 3 — Enable send

Add to `/opt/wishlist/.env`:

```
RESEARCH_SURVEY_ACTIVE_SLUG=pmf-discovery
RESEARCH_SURVEY_SEND_ENABLED=true
```

Then **without restarting** (the scheduler reads env on every tick):

```bash
ssh vultr 'docker exec wishlist-prod-api-1 sh -c "kill -USR1 1 || true"'   # only if api has SIGUSR1 reload; otherwise:
ssh vultr 'docker compose -f /opt/wishlist/docker-compose.yml restart api'
```

Either works — the scheduler picks up `RESEARCH_SURVEY_SEND_ENABLED=true`
within ≤ 60 s of the next tick.

Send pace: 5 msg/sec, 30/tick, 200/h hard cap. Send window: Europe/Moscow
09:00–21:00 — outside that window the tick exits early.

---

## Step 4 — Monitor

```bash
# Hourly send count
ssh vultr 'docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c "
SELECT
  status,
  COUNT(*) AS n,
  COUNT(*) FILTER (WHERE \"sentAt\" >= NOW() - INTERVAL '"'"'1 hour'"'"') AS in_last_hour
FROM \"ResearchSurveyInvite\"
WHERE \"surveyId\" = '"'"'rsv_<id>'"'"'
GROUP BY status
ORDER BY status;
"'

# Bot-block rate (auto-opt-out happened)
ssh vultr 'docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c "
SELECT \"failureReason\", COUNT(*) FROM \"ResearchSurveyInvite\"
WHERE \"surveyId\" = '"'"'rsv_<id>'"'"' AND status = '"'"'FAILED'"'"'
GROUP BY \"failureReason\";
"'

# Funnel — opened / started / completed
ssh vultr 'docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c "
SELECT event, COUNT(*) AS n
FROM \"AnalyticsEvent\"
WHERE event LIKE '"'"'survey.%'"'"'
  AND \"createdAt\" >= NOW() - INTERVAL '"'"'1 day'"'"'
GROUP BY event ORDER BY n DESC;
"'
```

Healthy ranges (Wave 1, ~275 invites):
- `bot_blocked` < 10 % — anything higher = investigate.
- `survey.opened / survey.invite_sent` ≥ 30 %.
- `survey.completed / survey.opened` ≥ 50 %.

Standard prod health checks from CLAUDE.md still apply — run them in
parallel.

---

## Step 5 — Stop sending

When PENDING drains to zero OR when you want to stop early:

```
RESEARCH_SURVEY_SEND_ENABLED=false
```

Restart api. No further invites go out; user-facing screens (`/by-invite`,
`/answer`, `/complete`, `/dismiss`) keep working — closing the send loop is
independent of closing the survey itself.

---

## Step 6 — Close the survey

When response volume plateaus:

```bash
ssh vultr 'docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c "
UPDATE \"ResearchSurvey\" SET status = '"'"'CLOSED'"'"', \"closedAt\" = NOW()
WHERE slug = '"'"'pmf-discovery'"'"' AND version = 1;
"'
```

After close:
- Any user opening the deep link sees the "survey closed" screen.
- `/answer` and `/complete` return 410.
- Existing COMPLETED responses are still readable.

---

## Rollback / emergencies

| Symptom | Action |
|---------|--------|
| Mass bot-block (>10 %) | `RESEARCH_SURVEY_SEND_ENABLED=false`, then `pg` query the FAILED rows by hour to see when the spike started. |
| Wrong copy went out | `RESEARCH_SURVEY_SEND_ENABLED=false`, then UPDATE `research_survey_invite_message` in i18n, redeploy, re-enable. (Sent users already got the wrong copy — no recovery.) |
| Reward grant looks wrong | `RESEARCH_SURVEY_SEND_ENABLED=false`. Pull the 10 most recent COMPLETED responses and audit their `rewardKind` + `Subscription.currentPeriodEnd` deltas. Investigate before re-enabling. |
| Need to re-send a specific user | Delete their `ResearchSurveyInvite` row (also wipes Response + Answers due to CASCADE), then re-run step 2. |

---

## Data exports for analysis

Per-segment, per-question distributions:

```sql
SELECT a."questionId", a."optionId", r."segmentId", r."segmentSubtype", COUNT(*) AS n
FROM "ResearchSurveyAnswer" a
JOIN "ResearchSurveyResponse" r ON r.id = a."responseId"
WHERE r."surveyId" = $1 AND r."completedAt" IS NOT NULL
GROUP BY 1, 2, 3, 4
ORDER BY 1, 2;
```

NPS score per segment:

```sql
SELECT r."segmentId",
       SUM(CASE WHEN a."optionId" IN ('score_9','score_10') THEN 1 ELSE 0 END) AS promoters,
       SUM(CASE WHEN a."optionId" IN ('score_7','score_8') THEN 1 ELSE 0 END) AS passives,
       SUM(CASE WHEN a."optionId" IN ('score_0','score_1','score_2','score_3','score_4','score_5','score_6') THEN 1 ELSE 0 END) AS detractors,
       COUNT(*) AS total
FROM "ResearchSurveyAnswer" a
JOIN "ResearchSurveyResponse" r ON r.id = a."responseId"
WHERE r."surveyId" = $1 AND a."questionId" = 'q9'
GROUP BY 1;
```

Open responses (Q10):

```sql
SELECT r."segmentId", r."locale", a."answerText"
FROM "ResearchSurveyAnswer" a
JOIN "ResearchSurveyResponse" r ON r.id = a."responseId"
WHERE r."surveyId" = $1 AND a."questionId" = 'q10' AND a."answerText" IS NOT NULL
ORDER BY r."segmentId", r."locale";
```
