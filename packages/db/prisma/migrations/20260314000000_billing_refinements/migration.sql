-- AlterTable: Subscription — add source, billingPeriod, cancelAtPeriodEnd
ALTER TABLE "Subscription" ADD COLUMN "source" TEXT DEFAULT 'telegram_stars';
ALTER TABLE "Subscription" ADD COLUMN "billingPeriod" TEXT DEFAULT 'monthly';
ALTER TABLE "Subscription" ADD COLUMN "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: PaymentEvent — add providerPaymentChargeId
ALTER TABLE "PaymentEvent" ADD COLUMN "providerPaymentChargeId" TEXT;
