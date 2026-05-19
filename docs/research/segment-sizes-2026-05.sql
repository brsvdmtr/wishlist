-- Segment-sizing run for docs/research/segment-sizes-2026-05.md
-- Convention: AnalyticsEvent.userId is mixed (cuid OR telegram_id-as-string).
-- We map back to canonical User via OR-join, then filter godMode = false everywhere.

\echo '--- Baseline'
SELECT
  COUNT(*) AS total_users,
  COUNT(*) FILTER (WHERE "godMode" = false AND "telegramId" IS NOT NULL) AS recruitable_pool
FROM "User";

\echo ''
\echo '--- S1 Activated owners (real, non-demo, non-deleted item)'
SELECT COUNT(DISTINCT w."ownerId") AS s1_activated_owners
FROM "Item" i
JOIN "Wishlist" w ON w.id = i."wishlistId"
JOIN "User" u ON u.id = w."ownerId"
WHERE i."isDemo" = false
  AND i."status" <> 'DELETED'
  AND w."type" = 'REGULAR'
  AND w."archivedAt" IS NULL
  AND u."godMode" = false;

\echo ''
\echo '--- S2 Created wishlist, did not share (no shareToken on any regular wishlist)'
SELECT COUNT(*) AS s2_unshared
FROM "User" u
WHERE u."godMode" = false
  AND EXISTS (
    SELECT 1 FROM "Wishlist" w
    WHERE w."ownerId" = u.id
      AND w."type" = 'REGULAR'
      AND w."archivedAt" IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM "Wishlist" w
    WHERE w."ownerId" = u.id
      AND w."type" = 'REGULAR'
      AND w."shareToken" IS NOT NULL
  );

\echo ''
\echo '--- S3 Shared wishlist (canonical=A:got-token, B:link-opened, C:event-log)'
SELECT
  (SELECT COUNT(DISTINCT w."ownerId")
   FROM "Wishlist" w
   JOIN "User" u ON u.id = w."ownerId"
   WHERE w."shareToken" IS NOT NULL
     AND w."type" = 'REGULAR'
     AND u."godMode" = false) AS s3a_got_token,
  (SELECT COUNT(DISTINCT w."ownerId")
   FROM "Wishlist" w
   JOIN "User" u ON u.id = w."ownerId"
   WHERE w."shareOpenCount" > 0
     AND w."type" = 'REGULAR'
     AND u."godMode" = false) AS s3b_link_actually_opened,
  (SELECT COUNT(DISTINCT u.id)
   FROM "AnalyticsEvent" ae
   JOIN "User" u ON (u.id = ae."userId" OR u."telegramId" = ae."userId")
   WHERE ae.event IN ('share.token_generated', 'share_token_generated')
     AND ae."userId" IS NOT NULL
     AND u."godMode" = false) AS s3c_clicked_share;

\echo ''
\echo '--- S4 Guests who opened a foreign wishlist'
SELECT
  (SELECT COUNT(DISTINCT fwa."userId")
   FROM "ForeignWishlistAccess" fwa
   JOIN "User" u ON u.id = fwa."userId"
   WHERE u."godMode" = false) AS s4_any_foreign_open,
  (SELECT COUNT(DISTINCT fwa."userId")
   FROM "ForeignWishlistAccess" fwa
   JOIN "User" u ON u.id = fwa."userId"
   WHERE fwa.source = 'share_link'
     AND u."godMode" = false) AS s4_via_share_link_only;

\echo ''
\echo '--- S5 Guests who reserved (known TG user)'
SELECT
  (SELECT COUNT(DISTINCT rm."reserverUserId")
   FROM "ReservationMeta" rm
   JOIN "Item" i ON i.id = rm."itemId"
   JOIN "Wishlist" w ON w.id = i."wishlistId"
   JOIN "User" u ON u.id = rm."reserverUserId"
   WHERE w."ownerId" <> rm."reserverUserId"
     AND u."godMode" = false) AS s5_known_reservers,
  (SELECT COUNT(DISTINCT rm."reserverUserId")
   FROM "ReservationMeta" rm
   JOIN "Item" i ON i.id = rm."itemId"
   JOIN "Wishlist" w ON w.id = i."wishlistId"
   JOIN "User" u ON u.id = rm."reserverUserId"
   WHERE w."ownerId" <> rm."reserverUserId"
     AND rm."active" = true
     AND u."godMode" = false) AS s5_known_active_reservers,
  (SELECT COUNT(DISTINCT u.id)
   FROM "AnalyticsEvent" ae
   JOIN "User" u ON (u.id = ae."userId" OR u."telegramId" = ae."userId")
   WHERE ae.event = 'reservation.succeeded'
     AND ae."userId" IS NOT NULL
     AND u."godMode" = false) AS s5_via_event_log;

\echo ''
\echo '--- S6 Paywall viewed (union of 7 paywall event names)'
SELECT COUNT(DISTINCT u.id) AS s6_paywall_viewed
FROM "AnalyticsEvent" ae
JOIN "User" u ON (u.id = ae."userId" OR u."telegramId" = ae."userId")
WHERE ae."userId" IS NOT NULL
  AND u."godMode" = false
  AND (
    ae.event LIKE 'feature_gate_hit_%'
    OR ae.event IN (
      'showcase.paywall_viewed','search.paywall_shown',
      'secret_res.paywall_open','birthday.paywall_shown',
      'pro_cta_clicked','event_reminder_deeplink_paywall'
    )
  );

\echo ''
\echo '--- S6b Paywall viewed but NOT paid'
WITH paywall_users AS (
  SELECT DISTINCT u.id AS user_id
  FROM "AnalyticsEvent" ae
  JOIN "User" u ON (u.id = ae."userId" OR u."telegramId" = ae."userId")
  WHERE ae."userId" IS NOT NULL
    AND u."godMode" = false
    AND (
      ae.event LIKE 'feature_gate_hit_%'
      OR ae.event IN (
        'showcase.paywall_viewed','search.paywall_shown',
        'secret_res.paywall_open','birthday.paywall_shown',
        'pro_cta_clicked','event_reminder_deeplink_paywall'
      )
    )
),
paid_users AS (
  SELECT DISTINCT "userId" AS user_id
  FROM "PaymentEvent"
  WHERE "eventType" IN (
    'payment_success','payment_success_yearly','payment_success_lifetime',
    'addon_payment_success'
  )
)
SELECT
  (SELECT COUNT(*) FROM paywall_users) AS s6_total,
  (SELECT COUNT(*) FROM paywall_users pw WHERE pw.user_id NOT IN (SELECT user_id FROM paid_users)) AS s6_unpaid;

\echo ''
\echo '--- S7 Paid users (PRO or add-on, ever)'
SELECT
  (SELECT COUNT(DISTINCT pe."userId")
   FROM "PaymentEvent" pe
   JOIN "User" u ON u.id = pe."userId"
   WHERE pe."eventType" IN (
     'payment_success','payment_success_yearly','payment_success_lifetime',
     'addon_payment_success'
   ) AND u."godMode" = false) AS s7_ever_paid,
  (SELECT COUNT(DISTINCT pe."userId")
   FROM "PaymentEvent" pe
   JOIN "User" u ON u.id = pe."userId"
   WHERE pe."eventType" IN (
     'payment_success','payment_success_yearly','payment_success_lifetime'
   ) AND u."godMode" = false) AS s7_paid_pro_ever,
  (SELECT COUNT(DISTINCT s."userId")
   FROM "Subscription" s
   JOIN "User" u ON u.id = s."userId"
   WHERE s."planCode" = 'PRO'
     AND s."status" = 'ACTIVE'
     AND (s."currentPeriodEnd" > NOW() OR s."billingPeriod" = 'lifetime')
     AND u."godMode" = false) AS s7_active_pro_now;

\echo ''
\echo '--- S8 Churned / inactive (registered 14+ d ago, no Mini-App touch in 14 d)'
SELECT
  (SELECT COUNT(*)
   FROM "User" u
   WHERE u."godMode" = false
     AND u."telegramId" IS NOT NULL
     AND u."createdAt" < NOW() - INTERVAL '14 days'
     AND u."updatedAt" < NOW() - INTERVAL '14 days') AS s8_inactive_14d,
  (SELECT COUNT(*)
   FROM "User" u
   WHERE u."godMode" = false
     AND u."telegramId" IS NOT NULL
     AND u."createdAt" < NOW() - INTERVAL '14 days'
     AND u."updatedAt" < NOW() - INTERVAL '30 days') AS s8_inactive_30d,
  (SELECT COUNT(*)
   FROM "User" u
   WHERE u."godMode" = false
     AND u."telegramId" IS NOT NULL
     AND u."createdAt" < NOW() - INTERVAL '14 days'
     AND u."updatedAt" >= u."createdAt" + INTERVAL '7 days') AS s8_was_active_first_week_at_least;

\echo ''
\echo '--- S9 Santa users (organizer or participant)'
SELECT
  (SELECT COUNT(DISTINCT t.user_id) FROM (
     SELECT sc."ownerId" AS user_id FROM "SantaCampaign" sc
       JOIN "User" u ON u.id = sc."ownerId"
       WHERE sc.status <> 'CANCELLED' AND u."godMode" = false
     UNION
     SELECT sp."userId" AS user_id FROM "SantaParticipant" sp
       JOIN "User" u ON u.id = sp."userId"
       WHERE sp.status = 'JOINED' AND u."godMode" = false
   ) t) AS s9_any_santa,
  (SELECT COUNT(DISTINCT sc."ownerId")
   FROM "SantaCampaign" sc
   JOIN "User" u ON u.id = sc."ownerId"
   WHERE sc.status IN ('OPEN','LOCKED','ACTIVE','COMPLETED')
     AND u."godMode" = false) AS s9_organizers_active,
  (SELECT COUNT(DISTINCT sp."userId")
   FROM "SantaParticipant" sp
   JOIN "SantaCampaign" sc ON sc.id = sp."campaignId"
   JOIN "User" u ON u.id = sp."userId"
   WHERE sp.status = 'JOINED'
     AND sc."ownerId" <> sp."userId"
     AND u."godMode" = false) AS s9_pure_participants;

\echo ''
\echo '--- S10 Group Gift users'
SELECT
  (SELECT COUNT(DISTINCT t.user_id) FROM (
     SELECT gg."organizerUserId" AS user_id FROM "GroupGift" gg
       JOIN "User" u ON u.id = gg."organizerUserId"
       WHERE gg.status <> 'CANCELLED' AND u."godMode" = false
     UNION
     SELECT gp."userId" AS user_id FROM "GroupGiftParticipant" gp
       JOIN "User" u ON u.id = gp."userId"
       WHERE u."godMode" = false
   ) t) AS s10_any_group_gift,
  (SELECT COUNT(DISTINCT gg."organizerUserId")
   FROM "GroupGift" gg
   JOIN "User" u ON u.id = gg."organizerUserId"
   WHERE gg.status <> 'CANCELLED' AND u."godMode" = false) AS s10_organizers,
  (SELECT COUNT(DISTINCT gp."userId")
   FROM "GroupGiftParticipant" gp
   JOIN "User" u ON u.id = gp."userId"
   WHERE u."godMode" = false) AS s10_participants;

\echo ''
\echo '--- S11 URL Import users'
SELECT
  (SELECT COUNT(DISTINCT w."ownerId")
   FROM "Item" i
   JOIN "Wishlist" w ON w.id = i."wishlistId"
   JOIN "User" u ON u.id = w."ownerId"
   WHERE i."originType" = 'IMPORTED'
     AND i."status" <> 'DELETED'
     AND u."godMode" = false) AS s11_has_imported_item,
  (SELECT COUNT(DISTINCT u.id)
   FROM "AnalyticsEvent" ae
   JOIN "User" u ON (u.id = ae."userId" OR u."telegramId" = ae."userId")
   WHERE ae.event IN ('import.started','import.bot_started')
     AND ae."userId" IS NOT NULL
     AND u."godMode" = false) AS s11_tried_import,
  (SELECT COUNT(DISTINCT u.id)
   FROM "AnalyticsEvent" ae
   JOIN "User" u ON (u.id = ae."userId" OR u."telegramId" = ae."userId")
   WHERE ae.event IN ('import.succeeded','import.bot_succeeded')
     AND ae."userId" IS NOT NULL
     AND u."godMode" = false) AS s11_succeeded_import;

\echo ''
\echo '--- S12 Limit-hit users (feature_gate_hit_*)'
SELECT
  (SELECT COUNT(DISTINCT u.id)
   FROM "AnalyticsEvent" ae
   JOIN "User" u ON (u.id = ae."userId" OR u."telegramId" = ae."userId")
   WHERE ae.event LIKE 'feature_gate_hit_%'
     AND ae."userId" IS NOT NULL
     AND u."godMode" = false) AS s12_any_limit_hit;

\echo ''
\echo '--- S12 Limit-hit breakdown by feature'
SELECT ae.event, COUNT(DISTINCT u.id) AS distinct_users
FROM "AnalyticsEvent" ae
JOIN "User" u ON (u.id = ae."userId" OR u."telegramId" = ae."userId")
WHERE ae.event LIKE 'feature_gate_hit_%'
  AND ae."userId" IS NOT NULL
  AND u."godMode" = false
GROUP BY ae.event
ORDER BY distinct_users DESC;
