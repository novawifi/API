ALTER TABLE "Platform" ADD COLUMN IF NOT EXISTS "subscriptionPlan" TEXT NOT NULL DEFAULT 'basic';
ALTER TABLE "Platform" ADD COLUMN IF NOT EXISTS "trialEndsAt" TIMESTAMP(3);
ALTER TABLE "Platform" ADD COLUMN IF NOT EXISTS "lastPaymentAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "PlatformNotification" (
  "id" TEXT NOT NULL,
  "platformID" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'info',
  "actionLabel" TEXT,
  "actionUrl" TEXT,
  "dismissedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformNotification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PlatformNotification_platformID_idx" ON "PlatformNotification"("platformID");
CREATE INDEX IF NOT EXISTS "PlatformNotification_status_idx" ON "PlatformNotification"("status");
CREATE INDEX IF NOT EXISTS "PlatformNotification_dismissedAt_idx" ON "PlatformNotification"("dismissedAt");

UPDATE "Platform"
SET "trialEndsAt" = COALESCE("trialEndsAt", "createdAt" + INTERVAL '3 days')
WHERE lower(COALESCE("subscriptionPlan", 'basic')) IN ('basic', 'starter', 'stater');
