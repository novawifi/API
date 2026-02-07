const express = require("express");
const { TwoFAController } = require("../controllers/twoFAController");

const router = express.Router();
const controller = new TwoFAController();

const use = (name) => {
    const handler = controller[name];
    if (typeof handler !== "function") {
        console.error(`[twoFARoutes] Missing handler: ${name}`);
        return (req, res) =>
            res.status(501).json({ success: false, message: `Handler ${name} not implemented` });
    }
    return (req, res) => handler.call(controller, req, res);
};

// POST
router.post("/fetchTwoFa", use("fetch2FA"));
router.post("/verify", use("Verify2FAToken"));
router.post("/generateQRCode", use("GenerateQRCode"));
router.post("/enable", use("enable2FA"));
router.post("/disable", use("disable2FA"));

// GET
router.get("/secret", use("GenerateSecretKey"));

module.exports = router;
