const express = require("express");
const { TwoFAController } = require("../controllers/twoFAController");

const router = express.Router();
const Controller = new TwoFAController();

// POST
router.post("/fetchTwoFa", (req, res) => Controller.fetch2FA(req, res));
router.post("/verify", (req, res) => Controller.Verify2FAToken(req, res));
router.post("/generateQRCode", (req, res) => Controller.GenerateQRCode(req, res));
router.post("/enable", (req, res) => Controller.enable2FA(req, res));
router.post("/disable", (req, res) => Controller.disable2FA(req, res));

// GET
router.get("/secret", (req, res) => Controller.GenerateSecretKey(req, res));

module.exports = router;
