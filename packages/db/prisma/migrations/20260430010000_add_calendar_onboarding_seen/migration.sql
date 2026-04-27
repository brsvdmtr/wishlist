-- Server-side flag: did this user dismiss/finish the calendar onboarding?
-- Replaces a localStorage flag that made every fresh device repeat the flow.
ALTER TABLE "User" ADD COLUMN "calendarOnboardingSeenAt" TIMESTAMP(3);
