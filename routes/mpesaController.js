// @ts-check

const router = require("express").Router();
const { MpesaController } = require("../controllers/mpesaController");

const Controller = new MpesaController();

router.post("/stkpush", (req, res) => Controller.stkPush(req, res));
router.post("/callback-Sss333123kyan", (req, res) => Controller.callBack(req, res));
router.post("/withdraw", (req, res) => Controller.WithdrawFunds(req, res));
router.post("/intasend-withdrawal-callback", (req, res) => Controller.handleIntasendCallback(req, res));
router.post("/intasend-deposit-callback", (req, res) => Controller.handleIntasendDepositCallback(req, res));
router.post("/paystack-deposit-callback", (req, res) => Controller.handlePaystackDepositCallback(req, res));
router.post("/confirm", (req, res) => Controller.checkPayment(req, res));
router.post("/payPPPoE", (req, res) => Controller.payPPPoE(req, res));
router.post("/paybill", (req, res) => Controller.payBill(req, res));
router.post("/paysms", (req, res) => Controller.paySMS(req, res));
router.post("/timeout", (req, res) => Controller.QueueTimeOutURLcallBack(req, res));
router.post("/result", (req, res) => Controller.ResultURLcallBack(req, res));
router.post("/confirmation", (req, res) => Controller.confirmationURL(req, res));
router.post("/validation", (req, res) => Controller.validationURL(req, res));

module.exports = router;
