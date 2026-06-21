ALTER TABLE "Mpesa"
    ADD COLUMN "checkoutRequestId" TEXT,
    ADD COLUMN "merchantRequestId" TEXT,
    ADD COLUMN "resultCode" TEXT,
    ADD COLUMN "resultDescription" TEXT,
    ADD COLUMN "mpesaReceiptNumber" TEXT,
    ADD COLUMN "transactionDate" TIMESTAMP(3),
    ADD COLUMN "reconciliationAttempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "lastReconciliationAt" TIMESTAMP(3),
    ADD COLUMN "nextReconciliationAt" TIMESTAMP(3),
    ADD COLUMN "lastReconciliationError" TEXT,
    ADD COLUMN "reconciliationLeaseUntil" TIMESTAMP(3);

UPDATE "Mpesa"
SET "checkoutRequestId" = "reqcode"
WHERE "reqcode" LIKE 'ws\_CO\_%' ESCAPE '\'
  AND "checkoutRequestId" IS NULL;

CREATE UNIQUE INDEX "Mpesa_checkoutRequestId_key" ON "Mpesa"("checkoutRequestId");
CREATE UNIQUE INDEX "Mpesa_mpesaReceiptNumber_key" ON "Mpesa"("mpesaReceiptNumber");
CREATE INDEX "Mpesa_status_nextReconciliationAt_idx"
    ON "Mpesa"("status", "nextReconciliationAt");
