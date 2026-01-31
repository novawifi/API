// @ts-check

const router = require("express").Router();
const { SupportController } = require("../controllers/supportController");

const Controller = new SupportController();

router.post("/tickets", (req, res) => Controller.createTicket(req, res));
router.get("/tickets", (req, res) => Controller.listTickets(req, res));
router.get("/tickets/:id", (req, res) => Controller.getThread(req, res));
router.post("/tickets/:id/messages", (req, res) => Controller.addMessage(req, res));
router.patch("/tickets/:id/status", (req, res) => Controller.updateStatus(req, res));

router.post("/live", (req, res) => Controller.createLive(req, res));
router.get("/live", (req, res) => Controller.listLive(req, res));
router.get("/live/:id", (req, res) => Controller.getThread(req, res));
router.post("/live/:id/messages", (req, res) => Controller.addMessage(req, res));
router.patch("/live/:id/status", (req, res) => Controller.updateStatus(req, res));

module.exports = router;
