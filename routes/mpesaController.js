// @ts-check

const router = require("express").Router();
const { MpesaController } = require("../controllers/mpesaController");

const controller = new MpesaController();

const use = (name) => {
    const handler = controller[name];
    if (typeof handler !== "function") {
        console.error(`[mpesaRoutes] Missing handler: ${name}`);
        return (req, res) =>
            res.status(501).json({ success: false, message: `Handler ${name} not implemented` });
    }
    return (req, res) => handler.call(controller, req, res);
};

router.post("/stkpush", use("stkPush"));
router.post("/withdraw", use("WithdrawFunds"));
const MPESA_CALLBACK_PATH = process.env.MPESA_CALLBACK_PATH;
const INTASEND_WITHDRAWAL_CALLBACK_PATH = process.env.INTASEND_WITHDRAWAL_CALLBACK_PATH;
const INTASEND_DEPOSIT_CALLBACK_PATH = process.env.INTASEND_DEPOSIT_CALLBACK_PATH;
const PAYSTACK_DEPOSIT_CALLBACK_PATH = process.env.PAYSTACK_DEPOSIT_CALLBACK_PATH;

if (MPESA_CALLBACK_PATH) router.post(MPESA_CALLBACK_PATH, use("callBack"));
if (INTASEND_WITHDRAWAL_CALLBACK_PATH) router.post(INTASEND_WITHDRAWAL_CALLBACK_PATH, use("handleIntasendCallback"));
if (INTASEND_DEPOSIT_CALLBACK_PATH) router.post(INTASEND_DEPOSIT_CALLBACK_PATH, use("handleIntasendDepositCallback"));
if (PAYSTACK_DEPOSIT_CALLBACK_PATH) router.post(PAYSTACK_DEPOSIT_CALLBACK_PATH, use("handlePaystackDepositCallback"));

router.post("/confirm", use("checkPayment"));
router.post("/payPPPoE", use("payPPPoE"));
router.post("/paybill", use("payBill"));
router.post("/paysms", use("paySMS"));
router.post("/verify-transaction", use("verifyTransaction"));
router.post("/reverse-transaction", use("reverseTransaction"));
router.post("/b2b-transfer", use("transferToBusiness"));
router.post("/timeout", use("QueueTimeOutURLcallBack"));
router.post("/pull-callback", use("PullTransactionsCallback"));
router.post("/result", use("ResultURLcallBack"));
router.post("/confirmation", use("confirmationURL"));
router.post("/validation", use("validationURL"));

module.exports = router;
