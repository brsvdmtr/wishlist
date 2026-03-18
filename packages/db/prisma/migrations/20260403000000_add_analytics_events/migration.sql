-- CreateTable: lightweight analytics event log for god-mode dashboard
CREATE TABLE "AnalyticsEvent" (
    "id"        TEXT NOT NULL,
    "event"     TEXT NOT NULL,
    "userId"    TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnalyticsEvent_event_createdAt_idx" ON "AnalyticsEvent"("event", "createdAt");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_userId_event_idx" ON "AnalyticsEvent"("userId", "event");
