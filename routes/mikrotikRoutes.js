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
router.post("/pppoe-plan/update", use("updatePPPoEPlan"));
router.post("/pppoe-plan/delete", use("deletePPPoEPlan"));
	router.post("/pppoe-plans", use("fetchPPPoEPlans"));
	router.post("/pppoe-user/create", use("createPPPoEUser"));
	router.post("/pppoe-user/update", use("updatePPPoEUser"));
	router.post("/pppoe-user/import", use("importPPPoEUsersFromRouter"));
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
router.get("/auto-router/script/:token", use("getAutoRouterScript"));
router.get("/seed/cleanup-expired-hotspot.rsc", use("getCleanupExpiredHotspotSeedScript"));
router.get(
    "/seed/cleanup-3gb-no-expiry-timeout/:platformID/:token.rsc",
    use("getCleanup3gbNoExpiryTimeoutSeedScript")
);
router.get("/auto-router/log", use("autoRouterLog"));
router.get("/auto-router/complete", use("autoRouterComplete"));
router.get("/hotspot/expire", use("expireHotspotUserFromRouter"));
router.get("/hotspot/login-template/:token.html", use("downloadHotspotLoginTemplate"));
router.get("/hotspot/login-template/:token", use("downloadHotspotLoginTemplate"));
router.post("/ppp-info", use("fetchPPPoEInfo"));
router.post("/import", use("importUsers"));
router.post("/seed-auto-backup-script", use("seedAutoBackupScript"));
router.get("/seed/auto-backup-script.rsc", use("getAutoBackupSeedScript"));
router.get("/seed/auto-backup-script/:platformID/:host/:token.rsc", use("getAutoBackupSeedScript"));
router.post("/station-seed-scripts", use("getStationSeedScripts"));
router.post("/files/list", use("listMikrotikFiles"));
router.post("/files/read", use("readMikrotikFile"));
router.post("/files/upload", use("uploadMikrotikFile"));
router.post("/files/move", use("moveMikrotikFile"));
router.post("/files/delete", use("deleteMikrotikFile"));
router.post("/router-settings", use("getRouterQuickSettings"));
router.post("/router-settings/update", use("updateRouterQuickSetting"));
router.post("/router-backup/notify", use("notifyRouterBackupUploaded"));
router.get("/router-backup/notify", use("notifyRouterBackupUploaded"));
router.put(
    "/router-backup/upload",
    express.raw({ type: "*/*", limit: "200mb" }),
    (req, res) => controller.uploadRouterBackup(req, res)
);
router.post(
    "/router-backup/upload",
    express.raw({ type: "*/*", limit: "200mb" }),
    (req, res) => controller.uploadRouterBackup(req, res)
);
router.post("/reboot", use("rebootRouter"));

module.exports = router;
