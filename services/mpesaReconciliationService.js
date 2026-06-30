// @ts-check

/** @typedef {"MPESA_QUERY"|"STARTUP_RECOVERY"|"SCHEDULED_RECOVERY"|"MANUAL_RECONCILIATION"} ReconciliationSource */

const RETRY_DELAYS_MS = [90_000, 120_000, 300_000, 600_000, 1_800_000];

const nairobiTimestamp = (date = new Date()) => {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Africa/Nairobi",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hourCycle: "h23",
    }).formatToParts(date);
    const get = (type) => parts.find((part) => part.type === type)?.value || "";
    return `${get("year")}${get("month")}${get("day")}${get("hour")}${get("minute")}${get("second")}`;
};

const retryAtForAttempt = (attempt, now = new Date()) => {
    const delay = RETRY_DELAYS_MS[Math.min(Math.max(attempt - 1, 0), RETRY_DELAYS_MS.length - 1)] || 3_600_000;
    return new Date(now.getTime() + (attempt > RETRY_DELAYS_MS.length ? 3_600_000 : delay));
};

const isCheckoutRequestId = (value) => /^ws_CO_/i.test(String(value || "").trim());

const isLikelyMpesaReceiptCode = (value) => {
    const text = String(value || "").trim().toUpperCase();
    if (!text || text === "NULL" || text === "UNDEFINED") return false;
    if (isCheckoutRequestId(text) || text.startsWith("NOVA-")) return false;
    return /^[A-Z0-9]{10,12}$/.test(text) && /[A-Z]/.test(text) && /\d/.test(text);
};

class MpesaReconciliationService {
    constructor(controller) {
        this.controller = controller;
        this.db = controller.db;
    }

    getSettings() {
        return {
            batchSize: Math.max(1, Number(process.env.MPESA_RECONCILIATION_BATCH_SIZE || 25)),
            minAgeSeconds: Math.max(120, Number(process.env.MPESA_RECONCILIATION_MIN_AGE_SECONDS || 120)),
            maxAttempts: Math.max(1, Number(process.env.MPESA_RECONCILIATION_MAX_ATTEMPTS || 20)),
            maxAgeHours: Math.max(1, Number(process.env.MPESA_RECONCILIATION_MAX_AGE_HOURS || 24)),
            concurrency: Math.max(1, Math.min(10, Number(process.env.MPESA_RECONCILIATION_CONCURRENCY || 3))),
        };
    }

    async getCredentials(payment) {
        const method = String(payment.paymentMethod || "").toLowerCase();
        if (method === "mpesa c2b" || method === "mpesa b2b") {
            const config = this.controller.getC2BEnvConfig();
            if (!config.shortCode || !config.passKey) throw new Error("Missing M-PESA C2B query shortcode or passkey.");
            return {
                shortCode: String(config.shortCode),
                passKey: String(config.passKey),
                getToken: () => this.controller.getC2BAccessToken(payment.platformID),
            };
        }
        const config = await this.db.getPlatformConfig(payment.platformID);
        if (!config?.mpesaShortCode || !config?.mpesaPassKey) {
            throw new Error("Missing platform M-PESA query shortcode or passkey.");
        }
        return {
            shortCode: String(config.mpesaShortCode),
            passKey: String(config.mpesaPassKey),
            getToken: () => this.controller.getAccessToken(config),
        };
    }

    getQueryUrl() {
        if (this.controller.mpesa.MPESA_STK_QUERY_URL) return this.controller.mpesa.MPESA_STK_QUERY_URL;
        const stkUrl = String(this.controller.mpesa.MPESA_STK_URL || "");
        if (stkUrl.includes("/mpesa/stkpush/v1/processrequest")) {
            return stkUrl.replace("/mpesa/stkpush/v1/processrequest", "/mpesa/stkpushquery/v1/query");
        }
        throw new Error("MPESA_STK_QUERY_URL not set.");
    }

    async queryStkPushStatus(payment) {
        const credentials = await this.getCredentials(payment);
        const timestamp = nairobiTimestamp();
        const password = Buffer.from(`${credentials.shortCode}${credentials.passKey}${timestamp}`).toString("base64");
        const send = async (token) => this.controller.getDarajaAxios().post(
            this.getQueryUrl(),
            {
                BusinessShortCode: credentials.shortCode,
                Password: password,
                Timestamp: timestamp,
                CheckoutRequestID: payment.checkoutRequestId || payment.reqcode,
            },
            {
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                signal: AbortSignal.timeout(Math.max(5_000, Number(process.env.MPESA_HTTP_TIMEOUT_MS || 30_000))),
            }
        );

        let token = await credentials.getToken();
        try {
            return (await send(token))?.data || {};
        } catch (error) {
            if (Number(error?.response?.status) !== 401) throw error;
            token = await credentials.getToken();
            return (await send(token))?.data || {};
        }
    }

    getStoredMpesaReceipt(payment = {}) {
        return [payment.mpesaReceiptNumber, payment.code]
            .map((value) => String(value || "").trim().toUpperCase())
            .find((value) => isLikelyMpesaReceiptCode(value)) || "";
    }

    async completePaymentFromStoredReceipt(payment, receipt, source = "MPESA_RECEIPT_RESOLUTION") {
        if (!payment?.id || !receipt) {
            return { state: "SKIPPED", paymentId: payment?.id, platformID: payment?.platformID, reason: "Missing payment or receipt" };
        }

        if (typeof this.db.claimMpesaForSuccessfulFinalization === "function") {
            const claimed = await this.db.claimMpesaForSuccessfulFinalization(payment.id);
            if (!claimed) {
                return { state: "SKIPPED", paymentId: payment.id, platformID: payment.platformID, receipt, reason: "Payment is already processing or complete" };
            }
        }

        const resultDescription = payment.resultDescription || `Resolved from stored M-PESA receipt (${source})`;
        const completedPayment = {
            ...payment,
            code: receipt,
            mpesaReceiptNumber: receipt,
            status: "COMPLETE",
            resultCode: payment.resultCode || "0",
            resultDescription,
        };

        let fulfillment = null;
        if (typeof this.controller.completePaymentForService === "function") {
            fulfillment = await this.controller.completePaymentForService(completedPayment);
        }

        const fulfillmentStatus = String(fulfillment?.status || "").toUpperCase();
        const fulfillmentNeedsAttention = ["PENDING", "FAILED", "LOCKED"].includes(fulfillmentStatus);

        const updateData = {
            code: receipt,
            mpesaReceiptNumber: receipt,
            status: "COMPLETE",
            resultCode: payment.resultCode || "0",
            resultDescription,
            verified: true,
            lastReconciliationAt: new Date(),
            reconciliationAttempts: { increment: 1 },
            lastReconciliationError: fulfillmentNeedsAttention
                ? `Payment marked COMPLETE from M-PESA receipt, but service fulfillment needs attention: ${fulfillment?.message || fulfillmentStatus || "unknown"}`
                : null,
            nextReconciliationAt: null,
            reconciliationLeaseUntil: null,
        };
        if (!fulfillmentNeedsAttention) {
            updateData.fulfilledAt = new Date();
        }

        await this.db.updateMpesaCodeByID(payment.id, updateData);

        return {
            state: "SUCCESS",
            paymentId: payment.id,
            platformID: payment.platformID,
            receipt,
            resultCode: payment.resultCode || "0",
            resultDescription,
            fulfillmentStatus: fulfillment?.status || "COMPLETE",
            fulfillmentNeedsAttention,
        };
    }

    async reconcileMpesaPayment(paymentOrId, source = "MPESA_QUERY") {
        const payment = typeof paymentOrId === "string"
            ? await this.db.getMpesaByID(paymentOrId)
            : paymentOrId;
        if (!payment) return { state: "SKIPPED", paymentId: String(paymentOrId), reason: "Payment not found" };
        if (!["PENDING", "MANUAL_REVIEW"].includes(String(payment.status).toUpperCase())) {
            return { state: "SKIPPED", paymentId: payment.id, platformID: payment.platformID, reason: `Payment is ${payment.status}` };
        }

        const storedReceipt = this.getStoredMpesaReceipt(payment);
        if (storedReceipt) {
            return this.completePaymentFromStoredReceipt(payment, storedReceipt, source);
        }

        const checkoutRequestId = payment.checkoutRequestId || payment.reqcode;
        if (!checkoutRequestId) return { state: "SKIPPED", paymentId: payment.id, platformID: payment.platformID, reason: "Missing CheckoutRequestID" };

        const settings = this.getSettings();
        const ageMs = Date.now() - new Date(payment.createdAt).getTime();
        const finalAttempt = payment.reconciliationAttempts >= settings.maxAttempts || ageMs >= settings.maxAgeHours * 3_600_000;

        const attempt = Number(payment.reconciliationAttempts || 0) + 1;
        try {
            const response = await this.queryStkPushStatus(payment);
            const rawResultCode = response?.ResultCode ?? response?.resultCode;
            const resultCode = rawResultCode == null ? undefined : String(rawResultCode);
            const resultDescription = String(response?.ResultDesc ?? response?.resultDesc ?? response?.ResponseDescription ?? "");

            if (resultCode === "0") {
                await this.controller.finalizeReconciledStkPayment(payment, response, source);
                await this.db.updateMpesaCodeByID(payment.id, {
                    resultCode,
                    resultDescription,
                    merchantRequestId: response?.MerchantRequestID || payment.merchantRequestId,
                    lastReconciliationAt: new Date(),
                    reconciliationAttempts: { increment: 1 },
                    lastReconciliationError: null,
                    nextReconciliationAt: null,
                    reconciliationLeaseUntil: null,
                });
                return { state: "SUCCESS", paymentId: payment.id, platformID: payment.platformID, checkoutRequestId, resultCode, resultDescription };
            }

            if (resultCode !== undefined) {
                await this.db.recordMpesaReconciliation(payment.id, {
                    status: "FAILED",
                    resultCode,
                    resultDescription,
                    failed_reason: resultDescription,
                    nextReconciliationAt: null,
                    lastReconciliationError: null,
                });
                return { state: "FAILED", paymentId: payment.id, platformID: payment.platformID, checkoutRequestId, resultCode, resultDescription };
            }

            const retryAt = retryAtForAttempt(attempt);
            await this.db.recordMpesaReconciliation(payment.id, {
                resultDescription,
                nextReconciliationAt: retryAt,
                lastReconciliationError: finalAttempt
                    ? `${resultDescription || "Safaricom has not returned a final ResultCode"}; payment remains pending.`
                    : (resultDescription || "Safaricom has not returned a final ResultCode."),
            });
            return { state: "PENDING", paymentId: payment.id, platformID: payment.platformID, checkoutRequestId, resultDescription, retryAt };
        } catch (error) {
            const message = String(error?.response?.data?.errorMessage || error?.message || "M-PESA query failed").slice(0, 500);
            const retryAt = retryAtForAttempt(attempt);
            await this.db.recordMpesaReconciliation(payment.id, {
                nextReconciliationAt: retryAt,
                lastReconciliationError: finalAttempt
                    ? `Safaricom query failed; payment remains pending: ${message}`
                    : message,
            });
            return { state: "PENDING", paymentId: payment.id, platformID: payment.platformID, checkoutRequestId, resultDescription: message, retryAt };
        }
    }

    async reconcilePendingMpesaPayments(source = "SCHEDULED_RECOVERY") {
        const settings = this.getSettings();
        const now = new Date();
        const payments = await this.db.findPendingStkPayments({
            minCreatedAt: new Date(now.getTime() - settings.minAgeSeconds * 1000),
            dueAt: now,
            batchSize: settings.batchSize,
        });
        const results = [];
        for (let index = 0; index < payments.length; index += settings.concurrency) {
            const chunk = payments.slice(index, index + settings.concurrency);
            const chunkResults = await Promise.all(chunk.map(async (payment) => {
                const claimed = await this.db.claimMpesaReconciliation(payment.id, new Date(Date.now() + 60_000));
                return claimed
                    ? this.reconcileMpesaPayment({ ...payment, status: "PENDING" }, source)
                    : { state: "SKIPPED", paymentId: payment.id, platformID: payment.platformID, reason: "Claimed by another worker" };
            }));
            results.push(...chunkResults);
        }
        return results;
    }
}

module.exports = { MpesaReconciliationService, nairobiTimestamp, retryAtForAttempt, isLikelyMpesaReceiptCode };
