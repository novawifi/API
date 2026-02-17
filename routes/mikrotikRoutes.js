const express = require("express");
const { Mikrotikcontroller } = require("../controllers/mikrotikController");

const router = express.Router();
const controller = new Mikrotikcontroller();

const use = (name) => {
    const handler = controller[name];
    if (typeof handler !== "function") {
        console.error(`[mikrotikRoutes] Missing handler: ${name}`);
        return (req, res) =>
            res.status(501).json({ success: false, message: `Handler ${name} not implemented` });
    }
    return (req, res) => handler.call(controller, req, res);
};

router.post("/pools", use("fetchAddressPoolsFromConnections"));
router.post("/stations", use("fetchStations"));
router.post("/adminStations", use("fetchAdminStations"));
router.post("/hotspot-profiles", use("fetchMikrotikProfiles"));
router.post("/updatePool", use("updateAddressPool"));
router.post("/deletePool", use("deleteAddressPool"));
router.post("/interfaces", use("fetchInterfaces"));
router.post("/ppp-profiles", use("fetchPPPprofile"));
router.post("/ppp-servers", use("fetchPPPoEServers"));
router.post("/ppp-profile/create", use("createPPPProfile"));
router.post("/pppoe-server/create", use("createPPPoEServer"));
router.post("/pppoe-plan/create", use("createPPPoEPlan"));
router.post("/pppoe-plans", use("fetchPPPoEPlans"));
router.post("/pppoe-user/create", use("createPPPoEUser"));
router.post("/pppoe-user/update", use("updatePPPoEUser"));
router.post("/station-summary", use("fetchStationSummary"));
router.post("/updatePPPoE", use("updateMikrotikPPPoE"));
router.post("/togglePPPoE", use("togglePPPoEStatus"));
router.post("/deletePppoE", use("deletePppoE"));
router.post("/connections", use("mikrotikConnections"));
router.post("/debug-connections", use("debugMikrotikConnections"));
router.post("/updateUser", use("updateMikrotikUser"));
router.post("/autoConfigurePPPoE", use("autoConfigurePPPoE"));
router.post("/isPPPoEAutoConfigured", use("isPPPoEAutoConfigured"));
router.post("/autoConfigureHotspot", use("autoConfigureHotspot"));
router.post("/isHotspotAutoConfigured", use("isHotspotAutoConfigured"));
router.post("/repair-router", use("repairRouter"));
router.post("/auto-router/start", use("startAutoRouter"));
router.get("/auto-router/script", use("getAutoRouterScript"));
router.get("/auto-router/log", use("autoRouterLog"));
router.get("/auto-router/complete", use("autoRouterComplete"));
router.post("/ppp-info", use("fetchPPPoEInfo"));
router.post("/import", use("importUsers"));
router.post("/reboot", use("rebootRouter"));

module.exports = router;
