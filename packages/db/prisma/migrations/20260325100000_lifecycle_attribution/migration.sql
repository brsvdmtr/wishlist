-- Attribution fields for LifecycleTouch
ALTER TABLE "LifecycleTouch" ADD COLUMN "returnedAt" TIMESTAMP(3);
ALTER TABLE "LifecycleTouch" ADD COLUMN "targetCompletedAt" TIMESTAMP(3);
ALTER TABLE "LifecycleTouch" ADD COLUMN "targetCompletedType" TEXT;
ALTER TABLE "LifecycleTouch" ADD COLUMN "promoRedeemedAt" TIMESTAMP(3);
CREATE INDEX "LifecycleTouch_sentAt_idx" ON "LifecycleTouch"("sentAt");
