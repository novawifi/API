// @ts-check

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "test-encryption-key";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const { MpesaReconciliationService, nairobiTimestamp, retryAtForAttempt } = require("../services/mpesaReconciliationService");
const { MpesaReconciliationWorker } = require("../services/mpesaReconciliationWorker");

const payment = (overrides = {}) => ({
    id: "pay-1",
    checkoutRequestId: "ws_CO_test",
    reqcode: "ws_CO_test",
    status: "PENDING",
    amount: "100",
    phone: "254700000000",
    platformID: "plat-1",
    paymentMethod: "Mpesa API",
    reconciliationAttempts: 0,
    createdAt: new Date(Date.now() - 120_000),
    ...overrides,
});

const harness = (queryResult) => {
    const calls = { updates: [], records: [], finalized: 0 };
    const db = {
        getMpesaByID: async () => payment(),
        updateMpesaCodeByID: async (_id, data) => { calls.updates.push(data); return data; },
        recordMpesaReconciliation: async (_id, data) => { calls.records.push(data); return data; },
    };
    const controller = {
        db,
        finalizeReconciledStkPayment: async () => { calls.finalized += 1; },
    };
    const service = new MpesaReconciliationService(controller);
    service.queryStkPushStatus = async () => {
        if (queryResult instanceof Error) throw queryResult;
        return queryResult;
    };
    return { service, calls };
};

for (const resultCode of [0, "0"]) {
    test(`confirmed STK success accepts ResultCode ${JSON.stringify(resultCode)}`, async () => {
        const { service, calls } = harness({ ResultCode: resultCode, ResultDesc: "Success" });
        const result = await service.reconcileMpesaPayment(payment());
        assert.equal(result.state, "SUCCESS");
        assert.equal(result.resultCode, "0");
        assert.equal(calls.finalized, 1);
    });
}

test("cancelled STK transaction is final", async () => {
    const { service, calls } = harness({ ResultCode: 1032, ResultDesc: "Request cancelled by user" });
    const result = await service.reconcileMpesaPayment(payment());
    assert.equal(result.state, "FAILED");
    assert.equal(calls.records[0].status, "CANCELLED");
    assert.equal(calls.finalized, 0);
});

test("insufficient funds is final and does not fulfill", async () => {
    const { service, calls } = harness({ ResultCode: "1", ResultDesc: "Insufficient funds" });
    const result = await service.reconcileMpesaPayment(payment());
    assert.equal(result.state, "FAILED");
    assert.equal(calls.records[0].status, "FAILED");
    assert.equal(calls.finalized, 0);
});

test("accepted query without ResultCode remains pending", async () => {
    const { service, calls } = harness({ ResponseCode: "0", ResponseDescription: "Accepted" });
    const result = await service.reconcileMpesaPayment(payment());
    assert.equal(result.state, "PENDING");
    assert.ok(calls.records[0].nextReconciliationAt instanceof Date);
});

for (const message of ["network timeout", "HTTP 500"]) {
    test(`${message} remains pending`, async () => {
        const { service, calls } = harness(new Error(message));
        const result = await service.reconcileMpesaPayment(payment());
        assert.equal(result.state, "PENDING");
        assert.match(calls.records[0].lastReconciliationError, new RegExp(message));
    });
}

test("already successful payment is skipped without fulfillment", async () => {
    const { service, calls } = harness({ ResultCode: "0" });
    const result = await service.reconcileMpesaPayment(payment({ status: "COMPLETE" }));
    assert.equal(result.state, "SKIPPED");
    assert.equal(calls.finalized, 0);
});

test("unknown payment id is skipped", async () => {
    const { service } = harness({ ResultCode: "0" });
    service.db.getMpesaByID = async () => null;
    const result = await service.reconcileMpesaPayment("missing");
    assert.equal(result.state, "SKIPPED");
});

test("maximum age moves an uncertain payment to manual review", async () => {
    const { service, calls } = harness({ ResultCode: "0" });
    const result = await service.reconcileMpesaPayment(payment({ createdAt: new Date(Date.now() - 25 * 3_600_000) }));
    assert.equal(result.state, "SKIPPED");
    assert.equal(calls.updates[0].status, "MANUAL_REVIEW");
});

test("worker prevents overlapping runs", async () => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const controller = { reconciliation: { reconcilePendingMpesaPayments: async () => pending } };
    const worker = new MpesaReconciliationWorker(controller);
    const first = worker.run();
    const second = await worker.run();
    assert.equal(second.skipped, true);
    release([]);
    await first;
});

test("Nairobi timestamp and retry schedule are deterministic", () => {
    assert.equal(nairobiTimestamp(new Date("2026-06-21T14:33:28Z")), "20260621173328");
    const now = new Date("2026-01-01T00:00:00Z");
    assert.equal(retryAtForAttempt(1, now).getTime() - now.getTime(), 90_000);
    assert.equal(retryAtForAttempt(6, now).getTime() - now.getTime(), 3_600_000);
});
