// @ts-check

const { MpesaController } = require("../controllers/mpesaController");

class MpesaReconciliationWorker {
    constructor(controller = new MpesaController()) {
        this.controller = controller;
        this.running = false;
        this.started = false;
        this.timer = null;
        this.startupTimer = null;
    }

    isEnabled() {
        return String(process.env.MPESA_RECONCILIATION_ENABLED || "true").toLowerCase() !== "false";
    }

    logPlatform(platformID, message, level = "info") {
        if (!platformID || typeof this.controller.logPayment !== "function") return;
        this.controller.logPayment(platformID, message, level);
    }

    async getManualReviewSummary() {
        if (typeof this.controller.db?.getMpesaManualReviewSummary !== "function") return [];
        try {
            return await this.controller.db.getMpesaManualReviewSummary();
        } catch (error) {
            console.error("Failed to fetch M-PESA manual-review summary", error?.message || error);
            return [];
        }
    }

    async run(source = "SCHEDULED_RECOVERY") {
        if (this.running) return { skipped: true, reason: "Previous reconciliation run is still active" };
        this.running = true;
        try {
            const beforeManualReview = await this.getManualReviewSummary();
            const results = await this.controller.reconciliation.reconcilePendingMpesaPayments(source);
            const summary = results.reduce((acc, result) => {
                acc[result.state.toLowerCase()] = (acc[result.state.toLowerCase()] || 0) + 1;
                return acc;
            }, { checked: results.length, success: 0, failed: 0, pending: 0, skipped: 0 });
            console.info("M-PESA reconciliation summary", { source, ...summary });
            const byPlatform = new Map();
            for (const result of results) {
                if (!result.platformID) continue;
                const item = byPlatform.get(result.platformID) || { checked: 0, success: 0, failed: 0, pending: 0, skipped: 0 };
                item.checked += 1;
                const key = String(result.state || "skipped").toLowerCase();
                item[key] = (item[key] || 0) + 1;
                byPlatform.set(result.platformID, item);
            }
            for (const [platformID, item] of byPlatform.entries()) {
                this.logPlatform(
                    platformID,
                    `M-PESA reconciliation ${source}: checked ${item.checked}, complete ${item.success || 0}, failed ${item.failed || 0}, pending ${item.pending || 0}, skipped ${item.skipped || 0}.`,
                    "info"
                );
            }
            const afterManualReview = await this.getManualReviewSummary();
            const platformIds = new Set([
                ...beforeManualReview.map((item) => item.platformID),
                ...afterManualReview.map((item) => item.platformID),
            ]);
            for (const platformID of platformIds) {
                const before = beforeManualReview.find((item) => item.platformID === platformID);
                const after = afterManualReview.find((item) => item.platformID === platformID);
                const remaining = after?.total || 0;
                if (!remaining && !before?.total) continue;
                const level = after?.missingCheckoutRequestId ? "warn" : "info";
                this.logPlatform(
                    platformID,
                    `M-PESA manual-review sweep ${source}: before ${before?.total || 0}, remaining ${remaining}, queryable ${after?.queryable || 0}, missing CheckoutRequestID ${after?.missingCheckoutRequestId || 0}.`,
                    level
                );
            }
            return summary;
        } catch (error) {
            console.error("M-PESA reconciliation run failed", { source, message: error?.message || String(error) });
            return { checked: 0, errored: 1 };
        } finally {
            this.running = false;
        }
    }

    start() {
        if (this.started || !this.isEnabled()) return;
        this.started = true;
        const intervalMs = Math.max(60_000, Number(process.env.MPESA_RECONCILIATION_INTERVAL_MS || 120_000));
        const startupDelayMs = Math.max(5_000, Number(process.env.MPESA_RECONCILIATION_STARTUP_DELAY_MS || 30_000));
        this.startupTimer = setTimeout(() => {
            void this.run("STARTUP_RECOVERY");
            this.timer = setInterval(() => void this.run("SCHEDULED_RECOVERY"), intervalMs);
            this.timer.unref?.();
        }, startupDelayMs);
        this.startupTimer.unref?.();
    }

    stop() {
        if (this.startupTimer) clearTimeout(this.startupTimer);
        if (this.timer) clearInterval(this.timer);
        this.startupTimer = null;
        this.timer = null;
        this.started = false;
    }
}

module.exports = { MpesaReconciliationWorker };
