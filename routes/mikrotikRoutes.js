const express = require("express");
const { Mikrotikcontroller } = require("../controllers/mikrotikController");

const router = express.Router();
const Controller = new Mikrotikcontroller();

router.post("/pools", (req, res) => Controller.fetchAddressPoolsFromConnections(req, res));
router.post("/stations", (req, res) => Controller.fetchStations(req, res));
router.post("/adminStations", (req, res) => Controller.fetchAdminStations(req, res));
router.post("/hotspot-profiles", (req, res) => Controller.fetchMikrotikProfiles(req, res));
router.post("/updatePool", (req, res) => Controller.updateAddressPool(req, res));
router.post("/deletePool", (req, res) => Controller.deleteAddressPool(req, res));
router.post("/interfaces", (req, res) => Controller.fetchInterfaces(req, res));
router.post("/ppp-profiles", (req, res) => Controller.fetchPPPprofile(req, res));
router.post("/ppp-servers", (req, res) => Controller.fetchPPPoEServers(req, res));
router.post("/station-summary", (req, res) => Controller.fetchStationSummary(req, res));
router.post("/updatePPPoE", (req, res) => Controller.updateMikrotikPPPoE(req, res));
router.post("/togglePPPoE", (req, res) => Controller.togglePPPoEStatus(req, res));
router.post("/deletePppoE", (req, res) => Controller.deletePppoE(req, res));
router.post("/connections", (req, res) => Controller.mikrotikConnections(req, res));
router.post("/debug-connections", (req, res) => Controller.debugMikrotikConnections(req, res));
router.post("/updateUser", (req, res) => Controller.updateMikrotikUser(req, res));
router.post("/autoConfigurePPPoE", (req, res) => Controller.autoConfigurePPPoE(req, res));
router.post("/isPPPoEAutoConfigured", (req, res) => Controller.isPPPoEAutoConfigured(req, res));
router.post("/autoConfigureHotspot", (req, res) => Controller.autoConfigureHotspot(req, res));
router.post("/isHotspotAutoConfigured", (req, res) => Controller.isHotspotAutoConfigured(req, res));
router.post("/auto-router/start", (req, res) => Controller.startAutoRouter(req, res));
router.get("/auto-router/script", (req, res) => Controller.getAutoRouterScript(req, res));
router.get("/auto-router/log", (req, res) => Controller.autoRouterLog(req, res));
router.get("/auto-router/complete", (req, res) => Controller.autoRouterComplete(req, res));
router.post("/ppp-info", (req, res) => Controller.fetchPPPoEInfo(req, res));
router.post("/import", (req, res) => Controller.importUsers(req, res));
router.post("/reboot", (req, res) => Controller.rebootRouter(req, res));

module.exports = router;
