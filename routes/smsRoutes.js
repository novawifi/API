const router = require("express").Router();
const { SMS } = require("../controllers/smsController");

const controller = new SMS();

const use = (name) => {
    const handler = controller[name];
    if (typeof handler !== "function") {
        console.error(`[smsRoutes] Missing handler: ${name}`);
        return (req, res) =>
            res.status(501).json({ success: false, message: `Handler ${name} not implemented` });
    }
    return (req, res) => handler.call(controller, req, res);
};

router.post("/send", use("sendSMS"));

module.exports = router;
