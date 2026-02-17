const router = require("express").Router();
const { Mailer } = require("../controllers/mailerController");

const controller = new Mailer();

const use = (name) => {
    const handler = controller[name];
    if (typeof handler !== "function") {
        console.error(`[mailRoutes] Missing handler: ${name}`);
        return (req, res) =>
            res.status(501).json({ success: false, message: `Handler ${name} not implemented` });
    }
    return (req, res) => handler.call(controller, req, res);
};

router.post("/send", use("sendMail"));

module.exports = router;
