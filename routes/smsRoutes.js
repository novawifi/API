const router = require("express").Router();
const { SMS } = require("../controllers/smsController");

const Controller = new SMS();

router.post("/send", async (req, res) => {
    const { phone, message, sms } = req.body || {};
    const result = await Controller.sendSMS(phone, message, sms);
    return res.json(result);
});

module.exports = router;
