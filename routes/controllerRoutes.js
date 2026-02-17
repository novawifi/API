const { Controller } = require("../controllers/maincontroller");
const router = require("express").Router();

const controller = new Controller();

const use = (name) => {
  const handler = controller[name];
  if (typeof handler !== "function") {
    console.error(`[controllerRoutes] Missing handler: ${name}`);
    return (req, res) =>
      res.status(501).json({ success: false, message: `Handler ${name} not implemented` });
  }
  return (req, res) => handler.call(controller, req, res);
};

// POST
router.post("/packages", use("Packages"));
router.post("/authAdmin", use("authAdmin"));
router.post("/authManager", use("authManager"));
router.post("/code", use("getCode"));
router.post("/addPlatform", use("addPlatform"));
router.post("/updatePlatform", use("updatePlatform"));
router.post("/deletePlatform", use("deletePlatformID"));
router.post("/loginAdmin", use("LoginAdmin"));
router.post("/loginManager", use("LoginManager"));
router.post("/fetchPayments", use("fetchPayments"));
router.post("/fetchRecentPayments", use("fetchRecentPayments"));
router.post("/exportPaymentsCsv", use("exportPaymentsCsv"));
router.post("/exportUsersCsv", use("exportUsersCsv"));
router.post("/billPayments", use("billPayments"));
router.post("/managerBillPayments", use("managerBillPayments"));
router.post("/search", use("search"));
router.post("/fetchModerators", use("fetchModerators"));
router.post("/addModerator", use("addModerators"));
router.post("/fetchSettings", use("fetchSettings"));
router.post("/addSettings", use("addSettings"));
router.post("/deleteCode", use("deleteCodes"));
router.post("/updatePackage", use("updatePackages"));
router.post("/addPackage", use("addPackages"));
router.post("/deletePackage", use("deletePackages"));
router.post("/updateSettings", use("updateSettings"));
router.post("/updateCode", use("updateCodes"));
router.post("/updateModerator", use("updateModerators"));
router.post("/deleteModerator", use("deleteModerators"));
router.post("/fetchCodes", use("fetchCodes"));
router.post("/deletePayment", use("deletePayment"));
router.post("/managerDeleteBillPayment", use("managerDeleteBillPayment"));
router.post("/updateName", use("updateName"));
router.post("/fetchPackages", use("fetchPackages"));
router.post("/fetchStations", use("fetchStations"));
router.post("/updateStation", use("updateStations"));
router.post("/deleteStation", use("deleteStations"));
router.post("/addCode", use("addCode"));
router.post("/getCodes", use("getCodes"));
router.post("/stats", use("fetchDashboardStats"));
router.post("/createAccount", use("registerPlatform"));
router.post("/updateddns", use("UpdateDDNSViaScript"));
router.post("/fetchddns", use("fetchDDNS"))
router.post("/updatemyddns", use("updateDDNSR"));
router.post("/deletemyddns", use("deleteDDNSR"));
router.post("/deleteUser", use("removeUser"));
router.post("/updatepppoe", use("updatePPPoE"));
router.post("/pppoe", use("fetchMyPPPoe"));
router.post("/templates", use("fetchTemplates"));
router.post("/updateTemplate", use("updateTemplate"));
router.post("/verifyCode", use("verifyCodes"));
router.post("/resetPassword", use("ResetPassword"));
router.post("/updatePassword", use("UpdatePassword"));
router.post("/updateProfile", use("UpdateProfile"));
router.post("/fetchAllTemplates", use("fetchAllTemplates"));
router.post("/addTemplate", use("addTemplates"));
router.post("/editTemplate", use("updateTemplates"));
router.post("/deleteTemplate", use("removeTemplates"));
router.post("/updateMyPassword", use("updateMyPassword"));
router.post("/pppoeInfo", use("fetchPPPoEInfo"));
router.post("/filterRevenue", use("filterRevenue"));
router.post("/fetchBackUp", use("fetchBackUp"));
router.post("/logoutAdmin", use("logoutAdmin"));
router.post("/bills", use("fetchPlatformBills"));
router.post("/funds", use("fetchFunds"));
router.post("/sessions", use("fetchSessions"));
router.post("/deleteSession", use("deleteMySession"))
router.post("/toggleSMS", use("enableSMS"))
router.post("/fetchSMS", use("fetchSMS"))
router.post("/saveTemplates", use("saveSMSTemplates"))
router.post("/resolves", use("checkIfDomainResolvesToServer"))
router.post("/updatePayment", use("updatePayments"))
router.post("/managerUpdateBillPayment", use("managerUpdateBillPayment"))
router.post("/rechargesms", use("rechargeSMS"))
router.post("/fetchPlatforms", use("fetchPlatforms"));
router.post("/fetchPlugins", use("fetchPlugins"));
router.post("/togglePlugin", use("togglePlugin"));
router.post("/fetchSidebarArchive", use("fetchSidebarArchive"));
router.post("/updateSidebarArchive", use("updateSidebarArchive"));
router.post("/fetchTermsOfService", use("fetchTermsOfService"));
router.post("/saveTermsOfService", use("saveTermsOfService"));
router.post("/publicTerms", use("fetchPublicTerms"));
router.post("/managerServices", use("managerFetchServices"));
router.post("/managerAddService", use("managerAddService"));
router.post("/managerUpdateService", use("managerUpdateService"));
router.post("/managerDeleteService", use("managerDeleteService"));
router.post("/fetchAdmins", use("fetchAdmins"));
router.post("/fetchPlatformSettings", use("fetchPlatformSettings"))
router.post("/fetchPlatform", use("fetchPlatform"))
router.post("/updatePlatformSettings", use("updateManagerSettings"))
router.post("/updateAdmin", use("updateAdmin"));
router.post("/deleteAdmin", use("deleteAdmin"));
router.post("/saveEmailTemplates", use("saveEmailTemplates"))
router.post("/fetchEmailTemplates", use("fetchEmailTemplates"))
router.post("/fetchConfigs", use("fetchConfigFiles"))
router.post("/uploadConfig", use("UploadConfig"))
router.post("/deleteConfig", use("deleteConfig"))
router.post("/updateConfig", use("updateConfig"))
router.post("/validateToken", use("verifyUserToken"))
router.post("/saveSMSConfig", use("saveSMSConfig"));
router.post("/uploadBrandingLogo", use("uploadBrandingLogo"));
router.post("/saveBrandingSupport", use("saveBrandingSupport"));
router.post("/installSSL", use("installLetsEncryptSSLCert"));
router.post("/validateSSL", use("checkSSL"));
router.post("/validateSSLBatch", use("checkSSLBatch"));
router.post("/fetchPPPoEPhoneNumbers", use("fetchPPPoEPhoneNumbers"));
router.post("/fetchHotspotPhoneNumbers", use("fetchHotspotPhoneNumbers"));
router.post("/sendBulkSMS", use("sendBulkSMS"))
router.post("/scheduleBulkSMS", use("scheduleBulkSMS"))
router.post("/sendInternalSMS", use("sendInternalSMS"))
router.post("/sendInternalEmail", use("sendInternalEmail"))
router.post("/scheduleInternalSMS", use("scheduleInternalSMS"))
router.post("/scheduleInternalEmail", use("scheduleInternalEmail"))
router.post("/fetchBlockedUsers", use("fetchBlockedUsers"));
router.post("/addBlockedUser", use("addBlockedUser"));
router.post("/deleteBlockedUser", use("deleteBlockedUsers"));
router.post("/homeFibreRequest", use("requestHomeFibre"));
router.post("/homeFibreCallbacks", use("fetchHomeFibreCallbacks"));
router.post("/homeFibreCallback/resolve", use("resolveHomeFibreCallback"));
router.post("/homeFibreCallback/delete", use("deleteHomeFibreCallback"));
router.post("/radius-credentials", use("getRadiusCredentials"));
router.post("/migrateSystemBasis", use("migrateSystemBasis"));


// GET
router.get("/dashstats", use("fetchSuperDashboardStats"));
router.get("/stations", use("fetchStations"))
router.get("/backups/remote-hosts/:host/:filename", use("DownloadMikrotikBackUpFile"))
router.get("/files/:filename", use("DownloadConfigFile"))
router.get("/backups/login", use("DownloadLoginFile"))


module.exports = router;
