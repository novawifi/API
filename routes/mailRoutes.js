const router = require("express").Router();
const { Mailer } = require("../controllers/mailerController");

const Controller = new Mailer();

router.post("/send", (req, res) => Controller.sendMail(res, req));

module.exports = router;
