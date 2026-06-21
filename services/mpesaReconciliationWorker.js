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

    async run(source = "SCHEDULED_RECOVERY") {
        if (this.running) return { skipped: true, reason: "Previous reconciliation run is still active" };
        this.running = true;
        try {
            const results = await this.controller.reconciliation.reconcilePendingMpesaPayments(source);
            const summary = results.reduce((acc, result) => {
                acc[result.state.toLowerCase()] = (acc[result.state.toLowerCase()] || 0) + 1;
                return acc;
            }, { checked: results.length, success: 0, failed: 0, pending: 0, skipped: 0 });
            console.info("M-PESA reconciliation summary", { source, ...summary });
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
