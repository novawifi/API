// @ts-check

const router = require("express").Router();
const { SupportController } = require("../controllers/supportController");

const controller = new SupportController();

const use = (name) => {
    const handler = controller[name];
    if (typeof handler !== "function") {
        console.error(`[supportRoutes] Missing handler: ${name}`);
        return (req, res) =>
            res.status(501).json({ success: false, message: `Handler ${name} not implemented` });
    }
    return (req, res) => handler.call(controller, req, res);
};

router.post("/tickets", use("createTicket"));
router.get("/tickets", use("listTickets"));
router.get("/tickets/:id", use("getThread"));
router.post("/tickets/:id/messages", use("addMessage"));
router.patch("/tickets/:id/status", use("updateStatus"));

router.post("/live", use("createLive"));
router.get("/live", use("listLive"));
router.get("/live/:id", use("getThread"));
router.post("/live/:id/messages", use("addMessage"));
router.patch("/live/:id/status", use("updateStatus"));
router.delete("/live/:id", use("deleteLiveThread"));

router.post("/public/live", use("createPublicLive"));
router.get("/public/live", use("getPublicLiveByPhone"));
router.get("/public/live/:id", use("getPublicLiveThread"));
router.post("/public/live/:id/messages", use("addPublicMessage"));

module.exports = router;
