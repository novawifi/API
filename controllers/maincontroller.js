//@ts-check

const axios = require("axios");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs").promises;
const { exec, execSync, execFile } = require("child_process");
const path = require("path");
const moment = require("moment");
const dns = require("dns").promises;
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const appRoot = require("app-root-path").path;
const { DataBase } = require("../helpers/databaseOperation");
const { Utils } = require("../utils/Functions");
const { Mailer } = require("./mailerController");
const { SMS } = require("./smsController");
const { Auth } = require("./authController");
const { Mikrotikcontroller } = require("./mikrotikController");
const { MpesaController } = require("./mpesaController");
const { socketManager } = require("./socketController");
const cache = require("../utils/cache");
const { ensureRadiusClient, removeRadiusClient } = require("../utils/radiusConfig");

class Controller {
  constructor() {
    this.db = new DataBase();
    this.mailer = new Mailer();
    this.sms = new SMS();
    this.auth = new Auth();
    this.mikrotik = new Mikrotikcontroller();
    this.mpesa = new MpesaController();
    this.cache = cache;

    this.PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || "";
    this.JWT_SECRET = process.env.JWT_SECRET || "";
  }

  logPlatform(platformID, message, meta = {}) {
    socketManager.log(platformID, message, {
      context: meta.context || "main",
      level: meta.level || "info",
      ...meta,
    });
  }

  buildDashboardResponse(payload, role = "admin") {
    if (!payload) return null;
    const IsB2B = role === "superuser" ? payload.IsB2B : false;
    if (role !== "superuser") {
      const limitedStats = {
        totalUsers: payload.stats?.totalUsers || 0,
        totalUsersOnline: payload.stats?.totalUsersOnline || 0,
        totalPPPoEUsers: payload.stats?.totalPPPoEUsers || 0,
        totalPPPoEUsersOnline: payload.stats?.totalPPPoEUsersOnline || 0,
      };
      return {
        success: true,
        message: "Dashboard stats fetched",
        stats: limitedStats,
        funds: {},
        networkusage: [],
        IsB2B: false,
      };
    }
    return {
      success: true,
      message: "Dashboard stats fetched",
      stats: payload.stats,
      funds: payload.funds,
      networkusage: payload.networkusage,
      IsB2B,
    };
  }

  async refreshDashboardStats(platformID, options = {}) {
    if (!platformID) return null;
    let onlineHotspotUsers;
    let onlinePPPoEUsers;
    try {
      onlineHotspotUsers = await this.mikrotik.fetchActiveHotspotConnections(platformID);
    } catch (error) {
      console.error("Error fetching hotspot active users:", error);
    }
    try {
      onlinePPPoEUsers = await this.mikrotik.fetchActivePPPoEConnections(platformID);
    } catch (error) {
      console.error("Error fetching pppoe active users:", error);
    }

    const payload = await this.db.rebuildDashboardStats(platformID, {
      ...options,
      onlineHotspotUsers,
      onlinePPPoEUsers,
    });
    if (!payload) return null;
    const response = this.buildDashboardResponse(payload, options.role || "superuser");
    if (response) {
      const cacheKey = `main:dashboard:${platformID}`;
      this.cache.set(cacheKey, response, 20000);
      socketManager.emitToRoom(`platform-${platformID}`, "stats", response);
    }
    return response;
  }

  async search(req, res) {

    const { token, search, entity, limit = 20, offset = 0, date } = req.body;

    if (!token || !entity) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields"
      });
    }

    try {
      const auth = await this.AuthenticateRequest(token);

      if (!auth.success || !auth.admin) {
        return res.status(401).json({
          success: false,
          message: auth.message
        });
      }

      const platformID = auth.admin.platformID;
      if (auth.admin.role !== "superuser" && !["users", "payments"].includes(entity)) {
        return res.status(403).json({
          success: false,
          message: "Unauthorised!",
        });
      }
      const cacheKey = `main:search:${platformID}:${entity}:${search || ""}:${limit}:${offset}:${date || ""}`;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return res.status(200).json(cached);
      }

      let result;
      let rows;

      switch (entity) {
        case "payments":
          result = await this.db.searchMpesa({
            platformID,
            search,
            limit,
            offset,
            date
          });

          rows = result?.rows || [];
          break;

        case "users":
          result = await this.db.searchUsers({
            platformID,
            search,
            limit,
            offset
          });

          let allActiveUsers = [];
          let mikrotikFailed = true;
          let codes = result?.rows || [];
          const stations = await this.db.getStations(platformID);
          for (const station of stations) {
            const activeRes = await this.mikrotik.checkHotspotUserStatus(platformID, station.mikrotikHost);
            if (activeRes.success) {
              mikrotikFailed = false;
              allActiveUsers = allActiveUsers.concat(activeRes.users);
            }
          }

          if (mikrotikFailed) {
            const newCodes = await Promise.all(
              codes.map(async (code) => {
                const pkg = code.package;
                return {
                  ...code,
                  station: pkg?.routerHost,
                  package: pkg?.name,
                  active: "Offline",
                };
              })
            );

            return rows = newCodes;
          }

          const newCodes = [];
          for (const code of codes) {
            const pkg = code.package;
            if (code.status !== "active") {
              newCodes.push({
                ...code,
                station: pkg?.routerHost,
                package: pkg?.name,
                active: "Offline",
              });
              continue;
            }

            const isActive = allActiveUsers.some(u => u.user === code.username);
            newCodes.push({
              ...code,
              station: pkg?.routerHost,
              package: pkg?.name,
              active: isActive ? "Online" : "Offline",
            });
          }

          rows = newCodes;
          break;
        case "packages":
          result = await this.db.searchPackages({
            platformID,
            search,
            limit,
            offset
          });
          rows = result?.rows || [];
          break;
        case "stations":
          result = await this.db.searchStations({
            platformID,
            search,
            limit,
            offset
          });
          rows = result?.rows || [];
          break;
        case "pppoe":
          result = await this.db.searchPppoe({
            platformID,
            search,
            limit,
            offset
          });
          rows = result?.rows || [];
          if (rows.length > 0) {
            const platform = await this.db.getPlatform(platformID);
            const platformUrl = platform?.url;
            await Promise.all(
              rows.map(async (row) => {
                if (!row?.paymentLink) {
                  const paymentLink = crypto.randomBytes(8).toString("hex");
                  await this.db.updatePPPoE(row.id, { paymentLink });
                  row.paymentLink = paymentLink;
                }
                if (platformUrl) {
                  row.link = `https://${platformUrl}/pppoe?info=${row.paymentLink}`;
                }
              })
            );
          }
          break;
        case "moderators":
          result = await this.db.searchModerators({
            platformID,
            search,
            limit,
            offset
          });
          rows = result?.rows || [];
          break;
        case "ddns":
          result = await this.db.searchDDNS({
            platformID,
            search,
            limit,
            offset
          });
          rows = result?.rows || [];
          break;
        case "support":
          result = await this.db.searchSupportThreads({
            platformID,
            search,
            limit,
            offset
          });
          rows = result?.rows || [];
          break;

        default:
          return res.status(400).json({
            success: false,
            message: "Invalid entity"
          });
      }

      const response = {
        success: true,
        rows: rows,
        totalCount: result.totalCount
      };
      this.cache.set(cacheKey, response, 15000);
      return res.status(200).json(response);

    } catch (error) {
      console.error(error);
      return res.status(500).json({
        success: false,
        message: "Internal server error"
      });
    }

  }

  async billPayments(req, res) {

    const { token } = req.body;
    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }
    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success || !auth.admin) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }
      const admin = auth.admin;
      const platformID = auth.admin.platformID;

      const payments = await this.db.getBillPaymentsByPlatform(platformID);

      return res.status(200).json({
        success: true,
        message: "Bill payments retrieved successfully!",
        payments
      });
    } catch (error) {
      console.error("Error occurred:", error);
      res.status(500).json({ success: false, message: "Internal server error." });
    }

  }

  async managerBillPayments(req, res) {
    const { token, platformID, offset = 0, limit = 100 } = req.body || {};
    if (!token || !platformID) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }
    try {
      const session = await this.authManagerSession(token);
      if (!session.success) {
        return res.json({ success: false, message: session.message });
      }
      const safeLimit = Math.min(100, Number(limit) || 100);
      const safeOffset = Math.max(0, Number(offset) || 0);
      const payments = await this.db.getBillPaymentsByPlatformPaged(platformID, safeLimit, safeOffset);
      return res.status(200).json({
        success: true,
        message: "Bill payments retrieved successfully!",
        payments,
        nextOffset: safeOffset + (payments?.length || 0),
        hasMore: Array.isArray(payments) && payments.length === safeLimit,
      });
    } catch (error) {
      console.error("Error fetching manager bill payments:", error);
      res.status(500).json({ success: false, message: "Internal server error." });
    }
  }

  async managerUpdateBillPayment(req, res) {
    const { token, paymentData } = req.body || {};
    if (!token || !paymentData?.id) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }
    try {
      const session = await this.authManagerSession(token);
      if (!session.success) {
        return res.json({ success: false, message: session.message });
      }
      const payment = await this.db.getMpesaByID(paymentData.id);
      if (!payment || payment.service !== "bill") {
        return res.json({ success: false, message: "Bill payment not found!" });
      }
      const updatedPayment = await this.db.updateMpesaCodeByID(paymentData.id, {
        status: paymentData.status,
        code: paymentData.code,
      });
      return res.json({
        success: true,
        message: "Bill payment updated successfully",
        payment: updatedPayment,
      });
    } catch (error) {
      console.error("Error updating manager bill payment:", error);
      return res.json({ success: false, message: "Internal server error." });
    }
  }

  async managerDeleteBillPayment(req, res) {
    const { token, id } = req.body || {};
    if (!token || !id) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }
    try {
      const session = await this.authManagerSession(token);
      if (!session.success) {
        return res.json({ success: false, message: session.message });
      }
      const payment = await this.db.getMpesaByID(id);
      if (!payment || payment.service !== "bill") {
        return res.json({ success: false, message: "Bill payment not found!" });
      }
      await this.db.deleteMpesaPayment(id);
      return res.json({ success: true, message: "Bill payment deleted successfully" });
    } catch (error) {
      console.error("Error deleting manager bill payment:", error);
      return res.json({ success: false, message: "Internal server error." });
    }
  }

  async verifyUserToken(req, res) {

    const { token } = req.body;

    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const user = await this.db.getUserByToken(token);
      if (!user) {
        return res.json({
          success: false,
          message: "User not found!",
        });
      }

      if (user?.status !== "active") {
        return res.json({
          success: false,
          message: "User status is not active!",
        });
      }

      return res.json({
        success: true,
        message: "Token is valid, proceed to login!",
      });

    } catch (error) {
      console.error("Error getting codes:", error);
      return res.status(500).json({
        success: false,
        message: "Internal server error.",
        error: error.message
      });
    }

  }

  async fetchPlatformSettings(req, res) {

    const { token } = req.body;
    if (!token) {
      return res.json({
        success: false, message: "Missing credentials required!",
      });
    }
    const auth = await this.AuthenticateRequest(token);
    if (!auth.success) {
      return res.json({
        success: false,
        message: auth.message,
      });
    }

    try {
      const cacheKey = "main:platformSettings";
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return res.json(cached);
      }
      const settings = await this.db.getSettings();

      const response = {
        success: true,
        message: "Settings fetched",
        settings
      };
      this.cache.set(cacheKey, response, 300000);
      return res.json(response);
    } catch (error) {
      console.log("An error occurred", error);
      return res.json({ success: false, message: "An error occurred" });
    }

  }

  async fetchPlatform(req, res) {
    const { token } = req.body;
    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }
    const auth = await this.AuthenticateRequest(token);
    if (!auth.success || !auth.admin) {
      return res.json({
        success: false,
        message: auth.message,
      });
    }
    try {
      const cacheKey = `main:platform:${auth.admin.platformID}`;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return res.json(cached);
      }
      const platform = await this.db.getPlatform(auth.admin.platformID);
      if (!platform) {
        return res.json({
          success: false,
          message: "Platform not found",
        });
      }
      const response = {
        success: true,
        platform,
      };
      this.cache.set(cacheKey, response, 60000);
      return res.json(response);
    } catch (error) {
      console.log("An error occurred", error);
      return res.json({ success: false, message: "An error occurred" });
    }
  }

  async authAdmin(req, res) {

    try {
      const { token } = req.body;
      if (!token) {
        return res.json({
          success: false,
          message: "Missing credentials required!",
        });
      }
      const session = await this.db.getSessionByToken(token.trim());
      if (!session) {
        return res.json({
          success: false,
          message: "Invalid token. Authentication failed!",
        });
      }
      const admin = await this.db.getAdminByID(session.adminID);
      if (admin) {
        return res.json({
          success: true,
          message: "Authentication successful",
          admin,
        });
      }

      const superuser = await this.db.getSuperUserById(session.adminID);
      if (!superuser) {
        return res.json({
          success: false,
          message: "Admin not found. Authentication failed!",
        });
      }

      return res.json({
        success: true,
        message: "Authentication successful",
        admin: {
          id: superuser.id,
          adminID: superuser.id,
          platformID: session.platformID,
          role: "superuser",
          email: superuser.email,
          name: superuser.name || superuser.email,
          level: "2",
        },
      });
    } catch (error) {
      console.error("An error occurred during authentication:", error);
      return res.json({
        success: false,
        message: "Internal server error. Please try again later.",
      });
    }

  }

  async deletePlatformID(req, res) {

    const { id, token } = req.body;

    if (!id || !token) {
      return res.status(400).json({
        success: false,
        message: "Missing required credentials.",
      });
    }

    const auth = await this.AuthenticateRequest(token);
    if (!auth.success) {
      return res.json({
        success: false,
        message: auth.message,
      });
    }

    if (!auth.admin && !auth.superuser) {
      return res.json({
        success: false,
        message: "Invalid session provided!",
      });
    }

    if (auth.admin || auth.admin !== null) {
      if (auth.admin.role !== "superuser" && auth.admin.role !== "admin") {
        return res.json({
          success: false,
          message: "Unauthorised!",
        });
      }
    }

    try {
      const platform = await this.db.getPlatformByID(id);

      if (!platform) {
        return res.status(404).json({
          success: false,
          message: "Platform not found.",
        });
      }

      const allddns = await this.db.getDDNS(platform.platformID);
      for (const ddns of allddns) {
        await this.removeDDNS(ddns.url);
      }
      const stations = await this.db.getStations(platform.platformID);
      for (const station of stations) {
        const deletebackupfolder = await this.deleteBackupFolder(station.mikrotikHost);
        if (!deletebackupfolder?.success) {
          return res.json({
            success: false,
            message: deletebackupfolder?.message,
          });
        }
      }

      await this.db.deletePlatformConfig(platform.platformID);
      await this.db.deleteAdminsByPlatformId(platform.platformID);
      await this.db.deleteUsersByplatformID(platform.platformID);
      await this.db.deleteMpesaByplatformID(platform.platformID);
      await this.db.deletePackagesByplatformID(platform.platformID);
      await this.db.deleteHomeFibreLeadsByplatformID(platform.platformID);
      await this.db.deletDDNSByplatformID(platform.platformID);
      await this.db.deletePPPoEByplatformID(platform.platformID);
      await this.db.deletePPPoEPlansByplatformID(platform.platformID);
      await this.db.deleteFunds(platform.platformID);
      await this.db.deleteStationsByplatformID(platform.platformID);
      await this.db.deleteC2BTransferPool(platform.platformID);
      await this.db.deleteMpesaPullState(platform.platformID);
      await this.db.deleteMpesaPullTransactions(platform.platformID);
      await this.db.deleteDashboardStats(platform.platformID);
      await this.db.deleteStationDashboardStats(platform.platformID);
      await this.db.deleteScheduledSmsByplatformID(platform.platformID);
      await this.db.deletePlatformPlugins(platform.platformID);
      await this.db.deletePlatformTerms(platform.platformID);
      await this.db.deletePlatformSidebarLinks(platform.platformID);
      await this.db.deletePlatformSMS(platform.platformID);
      await this.db.deletePlatformEmailTemplate(platform.platformID);
      await this.db.deleteAllPlatformMikrotikBackUp(platform.platformID)
      await this.db.deleteNetworkUsages(platform.platformID)
      await this.db.deleteBills(platform.platformID)
      await this.db.deleteTwoFa(platform.platformID)
      await this.db.deleteBackups(platform.platformID)
      await this.db.deleteBlockedUsersByplatformID(platform.platformID)
      await this.db.deleteSupportThreadsByPlatform(platform.platformID)
      await this.db.deletePlatform(id);
      await this.db.deleteSessions(platform.platformID)
      await this.deleteSiteRecord(platform.url);
      if (platform.domain && platform.domain !== platform.url) {
        await this.deleteSiteRecord(platform.domain);
      }

      return res.status(200).json({
        success: true,
        message: "Platform deleted successfully.",
      });
    } catch (error) {
      console.error("An error occurred while deleting the platform:", error);
      return res.status(500).json({
        success: false,
        message: "An error occurred while deleting the platform.",
      });
    }

  }

  async fetchPlatforms(req, res) {

    const { token } = req.body;

    try {
      const session = await this.authManagerSession(token);
      if (!session.success) {
        return res.json({
          success: false,
          message: session.message,
        });
      }
      const cacheKey = "main:platforms:all";
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return res.json(cached);
      }
      const platforms = await this.db.getAllPlatforms();
      const response = {
        success: true,
        message: "Platforms fetched!",
        platforms: platforms,
      };
      this.cache.set(cacheKey, response, 30000);
      return res.json(response);
    } catch (error) {
      console.log("An error occured", error);
      return res.json({ success: false, message: "An error occured" });
    }

  }

  async fetchPlugins(req, res) {
    const { token } = req.body || {};
    if (!token) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }
    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success || !auth.admin) {
        return res.json({ success: false, message: auth.message });
      }
      const platformID = auth.admin.platformID;
      const platform = await this.db.getPlatformByplatformID(platformID);
      const isPremium = String(platform?.status || "").toLowerCase() === "premium";
      const services = await this.db.getSystemServices();
      const plugins = (services || []).filter((service) => service.isPlugin === true);
      const platformPlugins = await this.db.getPlatformPlugins(platformID);
      const enabledMap = new Map((platformPlugins || []).map((p) => [p.serviceKey, p]));

      const result = await Promise.all(
        plugins.map(async (plugin) => {
          const bill = auth.admin.role === "superuser"
            ? await this.db.getPlatformBillingByName(plugin.name, platformID)
            : null;
          const pluginRecord = enabledMap.get(plugin.key);
          return {
            ...plugin,
            enabled: pluginRecord?.status === "active",
            status: pluginRecord?.status || null,
            billStatus: bill?.status || null,
            billAmount: bill?.amount || null,
            displayPrice: isPremium ? "0" : String(plugin.price ?? "0"),
            isPremiumFree: isPremium,
          };
        })
      );

      return res.json({
        success: true,
        message: "Plugins fetched successfully!",
        plugins: result,
      });
    } catch (error) {
      console.error("Error fetching plugins:", error);
      return res.status(500).json({ success: false, message: "Internal server error." });
    }
  }

  async fetchSidebarArchive(req, res) {
    const { token } = req.body || {};
    if (!token) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }
    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success || !auth.admin) {
        return res.json({ success: false, message: auth.message });
      }
      const platformID = auth.admin.platformID;
      const adminId = auth.admin.id;
      const links = await this.db.getSidebarLinks(platformID, adminId);
      return res.json({
        success: true,
        message: "Sidebar links fetched successfully",
        links: links || [],
      });
    } catch (error) {
      console.error("Error fetching sidebar links:", error);
      return res.status(500).json({ success: false, message: "Internal server error." });
    }
  }

  async updateSidebarArchive(req, res) {
    const { token, linkKey, archived } = req.body || {};
    if (!token || !linkKey) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }
    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success || !auth.admin) {
        return res.json({ success: false, message: auth.message });
      }
      const platformID = auth.admin.platformID;
      const adminId = auth.admin.id;
      const updated = await this.db.upsertSidebarLink(platformID, adminId, linkKey, {
        archived: Boolean(archived),
      });
      return res.json({
        success: true,
        message: "Sidebar link updated successfully",
        link: updated,
      });
    } catch (error) {
      console.error("Error updating sidebar link:", error);
      return res.status(500).json({ success: false, message: "Internal server error." });
    }
  }

  async togglePlugin(req, res) {
    const { token, key, enable } = req.body || {};
    if (!token || !key) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }
    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success || !auth.admin) {
        return res.json({ success: false, message: auth.message });
      }
      if (auth.admin.role !== "superuser") {
        return res.json({ success: false, message: "Unauthorised!" });
      }
      const platformID = auth.admin.platformID;
      const platform = await this.db.getPlatformByplatformID(platformID);
      const isPremium = String(platform?.status || "").toLowerCase() === "premium";
      const service = await this.db.getSystemServiceByKey(key);
      if (!service || !service.isPlugin) {
        return res.json({ success: false, message: "Plugin not found." });
      }

      const isPaid = Number(service.price) > 0;
      if (enable === true) {
        const existing = await this.db.getPlatformPlugin(platformID, key);
        if (!existing) {
          await this.db.createPlatformPlugin({
            platformID,
            serviceKey: key,
            status: "active",
          });
        } else if (existing.status !== "active") {
          await this.db.updatePlatformPlugin(platformID, key, { status: "active" });
        }
        if (isPaid) {
          const existingBill = await this.db.getPlatformBillingByName(service.name, platformID);
          if (isPremium) {
            if (!existingBill) {
              await this.db.createPlatformBilling({
                period: service.period,
                platformID,
                name: service.name,
                price: String(service.price),
                amount: "0",
                currency: service.currency || "KES",
                dueDate: null,
                paidAt: null,
                status: "Paid",
                description: service.description,
                meta: { serviceKey: key, isPlugin: true, premium: true },
              });
            } else {
              await this.db.updatePlatformBilling(existingBill.id, {
                status: "Paid",
                amount: "0",
                dueDate: null,
                paidAt: null,
              });
            }
          } else {
            if (!existingBill) {
              let dueDate = null;
              if (service.period) {
                const match = String(service.period)
                  .toLowerCase()
                  .match(/^(\d+)\s+(hour|minute|day|month|year)s?$/i);
                if (match) {
                  dueDate = Utils.addPeriod(new Date(), +match[1], match[2]);
                }
              }
              await this.db.createPlatformBilling({
                period: service.period,
                platformID,
                name: service.name,
                price: String(service.price),
                amount: String(service.price),
                currency: service.currency || "KES",
                dueDate: dueDate || null,
                status: "Unpaid",
                description: service.description,
                meta: { serviceKey: key, isPlugin: true },
              });
            } else if (existingBill?.meta?.disableOn) {
              const meta = existingBill.meta || {};
              delete meta.disableOn;
              delete meta.disableRequestedAt;
              await this.db.updatePlatformBilling(existingBill.id, { meta });
            }
          }
        }
        if (key === "terms-of-service") {
          const existingTerms = await this.db.getPlatformTerms(platformID);
          if (!existingTerms) {
            await this.db.upsertPlatformTerms(platformID, {
              title: "Terms of Service",
              content:
                "These Terms of Service govern the use of internet services provided by this ISP.\\n\\nBy accessing or using the service, you agree to comply with these terms, including acceptable use, payment obligations, fair usage policies, and service limitations.\\n\\nThe ISP may suspend or terminate access for violations, fraudulent activity, or non-payment. Service availability is subject to maintenance, outages, and network conditions.\\n\\nIf you do not agree to these terms, do not use the service.",
            });
          }
        }
      } else {
        const existing = await this.db.getPlatformPlugin(platformID, key);
        if (key === "live-support" && existing && isPaid && !isPremium) {
          const existingBill = await this.db.getPlatformBillingByName(service.name, platformID);
          const billStatus = String(existingBill?.status || "").toLowerCase();
          if (existingBill && billStatus === "paid") {
            await this.db.updatePlatformPlugin(platformID, key, { status: "disabled" });
            return res.json({
              success: true,
              message: "Plugin disabled. You can re-enable later without losing paid time.",
            });
          }
        }

        if (existing) {
          await this.db.deletePlatformPlugin(platformID, key);
        }
        if (isPaid && !isPremium) {
          const existingBill = await this.db.getPlatformBillingByName(service.name, platformID);
          if (existingBill) {
            await this.db.deletePlatformBilling(existingBill.id);
          }
        }
        if (key === "terms-of-service") {
          // Keep saved terms for future re-enable; no action needed.
        }
      }

      return res.json({
        success: true,
        message: enable ? "Plugin enabled successfully!" : "Plugin disabled successfully!",
      });
    } catch (error) {
      console.error("Error toggling plugin:", error);
      return res.status(500).json({ success: false, message: "Internal server error." });
    }
  }

  async fetchTermsOfService(req, res) {
    const { token } = req.body || {};
    if (!token) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }
    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success || !auth.admin) {
        return res.json({ success: false, message: auth.message });
      }
      if (auth.admin.role !== "superuser") {
        return res.json({ success: false, message: "Unauthorised!" });
      }
      const platformID = auth.admin.platformID;
      const plugin = await this.db.getPlatformPlugin(platformID, "terms-of-service");
      if (!plugin) {
        return res.json({ success: false, message: "Terms plugin is not enabled." });
      }
      const terms = await this.db.getPlatformTerms(platformID);
      return res.json({
        success: true,
        message: "Terms fetched successfully",
        terms: terms || null,
      });
    } catch (error) {
      console.error("Error fetching terms:", error);
      return res.status(500).json({ success: false, message: "Internal server error." });
    }
  }

  async saveTermsOfService(req, res) {
    const { token, title, content } = req.body || {};
    if (!token || !title || !content) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }
    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success || !auth.admin) {
        return res.json({ success: false, message: auth.message });
      }
      if (auth.admin.role !== "superuser") {
        return res.json({ success: false, message: "Unauthorised!" });
      }
      const platformID = auth.admin.platformID;
      const plugin = await this.db.getPlatformPlugin(platformID, "terms-of-service");
      if (!plugin) {
        return res.json({ success: false, message: "Terms plugin is not enabled." });
      }
      const saved = await this.db.upsertPlatformTerms(platformID, { title, content });
      return res.json({
        success: true,
        message: "Terms saved successfully",
        terms: saved,
      });
    } catch (error) {
      console.error("Error saving terms:", error);
      return res.status(500).json({ success: false, message: "Internal server error." });
    }
  }

  async fetchPublicTerms(req, res) {
    const { platformID } = req.body || {};
    if (!platformID) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }
    try {
      const plugin = await this.db.getPlatformPlugin(platformID, "terms-of-service");
      if (!plugin) {
        return res.json({ success: false, message: "Terms not available." });
      }
      const terms = await this.db.getPlatformTerms(platformID);
      return res.json({
        success: true,
        message: "Terms fetched successfully",
        terms: terms || null,
      });
    } catch (error) {
      console.error("Error fetching public terms:", error);
      return res.status(500).json({ success: false, message: "Internal server error." });
    }
  }

  async managerFetchServices(req, res) {
    const { token } = req.body || {};
    if (!token) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }
    try {
      const session = await this.authManagerSession(token);
      if (!session.success) {
        return res.json({ success: false, message: session.message });
      }
      const services = await this.db.getSystemServices();
      return res.json({
        success: true,
        message: "Services fetched successfully!",
        services,
      });
    } catch (error) {
      console.error("Error fetching services:", error);
      return res.status(500).json({ success: false, message: "Internal server error." });
    }
  }

  async managerAddService(req, res) {
    const { token, key, name, price, currency, period, description, isPlugin } = req.body || {};
    if (!token || !key || !name || !price || !currency || !period || !description) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }
    try {
      const session = await this.authManagerSession(token);
      if (!session.success) {
        return res.json({ success: false, message: session.message });
      }
      const existing = await this.db.getSystemServiceByKey(key);
      if (existing) {
        return res.json({ success: false, message: "Service key already exists." });
      }
      const service = await this.db.createSystemService({
        key,
        name,
        price: String(price),
        currency,
        period,
        description,
        isPlugin: Boolean(isPlugin),
      });
      return res.json({
        success: true,
        message: "Service created successfully!",
        service,
      });
    } catch (error) {
      console.error("Error creating service:", error);
      return res.status(500).json({ success: false, message: "Internal server error." });
    }
  }

  async managerUpdateService(req, res) {
    const { token, key, name, price, currency, period, description, isPlugin } = req.body || {};
    if (!token || !key) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }
    try {
      const session = await this.authManagerSession(token);
      if (!session.success) {
        return res.json({ success: false, message: session.message });
      }
      const existing = await this.db.getSystemServiceByKey(key);
      if (!existing) {
        return res.json({ success: false, message: "Service not found." });
      }
      const updated = await this.db.updateSystemService(key, {
        ...(name !== undefined ? { name } : {}),
        ...(price !== undefined ? { price: String(price) } : {}),
        ...(currency !== undefined ? { currency } : {}),
        ...(period !== undefined ? { period } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(isPlugin !== undefined ? { isPlugin: Boolean(isPlugin) } : {}),
      });
      return res.json({
        success: true,
        message: "Service updated successfully!",
        service: updated,
      });
    } catch (error) {
      console.error("Error updating service:", error);
      return res.status(500).json({ success: false, message: "Internal server error." });
    }
  }

  async managerDeleteService(req, res) {
    const { token, key } = req.body || {};
    if (!token || !key) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }
    try {
      const session = await this.authManagerSession(token);
      if (!session.success) {
        return res.json({ success: false, message: session.message });
      }
      const existing = await this.db.getSystemServiceByKey(key);
      if (!existing) {
        return res.json({ success: false, message: "Service not found." });
      }
      await this.db.deleteSystemService(key);
      return res.json({
        success: true,
        message: "Service deleted successfully!",
      });
    } catch (error) {
      console.error("Error deleting service:", error);
      return res.status(500).json({ success: false, message: "Internal server error." });
    }
  }

  async fetchAdmins(req, res) {

    const { token } = req.body;

    try {
      const session = await this.authManagerSession(token);
      if (!session.success) {
        return res.json({
          success: false,
          message: session.message,
        });
      }
      const cacheKey = "main:admins:all";
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return res.json(cached);
      }
      const admins = await this.db.getAdminsWithPlatforms();
      const response = {
        success: true,
        message: "Admins fetched!",
        admins: admins,
      };
      this.cache.set(cacheKey, response, 30000);
      return res.json(response);
    } catch (error) {
      console.log("An error occured", error);
      return res.json({ success: false, message: "An error occured" });
    }

  }

  async updateAdmin(req, res) {

    const { token, id, name, email, phone, password, role, adminID, platformID } = req.body;
    if (!token || !id || !email || !role) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const session = await this.authManagerSession(token);
      if (!session.success) {
        return res.json({
          success: false,
          message: session.message,
        });
      }

      const existing = await this.db.getAdminByID(id);
      if (!existing) {
        return res.json({
          success: false,
          message: "Admin not found!",
        });
      }

      const data = {
        name: name,
        email: email,
        phone: phone,
        role: role,
      };

      if (adminID) data.adminID = adminID;
      if (platformID) data.platformID = platformID;

      if (password) {
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);
        data.password = hashedPassword;
      }

      await this.db.updateAdmin(id, data);
      this.cache.del("main:admins:all");
      return res.json({ success: true, message: "Admin updated" });
    } catch (error) {
      console.log("An error occured", error);
      return res.json({ success: false, message: "An error occured" });
    }

  }

  async deleteAdmin(req, res) {

    const { token, id } = req.body;
    if (!token || !id) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const session = await this.authManagerSession(token);
      if (!session.success) {
        return res.json({
          success: false,
          message: session.message,
        });
      }

      const existing = await this.db.getAdminByID(id);
      if (!existing) {
        return res.json({
          success: false,
          message: "Admin not found!",
        });
      }

      await this.db.deleteAdmin(id);
      this.cache.del("main:admins:all");
      return res.json({ success: true, message: "Admin deleted" });
    } catch (error) {
      console.log("An error occured", error);
      return res.json({ success: false, message: "An error occured" });
    }

  }

  async addAdmin(res, req) {

    const { platformID, adminID, phone, email, password, name } = req.body;
    try {
      if ((!platformID || !adminID || !phone || !email || !password || !name)) {
        return res.json({
          success: false,
          message: "Missing credentials are required!",
        });
      }
      const token = this.generateToken(adminID, platformID);
      const saltRounds = 10;
      const hashedPassword = await bcrypt.hash(password, saltRounds);
      const addadmin = await this.db.createAdmin({
        platformID: platformID,
        adminID: adminID,
        phone: phone,
        email: email,
        password: hashedPassword,
        name: name,
        token: token,
      });
      return res.json({ success: true, message: "Admin added!" });
    } catch (error) {
      console.log("An error occured", error);
      return res.json({ success: false, message: "An error occured" });
    }

  }

  async LoginAdmin(req, res) {

    const { email, password, device, ip } = req.body;

    if (!email || !password) {
      return res.json({
        success: false,
        message: "Email and password are required!",
      });
    }

    try {
      const user = await this.db.getAdminByEmail(email);
      if (!user) {
        const superUser = await this.db.getSuperUserByEmailAndPassword(email, password);
        if (!superUser) {
          return res.json({
            success: false,
            message: "Email does not exist!",
          });
        }

        const rawHost =
          req.headers["x-forwarded-host"] ||
          req.headers["host"] ||
          "";
        const host = String(rawHost).split(",")[0].trim().replace(/:\d+$/, "");
        const platform =
          await this.db.getPlatformByURLData(host) ||
          await this.db.getPlatformByDomain(host);

        if (!platform) {
          return res.json({
            success: false,
            message: "Platform does not exist!",
          });
        }

        const token = this.generateToken(superUser.id, platform.platformID);
        await this.db.createSession({
          token,
          adminID: superUser.id,
          platformID: platform.platformID,
          device,
          ip,
        });

        return res.json({
          success: true,
          message: "Login successful!",
          token,
          user: {
            id: superUser.id,
            adminID: superUser.id,
            platformID: platform.platformID,
            role: "superuser",
            email: superUser.email,
            name: superUser.name || superUser.email,
            level: "2",
          },
          domain: platform.url,
          url: platform.domain,
        });
      }
      const isPasswordValid = await bcrypt.compare(password, user.password);
      if (!isPasswordValid) {
        return res.json({
          success: false,
          message: "Invalid password!",
        });
      }

      const twoFA = await this.db.getTwoFaByAdminID(user.id);
      if (twoFA && twoFA.enabled) {
        const verifyOTPtoken = jwt.sign({ adminID: user.id }, process.env.JWT_SECRET || "", { expiresIn: "10m" });
        return res.json({
          success: true,
          message: "2FA required",
          twofa: true,
          verifyOTPtoken,
        });
      }

      const serverIp = Utils.getClientIp(req);
      console.log("Server IP", serverIp);

      const token = this.generateToken(user.adminID, user.platformID);
      await this.db.createSession({
        token: token,
        adminID: user.id,
        platformID: user.platformID,
        device,
        ip
      });
      await this.db.updateAdmin(user.id, { token: token });
      const platform = await this.db.getPlatform(user.platformID);
      if (!platform) {
        return res.json({
          success: false,
          message: "Platform does not exist!",
        });
      }
      const domain = platform.url;
      const url = platform.domain
      return res.json({
        success: true,
        message: "Login successful!",
        token: token,
        user,
        domain,
        url
      });
    } catch (error) {
      console.error("Login error:", error);
      return res.json({
        success: false,
        message: "Internal server error",
      });
    }

  }

  async fetchPayments(req, res) {

    const { token } = req.body;

    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    const auth = await this.AuthenticateRequest(token);
    if (!auth.success) {
      return res.json({
        success: false,
        message: auth.message,
      });
    }

    const platformID = auth.admin.platformID;
    if (!platformID) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const cacheKey = `main:payments:today:${platformID}`;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return res.json(cached);
      }
      const [users, payments] = await Promise.all([
        this.db.getUserByPlatformToday(platformID),
        this.db.getMpesaPaymentsToday(platformID),
      ]);

      const stationMap = new Map(
        users.map((u) => [
          String(u.code || u.username || u.password),
          u.package?.routerHost || null
        ])
      );

      const userCodes = new Map(
        users.map((u) => [String(u.code || u.username || u.password), u.status])
      );

      const enrichedPayments = payments.map((p) => {
        const codeStr = String(p.code);
        const userStatus = userCodes.get(codeStr);
        const hasCode = userStatus !== undefined;

        return {
          ...p,
          station: p.package?.routerHost,
          isUser: p.status === "COMPLETE" && p.service === "hotspot" && hasCode,
          isExpired:
            p.status === "COMPLETE" && p.service === "hotspot" && hasCode
              ? userStatus === 'expired'
              : false,
        };
      });

      const response = {
        success: true,
        message: "Payments fetched",
        payments: enrichedPayments,
      };
      this.cache.set(cacheKey, response, 20000);
      return res.json(response);
    } catch (error) {
      console.log("An error occurred", error);
      return res.json({ success: false, message: "An error occurred" });
    }

  }

  async fetchRecentPayments(req, res) {
    const { token, limit } = req.body || {};
    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    const auth = await this.AuthenticateRequest(token);
    if (!auth.success) {
      return res.json({
        success: false,
        message: auth.message,
      });
    }

    const platformID = auth.admin.platformID;
    if (!platformID) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const payments = await this.db.getRecentMpesaPayments(platformID, limit || 5);
      return res.json({
        success: true,
        message: "Recent payments fetched",
        payments,
      });
    } catch (error) {
      console.log("An error occurred", error);
      return res.json({ success: false, message: "An error occurred" });
    }
  }

  async exportPaymentsCsv(req, res) {
    const { token } = req.body || {};
    if (!token) {
      return res.status(400).json({ success: false, message: "Missing credentials required!" });
    }

    const auth = await this.AuthenticateRequest(token);
    if (!auth.success) {
      return res.status(401).json({ success: false, message: auth.message });
    }

    const platformID = auth.admin.platformID;
    if (!platformID) {
      return res.status(400).json({ success: false, message: "Missing credentials required!" });
    }

    const csvEscape = (value) => {
      if (value === null || value === undefined) return "";
      const str = String(value);
      if (/[",\n]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=payments_export.csv");

    res.write("Phone,Code,Amount,Status,Created At,Last Updated\n");

    const batchSize = 500;
    let cursorId = null;
    while (true) {
      const rows = await this.db.getMpesaPaymentsBatch(platformID, cursorId, batchSize);
      if (!rows || rows.length === 0) break;
      for (const row of rows) {
        const line = [
          csvEscape(row.phone),
          csvEscape(row.code),
          csvEscape(row.amount),
          csvEscape(row.status),
          csvEscape(row.createdAt?.toISOString ? row.createdAt.toISOString() : row.createdAt),
          csvEscape(row.updatedAt?.toISOString ? row.updatedAt.toISOString() : row.updatedAt),
        ].join(",") + "\n";
        res.write(line);
      }
      cursorId = rows[rows.length - 1].id;
      if (rows.length < batchSize) break;
    }
    return res.end();
  }

  async exportUsersCsv(req, res) {
    const { token } = req.body || {};
    if (!token) {
      return res.status(400).json({ success: false, message: "Missing credentials required!" });
    }

    const auth = await this.AuthenticateRequest(token);
    if (!auth.success) {
      return res.status(401).json({ success: false, message: auth.message });
    }

    const platformID = auth.admin.platformID;
    if (!platformID) {
      return res.status(400).json({ success: false, message: "Missing credentials required!" });
    }

    const csvEscape = (value) => {
      if (value === null || value === undefined) return "";
      const str = String(value);
      if (/[",\n]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=users_export.csv");

    res.write("Phone,Code,Status,Created At\n");

    const batchSize = 500;
    let cursorId = null;
    while (true) {
      const rows = await this.db.getUsersBatch(platformID, cursorId, batchSize);
      if (!rows || rows.length === 0) break;
      for (const row of rows) {
        const line = [
          csvEscape(row.phone),
          csvEscape(row.username || row.code),
          csvEscape(row.status),
          csvEscape(row.createdAt?.toISOString ? row.createdAt.toISOString() : row.createdAt),
        ].join(",") + "\n";
        res.write(line);
      }
      cursorId = rows[rows.length - 1].id;
      if (rows.length < batchSize) break;
    }
    return res.end();
  }

  async fetchModerators(req, res) {

    const { token } = req.body;
    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }
    const auth = await this.AuthenticateRequest(token);
    if (!auth.success) {
      return res.json({
        success: false,
        message: auth.message,
      });
    }
    if (auth.admin.role !== "superuser") {
      return res.json({
        success: false,
        message: "Unauthorised!",
      });
    }

    const adminID = auth.admin.adminID;
    if (!adminID) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }
    try {
      const cacheKey = `main:moderators:${adminID}`;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return res.json(cached);
      }
      const moderators = await this.db.getAdminsByID(adminID);
      const response = {
        success: true,
        message: "Moderators fetched",
        moderators: moderators,
      };
      this.cache.set(cacheKey, response, 60000);
      return res.json(response);
    } catch (error) {
      console.log("An error occured", error);
      return res.json({ success: false, message: "An error occured" });
    }

  }

  async fetchCodes(req, res) {

    const { token, limit: limitInput, offset: offsetInput } = req.body;
    const limit = Math.min(Math.max(Number(limitInput) || 100, 1), 100);
    const offset = Math.max(Number(offsetInput) || 0, 0);

    if (!token) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }

    const auth = await this.AuthenticateRequest(token);
    if (!auth.success) {
      return res.json({ success: false, message: auth.message });
    }

    const platformID = auth.admin.platformID;
    if (!platformID) {
      return res.json({ success: false, message: "Missing credentials required 3!" });
    }

    try {
      const cacheKey = `main:codes:today:${platformID}:${limit}:${offset}`;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return res.json(cached);
      }
      const stations = await this.db.getStations(platformID);
      const codes = await this.db.getUserByPlatformToday(platformID);

      let allActiveUsers = [];
      let mikrotikFailed = true;

      for (const station of stations) {
        const activeRes = await this.mikrotik.checkHotspotUserStatus(platformID, station.mikrotikHost);
        if (activeRes.success) {
          mikrotikFailed = false;
          allActiveUsers = allActiveUsers.concat(activeRes.users);
        }
      }

      if (mikrotikFailed) {
        const newCodes = await Promise.all(
          codes.map(async (code) => {
            const pkg = code.package;
            return {
              ...code,
              station: pkg?.routerHost,
              package: pkg?.name,
              active: "Offline",
            };
          })
        );

        const response = {
          success: true,
          message: "MikroTik unreachable, forced Offline for all",
          codes: newCodes,
        };
        this.cache.set(cacheKey, response, 15000);
        return res.json(response);
      }

      const newCodes = [];
      for (const code of codes) {
        const pkg = code.package;
        if (code.status !== "active") {
          newCodes.push({
            ...code,
            station: pkg?.routerHost,
            package: pkg?.name,
            active: "Offline",
          });
          continue;
        }

        const isActive = allActiveUsers.some(u => u.user === code.username);
        newCodes.push({
          ...code,
          station: pkg?.routerHost,
          package: pkg?.name,
          active: isActive ? "Online" : "Offline",
        });
      }

      const total = newCodes.length;
      const pagedCodes = newCodes.slice(offset, offset + limit);
      const response = {
        success: true,
        message: "Codes fetched",
        codes: pagedCodes,
        total,
        limit,
        offset,
      };
      this.cache.set(cacheKey, response, 15000);
      return res.json(response);

    } catch (error) {
      console.error("An error occurred", error);
      return res.json({
        success: false,
        message: "An error occurred",
      });
    }

  }

  async fetchPackages(req, res) {

    const { token } = req.body;
    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }
    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }
      if (auth.admin.role !== "superuser" && auth.admin.role !== "admin") {
        return res.json({
          success: false,
          message: "Unauthorised!",
        });
      }
      const platformID = auth.admin.platformID;
      if (!platformID) {
        return res.json({
          success: false,
          message: "Missing credentials required!",
        });
      }
      const cacheKey = `main:packages:${platformID}`;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return res.json(cached);
      }
      const packages = await this.db.getPackagesByPlatformID(platformID);
      const config = await this.db.getPlatformConfig(platformID);
      if (config?.mpesaShortCodeType?.toLowerCase() === "paybill" && Array.isArray(packages)) {
        for (const pkg of packages) {
          if (!pkg.accountNumber) {
            const accountNumber = await this.generatePackageAccountNumber(platformID);
            await this.db.updatePackage(pkg.id, platformID, { accountNumber });
            pkg.accountNumber = accountNumber;
          }
        }
      }
      this.logPlatform(platformID, "Packages fetched", {
        context: "packages",
        level: "success",
        total: packages?.length || 0,
      });
      const response = {
        success: true,
        message: "packages fetched",
        packages: packages,
      };
      this.cache.set(cacheKey, response, 60000);
      return res.json(response);
    } catch (error) {
      console.log("An error occured", error);
      if (token) {
        try {
          const auth = await this.AuthenticateRequest(token);
          if (auth?.admin?.platformID) {
            this.logPlatform(auth.admin.platformID, `Fetch packages failed: ${error.message || error}`, {
              context: "packages",
              level: "error",
            });
          }
        } catch { }
      }
      return res.json({ success: false, message: "An error occured" });
    }

  }

  async fetchSettings(req, res) {

    const { token } = req.body; if (!token) {
      return res.json({
        success: false, message: "Missing credentials required!",
      });
    }
    const auth = await this.AuthenticateRequest(token);
    if (!auth.success) {
      return res.json({
        success: false,
        message: auth.message,
      });
    }
    const platformID = auth.admin.platformID;
    if (!platformID) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }
    try {
      const cacheKey = `main:settings:${platformID}:${auth.admin.role}`;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return res.json(cached);
      }
      const platform = await this.db.getPlatform(platformID);

      let name = "";
      let url = "";
      let domain = "";
      let platform_id = "";
      if (platform) {
        name = platform.name;
        url = platform.url;
        platform_id = platform.id;
        domain = platform.domain;
      }

      if (auth.admin.role !== "superuser") {
        const limitedResponse = {
          domain,
          success: true,
          message: "Settings fetched",
          name,
          url,
          settings: { name },
          platform_id,
        };
        this.cache.set(cacheKey, limitedResponse, 300000);
        return res.json(limitedResponse);
      }

      const settings = await this.db.getPlatformConfig(platformID);

      const proto = (req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
      const host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
      const baseUrl = host ? `${proto}://${host}` : "";

      const normalizeBrandingImage = (value) => {
        if (!value) return "";
        if (/^https?:\/\//i.test(value)) return value;
        if (!baseUrl) return value;
        return value.startsWith("/") ? `${baseUrl}${value}` : `${baseUrl}/${value}`;
      };

      const platformSettings = settings || {
        mpesaConsumerKey: "",
        mpesaConsumerSecret: "",
        mpesaShortCode: "",
        mpesaShortCodeType: "Phone",
        mpesaPassKey: "",
        mpesaC2BShortCode: "",
        mpesaC2BShortCodeType: "Till",
        mpesaC2BAccountNumber: "",
        adminID: "",
        IsC2B: true,
        IsAPI: false,
        IsB2B: false,
        supportPhone: "",
        brandingImage: ""
      };

      platformSettings.brandingImage = normalizeBrandingImage(platformSettings.brandingImage);

      const response = {
        domain,
        success: true,
        message: "Settings fetched",
        name,
        url,
        settings: platformSettings,
        platform_id
      };
      this.cache.set(cacheKey, response, 300000);
      return res.json(response);
    } catch (error) {
      console.log("An error occurred", error);
      return res.json({ success: false, message: "An error occurred" });
    }

  }

  async updateSettings(req, res) {

    const { token } = req.body;
    const data = req.body?.data || req.body || {};
    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }
    const auth = await this.AuthenticateRequest(token);
    if (!auth.success) {
      return res.json({
        success: false,
        message: auth.message,
      });
    }
    if (auth.admin.role !== "superuser") {
      return res.json({
        success: false,
        message: "Unauthorised!",
      });
    }
    const platformID = auth.admin.platformID;
    const adminID = auth.admin.adminID;
    if (!platformID) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }
    const {
      mpesaConsumerKey,
      mpesaConsumerSecret,
      mpesaShortCode,
      mpesaShortCodeType,
      mpesaAccountNumber,
      mpesaC2BShortCode,
      mpesaC2BShortCodeType,
      mpesaC2BAccountNumber,
      mpesaPassKey,
      IsC2B,
      IsAPI,
      IsB2B,
      supportPhone,
      brandingImage,
    } = data;
    try {
      const existingConfig = await this.db.getPlatformConfig(platformID);
      if (IsC2B === true) {
        if (!mpesaC2BShortCode || !mpesaC2BShortCodeType || !adminID) {
          return res.json({
            success: false,
            message: "All MPESA fields must be filled out!",
          });
        }
        if (String(mpesaC2BShortCodeType).toLowerCase() === "paybill" && !mpesaC2BAccountNumber) {
          return res.json({
            success: false,
            message: "Account Number is required for Paybill!",
          });
        }
      } else if (IsAPI === true) {
        if (!mpesaConsumerKey || !mpesaConsumerSecret || !mpesaShortCode || !mpesaShortCodeType || !mpesaPassKey || !adminID) {
          return res.json({
            success: false,
            message: "All MPESA fields must be filled out!",
          });
        }
      } else if (IsB2B === true) {
        if (!mpesaShortCode || !mpesaShortCodeType || !adminID) {
          return res.json({
            success: false,
            message: "All MPESA fields must be filled out!",
          });
        }
      }
      if (!existingConfig) {
        const add = await this.db.createPlatformConfig(platformID, data);
        await this.refreshDashboardStats(platformID, { role: auth.admin.role });
        this.cache.del(`main:settings:${platformID}`);
        return res.json({
          success: true,
          message: "Platform Settings created.",
        });
      }

      const updatedConfig = await this.db.updatePlatformConfig(platformID, data);
      await this.refreshDashboardStats(platformID, { role: auth.admin.role });
      this.cache.del(`main:settings:${platformID}`);
      return res.json({
        success: true,
        message: "Platform Settings updated.",
      });
    } catch (error) {
      console.log("An error occured", error);
      return res.json({ success: false, message: "An error occured" });
    }

  }

  async saveBrandingSupport(req, res) {
    const { token, supportPhone = "", brandingImage = "" } = req.body || {};
    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }
    const auth = await this.AuthenticateRequest(token);
    if (!auth.success) {
      return res.json({
        success: false,
        message: auth.message,
      });
    }
    if (auth.admin.role !== "superuser") {
      return res.json({
        success: false,
        message: "Unauthorised!",
      });
    }
    const platformID = auth.admin.platformID;
    const adminID = auth.admin.adminID;
    if (!platformID) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }
    try {
      const payload = {
        supportPhone,
        brandingImage,
      };
      const existingConfig = await this.db.getPlatformConfig(platformID);
      if (!existingConfig) {
        await this.db.createPlatformConfig(platformID, {
          adminID,
          ...payload,
        });
      } else {
        await this.db.updatePlatformConfig(platformID, payload);
      }
      this.cache.del(`main:settings:${platformID}`);
      return res.json({
        success: true,
        message: "Branding & support updated.",
      });
    } catch (error) {
      console.log("An error occured", error);
      return res.json({ success: false, message: "An error occured" });
    }
  }

  async addSettings(req, res) {

    const { data, platformID } = req.body;
    if (!platformID) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }
    try {
      const settings = await this.db.createPlatformConfig(platformID, data);
      await this.refreshDashboardStats(platformID);
      return res.json({ success: true, message: "settings added" });
    } catch (error) {
      console.log("An error occured", error);
      return res.json({ success: false, message: "An error occured" });
    }

  }

  async updatePackages(req, res) {

    const {
      token,
      id,
      adminID,
      platformID,
      name,
      period,
      price,
      speed,
      devices,
      usage,
      category,
      pool,
      station,
      host,
      profile,
      status
    } = req.body;
    // Validate required fields
    if (!token || !platformID || !adminID || !name || !period || !price || !speed || !devices || !usage || !category || !host || !station) {
      return res.json({
        success: false,
        message: "Missing required fields!",
      });
    }

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }
      if (auth.admin.role !== "superuser" && auth.admin.role !== "admin") {
        return res.json({
          success: false,
          message: "Unauthorised!",
        });
      }
      const platformID = auth.admin.platformID;
      if (!platformID) {
        return res.json({
          success: false,
          message: "Missing credentials required!",
        });
      }
      const pkg = await this.db.getPackagesByID(id);
      if (!pkg) {
        return res.status(404).json({
          success: false,
          message: "Package does not exist!",
        });
      }
      const stationRecord = (await this.db.getStations(platformID)).find((s) => s.mikrotikHost === host);
      const isRadius = stationRecord?.systemBasis === "RADIUS";
      const categoryValue = String(category || "").trim().toLowerCase();
      const requiresPool = !isRadius && categoryValue !== "homefibre";
      if (requiresPool && !pool) {
        return res.json({
          success: false,
          message: "Pool is required for API system basis.",
        });
      }

      if (profile && !isRadius) {
        const packagename = pkg.name;
        if (packagename !== name) {
          return res.json({ success: false, message: "Invalid update operation tried,mikrotik user profile name cannot be different from database name, try again!" });
        }
        const rateLimit = `${speed}M/${speed}M`;

        const profileUpdate = await this.mikrotik.updateMikrotikProfile(
          platformID,
          packagename,
          name,
          rateLimit,
          pool,
          host,
          devices,
          period,
        )
        if (!profileUpdate.success) {
          return res.json({
            success: false,
            message: `${profileUpdate.message}`
          });
        }
      }

      const config = await this.db.getPlatformConfig(platformID);
      const needsAccountNumber = config?.mpesaShortCodeType?.toLowerCase() === "paybill";
      const accountNumber = needsAccountNumber && !pkg.accountNumber
        ? await this.generatePackageAccountNumber(platformID)
        : pkg.accountNumber || "";

      const data = {
        adminID,
        platformID,
        name,
        period,
        price,
        speed,
        devices,
        usage,
        category,
        routerHost: host,
        routerName: station,
        pool: isRadius ? "" : pool,
        status,
        accountNumber
      };

      const packages = await this.db.updatePackage(id, platformID, data);
      this.logPlatform(platformID, `Package updated: ${name}`, {
        context: "packages",
        level: "success",
      });
      await this.refreshDashboardStats(platformID, { role: auth.admin.role });
      return res.json({ success: true, message: "Package updated", package: packages });
    } catch (error) {
      console.log("An error occured", error);
      if (req?.body?.platformID) {
        this.logPlatform(req.body.platformID, `Package update failed: ${error.message || error}`, {
          context: "packages",
          level: "error",
        });
      }
      return res.json({ success: false, message: "An error occured" });
    }

  }

  async addPackages(req, res) {

    const {
      token,
      platformID,
      adminID,
      name,
      period,
      price,
      speed,
      devices,
      usage,
      category,
      pool,
      station,
      host,
      profile,
      status,
      social
    } = req.body;

    if (!token || !status || !platformID || !adminID || !name || !period || !price || !speed || !category || !host || !station) {
      return res.json({
        success: false,
        message: "Missing required fields!",
      });
    }

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }
      if (auth.admin.role !== "superuser" && auth.admin.role !== "admin") {
        return res.json({
          success: false,
          message: "Unauthorised!",
        });
      }
      const platformID = auth.admin.platformID;
      if (!platformID) {
        return res.json({
          success: false,
          message: "Missing credentials required!",
        });
      }

      const stationRecord = (await this.db.getStations(platformID)).find((s) => s.mikrotikHost === host);
      const isRadius = stationRecord?.systemBasis === "RADIUS";
      const categoryValue = String(category || "").trim().toLowerCase();
      const requiresPool = !isRadius && categoryValue !== "homefibre";
      if (requiresPool && !pool) {
        return res.json({
          success: false,
          message: "Pool is required for API system basis.",
        });
      }

      const safeDevices = devices && String(devices).trim() ? devices : "1";
      const safeUsage = usage && String(usage).trim() ? usage : "Unlimited";

      let profileCreation;
      if (!profile && requiresPool) {
        const rateLimit = `${speed}M/${speed}M`;
        profileCreation = await this.mikrotik.createMikrotikProfile(
          platformID,
          name,
          rateLimit,
        pool,
        host,
        safeDevices,
        period,
        category
      );

        if (!profileCreation.success) {
          return res.json({
            success: false,
            message: `Profile creation failed: ${profileCreation.message}`
          });
        }
      }

      const profilexists = await this.db.getPackagesByName(name, platformID);

      if (profilexists && profilexists.routerHost === host) {
        return res.json({
          success: false,
          message: "Package name already exists, choose another name!",
        })
      }

      const config = await this.db.getPlatformConfig(platformID);
      const needsAccountNumber = config?.mpesaShortCodeType?.toLowerCase() === "paybill";
      const accountNumber = needsAccountNumber ? await this.generatePackageAccountNumber(platformID) : "";

      const packageData = {
        adminID,
        platformID,
        name,
        period,
        price,
        speed,
        devices: safeDevices,
        usage: safeUsage,
        category,
        routerHost: host,
        routerName: station,
        pool: isRadius ? "" : pool,
        status,
        social,
        accountNumber
      };

      const newPackage = await this.db.createPackage(packageData);

      this.cache.delPrefix(`main:search:${platformID}:packages:`);
      this.logPlatform(platformID, `Package created: ${name}`, {
        context: "packages",
        level: "success",
      });
      await this.refreshDashboardStats(platformID, { role: auth.admin.role });
      return res.json({
        success: true,
        message: "Package and MikroTik profile created successfully",
        package: newPackage,
        mikrotikProfile: profileCreation
      });

    } catch (error) {
      console.error("Package creation error:", error);
      if (req?.body?.platformID) {
        this.logPlatform(req.body.platformID, `Package creation failed: ${error.message || error}`, {
          context: "packages",
          level: "error",
        });
      }
      return res.json({
        success: false,
        message: error.message || "Package creation failed",
        error: error.toString()
      });
    }

  }

  async deletePackages(req, res) {

    const { token, id, platformID, host } = req.body;

    if (!token || !id || !platformID) {
      return res.status(400).json({
        success: false, message: "Missing credentials required!",
      });
    }
    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }
      if (auth.admin.role !== "superuser") {
        return res.json({
          success: false,
          message: "Unauthorised!",
        });
      }
      const platformID = auth.admin.platformID;
      if (!platformID) {
        return res.json({
          success: false,
          message: "Missing credentials required!",
        });
      }
      const pkg = await this.db.getPackagesByID(id);
      if (!pkg) {
        return res.status(404).json({ success: false, message: "Package does not exist!", });
      }
      const packagename = pkg.name;
      const delResult = await this.db.deletePackage(id);
      if (!delResult) {
        return res.status(500).json({
          success: false,
          message: "Failed to delete package from database.",
        });
      }
      const stationRecord = (await this.db.getStations(platformID)).find((s) => s.mikrotikHost === host);
      const isRadius = stationRecord?.systemBasis === "RADIUS";
      if (!isRadius) {
        const delProfileResult = await this.mikrotik.deleteMikrotikProfile(platformID, packagename, host);
        if (!delProfileResult.success) {
          return res.status(500).json({
            success: false,
            message: `Failed to delete MikroTik profile: ${delProfileResult.message}`,
          });
        }
      }
      this.logPlatform(platformID, `Package deleted: ${packagename}`, {
        context: "packages",
        level: "success",
      });
      await this.refreshDashboardStats(platformID, { role: auth.admin.role });
      return res.json({
        success: true,
        message: "Package deleted successfully."
      });
    } catch (error) {
      console.error("An error occurred while deleting package:", error);
      if (req?.body?.platformID) {
        this.logPlatform(req.body.platformID, `Package delete failed: ${error.message || error}`, {
          context: "packages",
          level: "error",
        });
      }
      return res.status(500).json({
        success: false,
        message: "An internal server error occurred.",
      });
    }

  }

  async updateCodes(req, res) {

    const { id, data } = req.body;
    if (!id) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }
    try {
      const codes = await this.db.updateUser(id, data);
      if (codes?.platformID) {
        await this.refreshDashboardStats(codes.platformID);
      }
      return res.json({ success: true, message: "Codes updated" });
    } catch (error) {
      console.log("An error occured", error);
      return res.json({ success: false, message: "An error occured" });
    }

  }

  async deleteCodes(req, res) {

    const { id } = req.body;
    if (!id) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }
    try {
      const codes = await this.db.deleteUser(id);
      if (codes?.platformID) {
        this.cache.delPrefix(`main:search:${codes.platformID}:users:`);
        await this.refreshDashboardStats(codes.platformID);
      }
      return res.json({ success: true, message: "Code deleted" });
    } catch (error) {
      console.log("An error occured", error);
      return res.json({ success: false, message: "An error occured" });
    }

  }

  async updateModerators(req, res) {

    const { token, id, name, email, phone, password, role, adminID, platformID } =
      req.body;
    if (
      !token ||
      !id ||
      !email ||
      !password ||
      !role ||
      !adminID ||
      !platformID
    ) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }
    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }
      if (auth.admin.role !== "superuser") {
        return res.json({
          success: false,
          message: "Unauthorised!",
        });
      }

      const saltRounds = 10;
      const hashedPassword = await bcrypt.hash(password, saltRounds);

      const data = {
        name: name,
        email: email,
        phone: phone,
        password: hashedPassword,
        role: role,
        adminID: adminID,
        platformID: platformID,
      };
      const moderators = await this.db.updateAdmin(id, data);
      return res.json({ success: true, message: "Moderator updated" });
    } catch (error) {
      console.log("An error occured", error);
      return res.json({ success: false, message: "An error occured" });
    }

  }

  async deleteModerators(req, res) {

    const { id, token } = req.body;
    if (!id || !token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }
    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }
      if (auth.admin.role !== "superuser") {
        return res.json({
          success: false,
          message: "Unauthorised!",
        });
      }
      const moderators = await this.db.deleteAdmin(id);
      return res.json({ success: true, message: "Moderator deleted" });
    } catch (error) {
      console.log("An error occured", error);
      return res.json({ success: false, message: "An error occured" });
    }

  }

  async addModerators(req, res) {

    const { token, name, email, phone, password, role, adminID, platformID } = req.body;
    if (
      !token ||
      !email ||
      !password ||
      !role ||
      !adminID ||
      !platformID
    ) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }
    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }

      const admin = await this.db.getAdminByEmail(email);
      if (admin) {
        return res.json({
          success: false,
          message: "Email already exists!",
        });
      }
      const saltRounds = 10;
      const hashedPassword = await bcrypt.hash(password, saltRounds);
      const newtoken = this.generateToken(adminID, platformID);
      const moderators = await this.db.createAdmin({
        name,
        email,
        phone,
        password: hashedPassword,
        role,
        adminID,
        platformID,
        token: newtoken,
      });
      return res.json({ success: true, message: "Moderator added" });
    } catch (error) {
      console.log("An error occured", error);
      return res.json({ success: false, message: "An error occured" });
    }

  }

  async deletePayment(req, res) {

    const { token, id } = req.body;
    if (!token || !id) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }
    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }
      if (auth.admin.role !== "superuser") {
        return res.json({
          success: false,
          message: "Unauthorised!",
        });
      }
      const payment = await this.db.getMpesaByID(id);
      if (!payment) {
        return res.json({
          success: false,
          message: "Payment not found!",
        });
      }

      if ((payment.type).toLowerCase() === "withdrawal") {
        return res.json({
          success: false,
          message: "Cannot delete withdrawal payments!",
        });
      }

      if ((payment.type).toLowerCase() === "mpesa b2b") {
        return res.json({
          success: false,
          message: "Cannot delete B2B payments!",
        });
      }

      if ((payment.type).toLowerCase() === "bill") {
        return res.json({
          success: false,
          message: "Cannot delete bill payments!",
        });
      }

      const del = await this.db.deleteMpesaPayment(id);
      if (payment?.platformID) {
        await this.refreshDashboardStats(payment.platformID, { role: auth.admin.role });
      }
      return res.json({ success: true, message: "Payment deleted" });
    } catch (error) {
      console.log("An error occured", error);
      return res.json({ success: false, message: "An error occured" });
    }

  }

  async updateName(req, res) {

    const { token, name, url, domain } = req.body;
    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }
      if (auth.admin.role !== "superuser") {
        return res.json({
          success: false,
          message: "Unauthorised!",
        });
      }

      const resolves = await this.checkIfUrlResolves(domain);
      if (!resolves) {
        return res.status(400).json({
          success: false,
          message: `Domain does not point to ${process.env.SERVER_IP}`,
        });
      }

      const platformID = auth.admin.platformID;
      if (!platformID || !name || !url) {
        return res.status(400).json({
          success: false,
          message: "Missing required credentials!",
        });
      }

      const exists = await this.db.getPlatformByURLData(url);
      if (exists && exists.platformID !== platformID) {
        return res.status(409).json({
          success: false,
          message: "This Name and URL is already in use by another platform"
        });
      }

      const existingPlatform = await this.db.getPlatform(platformID);
      if (!existingPlatform) {
        return res.status(404).json({
          success: false,
          message: "Platform not found!"
        });
      }

      const existingDnsName = existingPlatform.url.replace(/^https?:\/\//, '').split('/')[0];
      const newDnsName = url.replace(/^https?:\/\//, '').split('/')[0];
      if (newDnsName !== existingDnsName) {
        const siteUser = Utils.generateRandomString();
        const siteUserPassword = Utils.generateRandomString();

        if (!siteUser || !siteUserPassword) {
          return res.json({
            success: false,
            message: "Internal error, missing critical configuration files, try again later"
          });
        }

        const delsite = await this.deleteSiteRecord(existingDnsName);
        if (!delsite.success) {
          return res.json({
            success: false,
            message: delsite.message
          });
        }

        const addProxy = await this.addReverseProxySite(url, `http://localhost:3001`);
        if (!addProxy.success) {
          return res.json({
            success: false,
            message: "Reverse proxy creation failed."
          });
        }

        const addSSL = await this.installLetsEncryptCert(url);
        if (!addSSL.success) {
          return res.json({
            success: false,
            message: addSSL.message
          });
        }
      } else if (domain !== "") {
        if (domain !== existingPlatform.domain) {
          const siteUser = Utils.generateRandomString();
          const siteUserPassword = Utils.generateRandomString();

          if (!siteUser || !siteUserPassword) {
            return res.json({
              success: false,
              message: "Internal error, missing critical configuration files, try again later"
            });
          }

          if (existingPlatform.domain !== "") {
            const delsite = await this.deleteSiteRecord(existingPlatform.domain);
            if (!delsite.success) {
              return res.json({
                success: false,
                message: delsite.message
              });
            }
          }

          const addProxy = await this.addReverseProxySite(domain, `http://localhost:3001`);
          if (!addProxy.success) {
            return res.json({
              success: false,
              message: "Reverse proxy creation failed."
            });
          }

          const addSSL = await this.installLetsEncryptCert(domain);
          if (!addSSL.success) {
            return res.json({
              success: false,
              message: addSSL.message
            });
          }
        }
      }

      const data = { name, url: newDnsName, domain };
      const upd = await this.db.updatePlatform(platformID, data);

      if (!upd) {
        return res.status(500).json({
          success: false,
          message: "Failed to update platform in database",
        });
      }

      return res.status(200).json({
        success: true,
        message: "Platform updated successfully",
        data: {
          name,
          url: newDnsName
        }
      });

    } catch (error) {
      console.error("Update error:", error);
      return res.status(500).json({
        success: false,
        message: "An unexpected error occurred during update"
      });
    }

  }

  async fetchStations(req, res) {

    const headerToken = String(req.headers.authorization || "")
      .replace(/^Bearer\s+/i, "")
      .trim();
    const token =
      req.body?.token ||
      req.query?.token ||
      req.headers["x-auth-token"] ||
      headerToken;
    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }

      const platformID = auth.admin.platformID;
      if (!platformID) {
        return res.json({
          success: false,
          message: "Missing credentials are required",
        });
      }

      const cacheKey = `main:stations:${platformID}`;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return res.json(cached);
      }
      const stations = await this.db.getStations(platformID);
      const response = {
        success: true,
        message: "Stations fetched",
        stations: stations,
      };
      this.cache.set(cacheKey, response, 60000);
      return res.json(response);
    } catch (error) {
      console.log("An error occurred", error);
      return res.json({ success: false, message: "An error occurred" });
    }

  }

  async updateStations(req, res) {

    const { data } = req.body;

    if (!data || !data.token) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }

    try {
      const auth = await this.AuthenticateRequest(data.token);
      if (!auth.success) {
        return res.json({ success: false, message: auth.message });
      }

      if (auth.admin.role !== "superuser") {
        return res.json({
          success: false,
          message: "Unauthorised!",
        });
      }

      const platformID = auth.admin.platformID;
      const adminID = auth.admin.adminID;

      const stationID = data.id;
      const {
        mikrotikPassword,
        mikrotikPublicHost,
        mikrotikHost,
        mikrotikPublicKey,
        mikrotikDDNS,
        name,
        id,
        systemBasis
      } = data;

      if (!name || !mikrotikHost || !mikrotikPublicKey) {
        return res.json({ success: false, message: "Missing required station details." });
      }

      const isEncryptedPassword =
        typeof mikrotikPassword === "string" &&
        mikrotikPassword.includes(":") &&
        mikrotikPassword.split(":")[0]?.length === 32;
      if (mikrotikPassword && !isEncryptedPassword) {
        data.mikrotikPassword = Utils.encryptPassword(mikrotikPassword);
      }

      data.platformID = platformID;
      data.adminID = adminID;
      const platformData = await this.db.getPlatform(platformID);
      if (!platformData) {
        return res.json({ success: false, message: "Platform doesn't exist." });
      }

      const platformURL = platformData.url;

      let station;
      if (stationID !== "") {
        station = await this.db.getStation(stationID);
      }

      let responseMessage;
      let stationResult;
      let WebfigHost;
      if (!station) {
        const stations = await this.db.getStations(platformID);

        // Generate webfig host only on create
        const sanitizeSubdomain = (value) => {
          const lettersOnly = String(value || "")
            .toLowerCase()
            .replace(/[^a-z]/g, "");
          const trimmed = lettersOnly.slice(0, 12);
          return trimmed || "router";
        };
        const randomness = Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 4) || "site";
        const baseDomain = process.env.DOMAIN || "novawifi.co.ke";
        const mikrotikWebfigHost = `${sanitizeSubdomain(name)}${randomness}.${baseDomain}`;
        data.mikrotikWebfigHost = mikrotikWebfigHost;
        WebfigHost = mikrotikWebfigHost

        // Check DDNS conflict
        if (mikrotikDDNS && mikrotikDDNS.trim()) {
          const normalizedDDNS = mikrotikDDNS.trim();
          const existingDnsName = stations.find(
            s => s.mikrotikDDNS?.trim() === normalizedDDNS
          );

          if (existingDnsName) {
            return res.json({
              success: false,
              message: "DDNS name is already being used by another router.",
            });
          }
        }

        // Check Host conflict
        if (mikrotikHost && mikrotikHost.trim()) {
          const normalizedHost = mikrotikHost.trim();
          const existingHost = stations.find(
            s => s.mikrotikHost?.trim() === normalizedHost
          );

          if (existingHost) {
            return res.json({
              success: false,
              message: "Internal Mikrotik Host address already exists, refresh your browser to get a unique one!",
            });
          }
        }

        const { id, token, ...newData } = data;
        if (systemBasis === "RADIUS") {
          const stations = await this.db.getStations(platformID);
          const existingNames = new Set(stations.map(s => s.radiusClientName).filter(Boolean));
          const base = `rad-${platformID.slice(0, 6)}`;
          const genName = () => `${base}-${Math.random().toString(16).slice(2, 8)}`;
          let radiusClientName = newData.radiusClientName || genName();
          while (existingNames.has(radiusClientName)) {
            radiusClientName = genName();
          }
          newData.radiusClientName = radiusClientName;
          newData.radiusClientSecret = newData.radiusClientSecret || crypto.randomBytes(12).toString("hex");
          const serverIp = (process.env.RADIUS_SERVER_IP || process.env.SERVER_IP || "").toString().split(":")[0];
          newData.radiusServerIp = serverIp;
        }
        const newStation = await this.db.createStation(newData);
        stationResult = newStation;
        responseMessage = "Station added";

      } else {
        const { id, token, ...updData } = data;
        if (systemBasis === "RADIUS") {
          const stations = await this.db.getStations(platformID);
          const existingNames = new Set(stations.map(s => s.radiusClientName).filter(Boolean));
          const base = `rad-${platformID.slice(0, 6)}`;
          const genName = () => `${base}-${Math.random().toString(16).slice(2, 8)}`;
          let radiusClientName = updData.radiusClientName || station?.radiusClientName || genName();
          while (existingNames.has(radiusClientName) && radiusClientName !== station?.radiusClientName) {
            radiusClientName = genName();
          }
          updData.radiusClientName = radiusClientName;
          updData.radiusClientSecret = updData.radiusClientSecret || station?.radiusClientSecret || crypto.randomBytes(12).toString("hex");
          const serverIp = (process.env.RADIUS_SERVER_IP || process.env.SERVER_IP || "").toString().split(":")[0];
          updData.radiusServerIp = serverIp;
        }
        const updatedStation = await this.db.updateStation(stationID, updData);
        stationResult = updatedStation;
        responseMessage = "Station updated";
      }

      const endpointHost = mikrotikDDNS || mikrotikPublicHost;
      if (!endpointHost) {
        return res.json({ success: false, message: "Public router host is required." });
      }
      const result = await this.resolveMikrotikHost(mikrotikPublicHost);
      if (!result.success) {
        return res.json({ success: false, message: result.message });
      }
      const resolvedIp = Array.isArray(result.addresses) && result.addresses.length > 0 ? result.addresses[0] : mikrotikPublicHost;
      if (systemBasis === "RADIUS") {
        await this.db.updateStation(stationResult.id, {
          radiusClientIp: resolvedIp || "",
        });
        const addResult = await ensureRadiusClient({
          name: stationResult.radiusClientName,
          ip: resolvedIp || "",
          secret: stationResult.radiusClientSecret,
          shortname: stationResult.name,
          server: stationResult.radiusServerIp || "",
          description: `Nova RADIUS client for ${stationResult.name}`,
        });
        if (!addResult?.success) {
          console.warn("[RADIUS] ensureRadiusClient failed", addResult?.message || addResult);
        }
      }

      const peerBlock = `
    [Peer]
    PublicKey = ${mikrotikPublicKey}
    Endpoint = ${endpointHost}:13231
    AllowedIPs = ${mikrotikHost}/32
    PersistentKeepalive = 10
    `.trim();

      const wgConfPath = "/etc/wireguard/wg0.conf";

      fs.readFile(wgConfPath, "utf8", (readErr, fileData) => {
        if (readErr) {
          return res.json({ success: false, message: "WireGuard config read failed." });
        }

        fs.copyFileSync(wgConfPath, `${wgConfPath}.bak-${Date.now()}`);

        const blocks = fileData.split(/\n(?=\[Peer\])/);

        const seenIPs = new Set();
        const seenKeys = new Set();

        const cleaned = blocks.reverse().filter(block => {
          const ipMatch = block.match(/AllowedIPs\s*=\s*(10\.10\.10\.\d+)\/32/);
          const keyMatch = block.match(/PublicKey\s*=\s*(.+)/);

          const internalIP = ipMatch?.[1];
          const publicKey = keyMatch?.[1];

          if (internalIP && seenIPs.has(internalIP)) return false;
          if (internalIP) seenIPs.add(internalIP);

          if (publicKey && seenKeys.has(publicKey)) return false;
          if (publicKey) seenKeys.add(publicKey);

          return true;
        }).reverse();

        cleaned.push(peerBlock);

        const newConfig = cleaned
          .map(b => b.trim())
          .join("\n\n") + "\n";

        fs.writeFile(wgConfPath, newConfig, async (writeErr) => {
          if (writeErr) {
            return res.json({ success: false, message: "WireGuard config write failed." });
          }

          exec(`sudo sed -i '/^[[:space:]]*$/d' ${wgConfPath}`, () => {
            exec(`sudo awk 'NF{print} END{print ""}' ${wgConfPath} > /tmp/wg.tmp && sudo mv /tmp/wg.tmp ${wgConfPath}`, () => {

              exec("sudo wg-quick down wg0", () => {
                exec("sudo wg-quick up wg0", async (upErr) => {

                  if (upErr) {
                    return res.json({ success: false, message: "WireGuard restart failed." });
                  }

                  if (!station) {
                    const siteUser = Utils.generateUsername();
                    const siteUserPassword = Utils.generateRandomString();
                    if (!siteUser || !siteUserPassword) {
                      return res.json({ success: false, message: "Internal configuration error" });
                    }

                    const addProxy = await this.addReverseProxySite(WebfigHost, `http://${mikrotikHost}`);
                    if (!addProxy.success) {
                      return res.json({ success: false, message: "Reverse proxy creation failed." });
                    }

                    // SSL handled via wildcard certificate; skip per-host install.
                  }

                  await this.refreshDashboardStats(platformID, { role: auth.admin.role });
                  return res.json({
                    success: true,
                    message: `${responseMessage} and WireGuard updated.`,
                    station: stationResult,
                  });
                });
              });

            });
          });

        });
      });

    } catch (error) {
      console.error("Station update error:", error);
      return res.json({ success: false, message: "Internal server error." });
    }

  }

  async getRadiusCredentials(req, res) {
    const { token } = req.body || {};
    if (!token) {
      return res.status(400).json({ success: false, message: "Missing credentials required!" });
    }
    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.status(401).json({ success: false, message: auth.message });
      }
      if (auth.admin.role !== "superuser") {
        return res.status(403).json({ success: false, message: "Unauthorised!" });
      }

      const platformID = auth.admin.platformID;
      const stations = await this.db.getStations(platformID);
      const existingNames = new Set(stations.map(s => s.radiusClientName).filter(Boolean));
      const base = `rad-${platformID.slice(0, 6)}`;
      const genName = () => `${base}-${crypto.randomBytes(3).toString("hex")}`;

      let radiusClientName = genName();
      while (existingNames.has(radiusClientName)) {
        radiusClientName = genName();
      }
      const radiusClientSecret = crypto.randomBytes(12).toString("hex");
      const radiusServerIp = (process.env.RADIUS_SERVER_IP || process.env.SERVER_IP || "").toString().split(":")[0];

      return res.json({
        success: true,
        message: "RADIUS credentials generated",
        radiusClientName,
        radiusClientSecret,
        radiusServerIp,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to generate RADIUS credentials" });
    }
  }

  async deleteStations(req, res) {

    const { token, id } = req.body;
    if (!token || !id) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({ success: false, message: auth.message });
      }

      if (auth.admin.role !== "superuser") {
        return res.json({
          success: false,
          message: "Unauthorised!",
        });
      }

      const station = await this.db.getStation(id);
      if (!station) {
        return res.json({ success: false, message: "Station not found" });
      }

      const zoneId = process.env.ZONE_ID;
      const apiToken = process.env.API_TOKEN;

      if (!zoneId || !apiToken) {
        return res.status(500).json({
          success: false,
          message: "Internal server configuration error",
        });
      }

      const mikrotikWebfigHost = station.mikrotikWebfigHost;
      if (mikrotikWebfigHost) {
        const delsite = await this.deleteSiteRecord(mikrotikWebfigHost);
        if (!delsite.success) {
          console.warn("Nginx site delete skipped:", delsite.message);
        }
      }

      const mikrotikPublicKey = station.mikrotikPublicKey;
      const shouldRemoveRadius = station.systemBasis === "RADIUS" || !!station.radiusClientName;
      const runSudo = (args = []) =>
        new Promise((resolve, reject) => {
          execFile("sudo", ["-n", ...args], (err, stdout, stderr) => {
            if (err) return reject(stderr || err.message);
            resolve(stdout);
          });
        });

      try {
        const wgConfig = await runSudo(["/bin/cat", "/etc/wireguard/wg0.conf"]);
        const peerBlocks = wgConfig.toString().split(/\n(?=\[Peer])/);
        const filteredBlocks = peerBlocks.filter(
          (block) => !block.includes(`PublicKey = ${mikrotikPublicKey}`)
        );
        const updatedConfig = filteredBlocks.join("\n").trim() + "\n";
        const tmpPath = `/tmp/wg0-${Date.now()}.conf`;
        await fsp.writeFile(tmpPath, updatedConfig, "utf8");
        await runSudo(["/bin/mv", tmpPath, "/etc/wireguard/wg0.conf"]);

        try {
          await runSudo(["/usr/bin/wg-quick", "down", "wg0"]);
        } catch (downErr) {
          console.warn("WireGuard down skipped:", downErr?.toString?.() || downErr);
        }
        await runSudo(["/usr/bin/wg-quick", "up", "wg0"]);

        const routerHost = station.mikrotikHost;
        if (shouldRemoveRadius) {
          try {
            if (station.radiusClientName) {
              const removeResult = await removeRadiusClient({ name: station.radiusClientName });
              if (!removeResult?.success) {
                console.warn("RADIUS client remove failed:", removeResult?.message || removeResult);
              }
            }

            const stationPackages = await this.db.getPackagesByHost(routerHost);
            const packageIds = new Set(
              Array.isArray(stationPackages) ? stationPackages.map((pkg) => pkg.id) : []
            );
            if (packageIds.size > 0) {
              const users = await this.db.getUsersByCodes(station.platformID);
              const stationUsers = Array.isArray(users)
                ? users.filter((u) => u.packageID && packageIds.has(u.packageID))
                : [];
              for (const user of stationUsers) {
                const username = user.username || user.code || user.phone;
                if (username) {
                  await this.db.deleteRadiusUser(username);
                }
              }
            }
          } catch (radiusErr) {
            console.warn("RADIUS cleanup skipped:", radiusErr?.toString?.() || radiusErr);
          }
        }

        const deleteAllPPPoE = await this.db.deletePPPoEByHost(routerHost)
        const deleteAllPackages = await this.db.deletePackagesByHost(routerHost)
        const deleteBackup = await this.db.deletePlatformMikrotikBackUpByHost(routerHost)

        const deletebackupfolder = await this.deleteBackupFolder(station.mikrotikHost);
        if (!deletebackupfolder?.success) {
          console.warn("Backup folder delete skipped:", deletebackupfolder?.message);
        }
        const deletedStation = await this.db.deleteStation(id);
        this.cache.del(`main:stations:${station.platformID}`);
        this.cache.del("main:stations:all");
        this.cache.delPrefix(`main:search:${station.platformID}:stations`);
        await this.refreshDashboardStats(station.platformID, { role: auth.admin.role });
        return res.json({
          success: true,
          message: "Station deleted and WireGuard updated",
          data: deletedStation,
        });
      } catch (err) {
        console.error("WireGuard update failed:", err);
        return res.json({
          success: false,
          message: "WireGuard update failed. Ensure sudo NOPASSWD for /bin/cat, /bin/mv, /usr/bin/wg-quick.",
          error: err?.toString?.() || err,
        });
      }

    } catch (error) {
      console.error("An error occurred", error);
      return res.json({ success: false, message: "An error occurred" });
    }

  }

  async addCode(req, res) {

    const { token, data } = req.body;
    if (!token || !data) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    const { code, phone, username, password, packageID, platformID } = data;

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({ success: false, message: auth.message });
      }

      if (auth.admin.role !== "superuser") {
        return res.json({
          success: false,
          message: "Unauthorised!",
        });
      }

      const pkg = await this.db.getPackagesByID(packageID);
      if (!pkg) {
        return res.json({
          success: false,
          message: "Failed to add user to MikroTik, Package not found!",
        });
      }
      const { expiresIn, expiresAtISO } = this.mpesa.computeExpiryFromPackage(pkg);

      const profileName = pkg.name;
      const hostdata = await this.db.getStations(platformID);
      if (!hostdata) {
        return res.json({
          success: false,
          message: "Failed to add user to MikroTik, Router not found!",
        });
      }
      const stationRecord = hostdata.find((s) => s.mikrotikHost === pkg.routerHost);
      const isRadius = stationRecord?.systemBasis === "RADIUS";
      if (code) {
        const codeexists = await this.db.getUserByCodeAndPlatform(code, platformID);
        if (codeexists) {
          return res.json({
            success: false,
            message: "Code already exists, try a different one!",
          });
        }
      }
      if (username) {
        const usernameExists = await this.db.getUserByUsernameAndPlatform(username, platformID);
        if (usernameExists) {
          return res.json({
            success: false,
            message: "Username already exists, try a different one!",
          });
        }
      }

      const host = pkg.routerHost;
      let addUserToMikrotik = { success: true, username: "", password: "" };
      let finalUsername = "";
      let finalPassword = "";

      if (code && code.trim()) {
        finalUsername = code;
        finalPassword = code;
      } else if (username && username.trim() && password && password.trim()) {
        finalUsername = username;
        finalPassword = password;
      } else {
        const generated = crypto.randomBytes(3).toString("hex").toUpperCase();
        finalUsername = generated;
        finalPassword = generated;
      }

      if (!isRadius) {
        const mikrotikData = {
          platformID,
          action: "add",
          profileName,
          host,
          code,
          password,
          username
        };

        addUserToMikrotik = await this.mikrotik.manageMikrotikUser(mikrotikData);
        if (!addUserToMikrotik) {
          return res.json({
            success: false,
            message: "Failed to add user to MikroTik",
          });
        }
        if (addUserToMikrotik.success) {
          finalUsername = addUserToMikrotik.username;
          finalPassword = addUserToMikrotik.password;
        }
      } else {
        const speedVal = String(pkg.speed || "").replace(/[^0-9.]/g, "");
        const rateLimit = speedVal ? `${speedVal}M/${speedVal}M` : "";
        let dataLimitBytes = null;
        if (String(pkg.category || "").toLowerCase() === "data" && pkg.usage && pkg.usage !== "Unlimited") {
          const [value, unit] = String(pkg.usage).split(" ");
          if (value && unit) {
            const unitMap = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
            const factor = unitMap[unit.toUpperCase()];
            if (factor) {
              dataLimitBytes = Math.round(parseFloat(value) * factor);
            }
          }
        }
        await this.db.upsertRadiusUser({
          username: finalUsername,
          password: finalPassword,
          groupname: pkg.name,
          rateLimit,
          dataLimitBytes,
        });
      }

      if (addUserToMikrotik.success) {
        let expireAt = null;
        if (pkg?.period) {
          const now = new Date();
          const period = pkg.period.toLowerCase();

          const match = period.match(/^(\d+)\s+(hour|minute|day|month|year)s?$/i);

          if (match) {
            const value = parseInt(match[1]);
            const unit = match[2].toLowerCase();

            switch (unit) {
              case 'minute':
                expireAt = new Date(now.getTime() + value * 60000);
                break;
              case 'hour':
                expireAt = new Date(now.getTime() + value * 3600000);
                break;
              case 'day':
                expireAt = new Date(now.getTime() + value * 86400000);
                break;
              case 'month':
                expireAt = new Date(now.setMonth(now.getMonth() + value));
                break;
              case 'year':
                expireAt = new Date(now.setFullYear(now.getFullYear() + value));
                break;
            }
          }
        }

        const tokenPayload = {
          phone: phone ? phone : "null",
          username: finalUsername,
          packageID: pkg.id,
          platformID: platformID,
        };
        const jwtToken = await this.mpesa.createHotspotToken(tokenPayload, expiresIn);

        const code = await this.db.createUser({
          status: "active",
          platformID: platformID,
          phone: phone ? phone : "null",
          username: finalUsername,
          password: finalPassword,
          expireAt: expireAt,
          packageID: packageID,
          token: jwtToken
        });

        if (phone) {
          const platformConfig = await this.db.getPlatformConfig(platformID)
          if (platformConfig?.sms === true) {
            const sms = await this.db.getPlatformSMS(platformID)
            if (!sms) {
              return res.status(200).json({
                success: false,
                message: "SMS not found!",
              });
            }
            if (sms && sms.sentHotspot === true) {
              if (sms.default === true && Number(sms.balance) < Number(sms.costPerSMS)) {
                return res.status(200).json({
                  success: false,
                  message: "Insufficient SMS Balance!",
                });
              }

              const platform = await this.db.getPlatform(platformID)
              if (!platform) {
                return res.status(200).json({
                  success: false,
                  message: "Platform not found!",
                });
              }
              const sms_message = Utils.formatMessage(sms.hotspotTemplate, {
                company: platform.name,
                username: finalUsername,
                period: pkg.period,
                expiry: expireAt,
                package: pkg.name,
              });
              const is_send = await this.sms.sendSMS(phone, sms_message, sms)
              if (is_send.success && sms?.default === true) {
                const newSMSBalance = Number(sms.balance) - Number(sms.costPerSMS);
                const newSMS = Math.floor(Number(sms.remainingSMS)) - 1;

                await this.db.updatePlatformSMS(platformID, {
                  balance: newSMSBalance.toString(),
                  remainingSMS: newSMS.toString()
                })
              }
            }
          }
        }

        await this.refreshDashboardStats(platformID, { role: auth.admin.role });
        return res.json({
          success: true,
          message: "Code added successfully",
          code: code,
        });
      } else {
        return res.json({
          success: false,
          message: `Failed to add user to MikroTik, ${addUserToMikrotik.message}`,
        });
      }

    } catch (error) {
      console.log("An error occurred", error);
      return res.json({
        success: false,
        message: "An error occurred while adding the user",
      });
    }

  }

  async fetchDashboardStats(req, res) {

    const { token, stationId } = req.body;
    if (!token) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({ success: false, message: auth.message });
      }

      const platformID = auth.admin.platformID;
      if (!platformID) {
        return res.json({ success: false, message: "Missing credentials required!" });
      }

      let record = null;
      if (stationId) {
        const station = await this.db.getStation(stationId);
        if (station && station.platformID === platformID) {
          record = await this.db.getStationDashboardStats(platformID, stationId);
          if (!record) {
            const response = await this.db.rebuildStationDashboardStats(platformID, stationId, {
              role: auth.admin.role,
            });
            if (!response) {
              return res.status(500).json({ success: false, message: "Failed to build station dashboard stats." });
            }
            return res.status(200).json(this.buildDashboardResponse(response, auth.admin.role));
          }
        }
      }

      if (!record) {
        record = await this.db.getDashboardStats(platformID);
        if (!record) {
          const response = await this.refreshDashboardStats(platformID, {
            role: auth.admin.role,
          });
          if (!response) {
            return res.status(500).json({ success: false, message: "Failed to build dashboard stats." });
          }
          return res.status(200).json(response);
        }
      }

      const payload = {
        stats: record.stats || {},
        funds: record.funds || {},
        networkusage: record.networkUsage || [],
        IsB2B: record.isB2B || false,
      };
      const response = this.buildDashboardResponse(payload, auth.admin.role);
      return res.status(200).json(response);

    } catch (error) {
      console.error("Error getting dashboard stats:", error);
      res.status(500).json({ success: false, message: "Internal server error." });
    }

  }

  async LoginManager(req, res) {

    const { email, password } = req.body;
    if (!email || !password) {
      return res.json({
        success: false,
        message: "Email and password are required!",
      });
    }

    try {
      const user = await this.db.getSuperUserByEmailAndPassword(email, password)

      if (!user) {
        return res.json({
          success: false,
          message: "Invalid email or password!",
        });
      }

      const token = this.generateToken(user.email, user.password);
      const updatedUser = await this.db.updateSuperUser({ id: user.id, token });
      return res.json({
        success: true,
        message: "Login successful!",
        token,
        user: updatedUser,
      });
    } catch (error) {
      console.error("Login error:", error);
      return res.json({
        success: false,
        message: "Internal server error",
      });
    }

  }

  async authManager(req, res) {

    try {
      const { token } = req.body;
      if (!token) {
        return res.json({
          success: false,
          message: "Missing credentials required!",
        });
      }
      const admin = await this.db.getSuperUserByToken(token);
      if (!admin) {
        return res.json({
          success: false,
          message: "Invalid token. Authentication failed!",
        });
      }
      return res.json({
        success: true,
        message: "Authentication successful",
        admin,
      });
    } catch (error) {
      console.error("An error occurred during authentication:", error);
      return res.json({
        success: false,
        message: "Internal server error. Please try again later.",
      });
    }

  }

  async fetchSuperDashboardStats(req, res) {

    try {
      const cacheKey = "main:super:dashboard";
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return res.status(200).json(cached);
      }
      const platforms = await this.db.getPlatforms();
      const platformstotalTally = platforms.length;

      const admins = await this.db.getAdmins();
      const adminstotalTally = admins.length;

      const revenue = await this.db.getPlatformRevenue()
      const sms = await this.db.getPlatformSMSDeposits();
      const smsBalace = sms?.totalBalances;
      const remainingSMS = sms?.remainingSMS;

      const stats = {
        totalAdmins: adminstotalTally,
        totalPlatforms: platformstotalTally,
        revenue: revenue.totalRevenue,
        smsBalace,
        remainingSMS
      };

      const response = {
        success: true,
        message: "Dashboard stats fetched",
        stats,
      };
      this.cache.set(cacheKey, response, 20000);
      return res.status(200).json(response);
    } catch (error) {
      console.error("Error getting dashboard stats:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error.",
      });
    }

  }

  async fetchAllStations(req, res) {

    try {
      const cacheKey = "main:stations:all";
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return res.json(cached);
      }
      const stations = await this.db.getAllStations();
      const response = {
        success: true,
        message: "Stations fetched",
        stations: stations,
      };
      this.cache.set(cacheKey, response, 30000);
      return res.json(response);
    } catch (error) {
      console.log("An error occurred", error);
      return res.json({ success: false, message: "An error occurred" });
    }

  }

  async UpdateDDNSViaScript(req, res) {

    const { subdomain, publicIP } = req.body;
    if (!subdomain || !publicIP) {
      return res.status(400).send('Subdomain and publicIP are required');
    }

    const zoneId = process.env.ZONE_ID;
    const apiToken = process.env.API_TOKEN;

    if (!zoneId || !apiToken) {
      return res.status(500).send("Internal server configuration error");
    }

    try {
      const recordResponse = await axios.get(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?name=${subdomain}`, {
        headers: { Authorization: `Bearer ${apiToken}` },
      });
      const recordID = recordResponse.data.result[0]?.id;
      if (recordID) {
        await axios.put(
          `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordID}`,
          {
            type: 'A',
            name: subdomain,
            content: publicIP,
            ttl: 120,
            proxied: false,
          },
          {
            headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
          }
        );
        res.status(200).send(`Successfully updated ${subdomain} to IP ${publicIP}`);
      } else {
        res.status(404).send('DNS record not found for subdomain');
      }
    } catch (error) {
      console.error(error);
      res.status(500).send('Failed to update DNS record');
    }

  }

  async updateDDNSR(req, res) {

    const { token, ddnsData } = req.body;

    if (!token || !ddnsData) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }

      if (auth.admin.role !== "superuser") {
        return res.json({
          success: false,
          message: "Unauthorised!",
        });
      }

      const platformID = auth.admin.platformID;
      const { id, url, publicIP } = ddnsData;

      if (!url || !publicIP) {
        return res.json({
          success: false,
          message: "DDNS URL and Public IP are required!",
        });
      }

      const data = { id, url, publicIP };
      const existingurl = await this.db.getDDNSByUrl(url);

      if (!id) {
        data.platformID = platformID;
        const { id: _, ...addData } = data;

        const existingdomain = await this.checkIfCloudflareDNSExists(url);
        if (existingdomain.success) {
          return res.json({
            success: false,
            message: "DDNS URL already exists in Cloudflare. Choose a different one!",
          });
        }

        const createddns = await this.db.createDDNS(addData);
        const adddomain = await this.addSubdomainToCloudflare({ ip: publicIP, url });

        if (!adddomain.success) {
          return res.json({
            success: false,
            message: `Failed to create DNS: ${adddomain.message}`,
          });
        }

        return res.json({
          success: true,
          message: "DDNS created and DNS record added successfully.",
          data: createddns,
        });

      } else {
        const existingDDNS = await this.db.getDDNSById(id);
        if (!existingDDNS) {
          return res.json({
            success: false,
            message: "DDNS record not found.",
          });
        }

        if (url !== existingDDNS.url) {
          await this.deleteCloudflareDNSRecord(existingDDNS.url);
          const createforcloudflare = await this.addSubdomainToCloudflare({ ip: publicIP, url });

          if (!createforcloudflare.success) {
            return res.json({
              success: false,
              message: `Failed to update DNS: ${createforcloudflare.message}`,
            });
          }
        }
        const { id: _, ...updData } = data;
        const updated = await this.db.updateDDNS(id, updData);
        return res.json({
          success: true,
          message: "DDNS updated successfully.",
          data: updated,
        });
      }
    } catch (err) {
      console.error("An error occured", err)
      return res.json({
        success: false,
        message: "An internal error occured, try again.",
        error: err
      });
    }

  }

  async fetchDDNS(req, res) {

    const { token } = req.body;

    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }

      if (auth.admin.role !== "superuser") {
        return res.json({
          success: false,
          message: "Unauthorised!",
        });
      }

      const platformID = auth.admin.platformID;

      const allddns = await this.db.getDDNS(platformID);
      const ddnsWithStatus = await Promise.all(
        allddns.map(async (ddns) => {
          const url = ddns.url.startsWith("http") ? ddns.url : `http://${ddns.url}`;
          const record = await this.checkIfCloudflareDNSExists(url);
          const isActive = record.success;
          return {
            ...ddns,
            isActive,
          };
        })
      );

      return res.json({
        success: true,
        data: ddnsWithStatus,
      });
    } catch (err) {
      return res.json({
        success: false,
        message: "Failed to fetch DDNS records.",
        error: err.message,
      });
    }

  }

  async deleteDDNSR(req, res) {

    const { token, ddnsData } = req.body;

    if (!token || !ddnsData) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }

      if (auth.admin.role !== "superuser") {
        return res.json({
          success: false,
          message: "Unauthorised!",
        });
      }

      const platformID = auth.admin.platformID;
      const { id, url, publicIP } = ddnsData;
      if (!id) {
        return res.json({
          success: false,
          message: "Missing required credentials!",
        });
      }

      const del = await this.db.deleteDDNS(id);
      const delfromcloudflare = await this.deleteCloudflareDNSRecord(url);
      if (delfromcloudflare.success) {
        return res.json({
          success: true,
          message: "DDNS deleted successfully",
        });
      } else {
        return res.json({
          success: false,
          message: delfromcloudflare.message,
        });
      }
    } catch (err) {
      console.error("An error occured", err)
      return res.json({
        success: false,
        message: "An internal error occured, try again.",
        error: err
      });
    }

  }

  async removeDDNS(url) {
    if (!url) {
      return {
        success: false,
        message: "Missing credentials required!",
      };
    }

    try {
      const delfromcloudflare = await this.deleteCloudflareDNSRecord(url);
      if (delfromcloudflare.success) {
        return {
          success: true,
          message: "DDNS deleted successfully",
        };
      }
      return {
        success: false,
        message: delfromcloudflare.message,
      };
    } catch (err) {
      console.error("An error occured", err);
      return {
        success: false,
        message: "An internal error occured, try again.",
        error: err,
      };
    }
  }

  async removeUser(req, res) {

    const { id, username, token } = req.body;

    if (!id || !username || !token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }

      if (auth.admin.role !== "superuser") {
        return res.json({
          success: false,
          message: "Unauthorised!",
        });
      }
      const platformID = auth.admin.platformID;
      const user = await this.db.getUserByUsername(username);
      const pkg = await this.db.getPackagesByID(user.packageID)
      const stations = await this.db.getStations(platformID);
      const stationRecord = stations.find((s) => s.mikrotikHost === pkg?.routerHost);
      const isRadius = stationRecord?.systemBasis === "RADIUS";

      const deleteuser = await this.db.deleteUser(id);
      this.cache.delPrefix(`main:search:${platformID}:users:`);
      if (!pkg) {
        await this.refreshDashboardStats(platformID, { role: auth.admin.role });
        return res.json({
          success: true,
          message: "User removed but No package found!",
        });
      }

      if (isRadius) {
        await this.db.deleteRadiusUser(username);
      } else {
        const userdata = {
          platformID: platformID,
          action: "remove",
          profileName: "none",
          host: pkg.routerHost,
          username: username
        }
        const removeuserfrommikrotik = await this.mikrotik.manageMikrotikUser(userdata)
        if (!removeuserfrommikrotik.success) {
          return res.json({
            success: true,
            message: "User deleted from Database but NOT removed from MikroTik.",
            mikrotikError: removeuserfrommikrotik.message,
          });
        }
      }

      await this.refreshDashboardStats(platformID, { role: auth.admin.role });
      return res.json({
        success: true,
        message: "User deleted from Database and Mikrotik.",
      })
    } catch (err) {
      console.error("An error occured", err)
      return res.json({
        success: false,
        message: "An internal error occured, try again.",
        error: err
      });
    }

  }

  async updatePPPoE(req, res) {

    const { token } = req.body;

    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }

      if (auth.admin.role !== "superuser") {
        return res.json({
          success: false,
          message: "Unauthorised!",
        });
      }
      const platformID = auth.admin.platformID;
    } catch (err) {
      console.error("An error occured", err)
      return res.json({
        success: false,
        message: "An internal error occured, try again.",
        error: err
      });
    }

  }

  async fetchMyPPPoe(req, res) {

    const { token, station, limit: limitInput, offset: offsetInput } = req.body;
    const limit = Math.min(Math.max(Number(limitInput) || 100, 1), 100);
    const offset = Math.max(Number(offsetInput) || 0, 0);

    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }

      if (auth.admin.role !== "superuser") {
        return res.json({
          success: false,
          message: "Unauthorised!",
        });
      }

      const platformID = auth.admin.platformID;
      const cacheKey = `main:pppoe:${platformID}:${station || "all"}:${limit}:${offset}`;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return res.json(cached);
      }
      const platform = await this.db.getPlatform(platformID);
      const pppoes = await this.db.getPPPoE(platformID);
      const scopedPppoes = station
        ? pppoes.filter((pppoe) => pppoe.station === station)
        : pppoes;

      const updatedPppoes = scopedPppoes.map((pppoe) => ({
        ...pppoe,
        link: `https://${platform.url}/pppoe?info=${pppoe.paymentLink}`,
      }));

      if (updatedPppoes.length === 0) {
        const response = {
          success: true,
          message: "PPPoE fetched successfully!",
          pppoe: [],
          total: 0,
          limit,
          offset,
        };
        this.cache.set(cacheKey, response, 10000);
        return res.json(response);
      }

      const stationHosts = Array.from(
        new Set(updatedPppoes.map((pppoe) => pppoe.station).filter(Boolean))
      );

      const statusResults = await Promise.all(
        stationHosts.map((host) =>
          this.mikrotik.checkPPPUserStatus(platformID, host)
        )
      );

      const activeUsernames = new Set();
      let mikrotikFailed = true;

      for (const result of statusResults) {
        if (result?.success) {
          mikrotikFailed = false;
          for (const user of result.users || []) {
            if (user?.name) activeUsernames.add(user.name);
          }
        }
      }

      if (mikrotikFailed) {
        const newPPPoEs = updatedPppoes.map((pppoe) => ({
          ...pppoe,
          active: "Offline",
        }));

        const total = newPPPoEs.length;
        const pagedPPPoE = newPPPoEs.slice(offset, offset + limit);
        const response = {
          success: true,
          message: "MikroTik unreachable, forced Offline for all",
          pppoe: pagedPPPoE,
          total,
          limit,
          offset,
        };
        this.cache.set(cacheKey, response, 10000);
        return res.json(response);
      }

      const newPPPoEs = [];
      for (const pppoe of updatedPppoes) {
        if (pppoe.status !== "active") {
          newPPPoEs.push({
            ...pppoe,
            active: "Offline",
          });
          continue;
        }

        const isActive = activeUsernames.has(pppoe.clientname);
        newPPPoEs.push({
          ...pppoe,
          active: isActive ? "Online" : "Offline",
        });
      }

      const total = newPPPoEs.length;
      const pagedPPPoE = newPPPoEs.slice(offset, offset + limit);
      const response = {
        success: true,
        message: "PPPoE fetched successfully!",
        pppoe: pagedPPPoE,
        total,
        limit,
        offset,
      };
      this.cache.set(cacheKey, response, 10000);
      return res.json(response);
    } catch (err) {
      console.error("An error occurred", err);
      return res.json({
        success: false,
        message: "An internal error occurred, try again.",
        error: err,
      });
    }

  }

  async fetchTemplates(req, res) {

    const { token } = req.body;

    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }

      if (auth.admin.role !== "superuser") {
        return res.json({
          success: false,
          message: "Unauthorised!",
        });
      }
      const platformID = auth.admin.platformID;
      const cacheKey = `main:templates:${platformID}`;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return res.json(cached);
      }
      const config = await this.db.getPlatformConfig(platformID);
      if (!config) {
        return res.json({
          success: false,
          message: "Platform config not found!",
        });
      }
      const templates = await this.db.getTemplates();
      const defaulttemplate = config.template;

      const response = {
        success: true,
        message: "Templates fetched succesfully!",
        templates: templates,
        default: defaulttemplate
      };
      this.cache.set(cacheKey, response, 60000);
      return res.json(response);
    } catch (err) {
      console.error("An error occured", err)
      return res.json({
        success: false,
        message: "An internal error occured, try again.",
        error: err
      });
    }

  }

  async updateTemplate(req, res) {

    const { token, name } = req.body;
    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }
    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }
      if (auth.admin.role !== "superuser") {
        return res.json({
          success: false,
          message: "Unauthorised!",
        });
      }
      const platformID = auth.admin.platformID;
      if (!platformID || !name) {
        return res.status(400).json({
          success: false,
          message: "Missing required credentials!",
        });
      }

      const existingPlatform = await this.db.getPlatformConfig(platformID);
      if (!existingPlatform) {
        return res.status(404).json({
          success: false,
          message: "Platform not found!"
        });
      }

      const data = { template: name };
      const upd = await this.db.updatePlatformConfig(platformID, data);

      return res.status(200).json({
        success: true,
        message: "Template updated successfully",
      });

    } catch (error) {
      console.error("Update error:", error);
      return res.status(500).json({
        success: false,
        message: "An unexpected error occurred during update"
      });
    }

  }

  async verifyCodes(req, res) {

    const { code, platformID, hash } = req.body;
    if (!code || !platformID) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }
    try {
      const existingcode = await this.db.getUniqueCode(code, platformID);
      if (!existingcode) {
        if (hash) {
          const host = Utils.decodeHashedIP(hash);
          const routercode = await this.mikrotik.verifyMikrotikUser({ platformID, code, host })
          if (!routercode.success) {
            return res.json({
              success: false,
              message: "Code does not exist!"
            })
          }
          return res.status(200).json({
            success: true,
            message: "Code verified!",
            code: code.trim(),
            password: code.trim(),
          });
        }
        const payment = await this.db.getMpesaCode(code);
        if (payment) {
          const pkg = await this.db.getPackagesByAmount(payment?.platformID, `${parseInt(payment.amount)}`, payment.reason);

          if (pkg) {
            const data = {
              phone: payment.phone,
              packageID: pkg.id,
              platformID: payment.platformID,
              package: pkg,
              code: code.trim(),
              mac: code.trim(),
              token: "null"
            }

            let addcodetorouter = await this.mikrotik.addManualCode(data);
            if (!addcodetorouter?.success) {
              res.json({
                success: false,
                message: "Voucher activation failed. Please contact customer care for assistance or try again.",
              });
            }

            return res.status(200).json({
              success: true,
              message: "Code verified!",
              code: code.trim(),
              password: code.trim(),
            });
          }

        }
        return res.json({
          success: false,
          message: "Code does not exist!"
        })
      }

      if (existingcode.status === "expired") {
        return res.json({
          success: false,
          message: "Code expired, can't login!"
        })
      }

      return res.status(200).json({
        success: true,
        message: "Code verified!",
        code: existingcode.username,
        password: existingcode.password,
      });
    } catch (error) {
      console.error("Error getting codes:", error);
      res.status(500).json({ success: false, message: "Internal server error." });
    }

  }

  async ResetPassword(req, res) {

    const { email } = req.body;
    if (!email) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }
    try {
      const admin = await this.db.getAdminByEmail(email);
      if (!admin) {
        return res.json({
          success: false,
          message: "User does not exist!"
        })
      }
      const platform = await this.db.getPlatform(admin.platformID);
      if (!platform) {
        return res.json({
          success: false,
          message: "Platform does not exist!"
        })
      }
      const token = this.generateToken(admin.adminID, admin.platformID);
      const upd = await this.db.updateAdmin(admin.id, { token });

      const subject = `Password reset request!`
      const message = `Someone requested a password reset on your account.\n If this was you update your password at https://${platform.url}/admin/login?form=update-password&code=${token}`;
      const data = {
        name: admin.name,
        type: "accounts",
        email: email,
        subject: subject,
        message: message
      }
      const sendresetemail = await this.mailer.EmailTemplate(data);
      if (!sendresetemail.success) {
        return res.status(200).json({
          success: false,
          message: sendresetemail.message,
        });
      }

      return res.status(200).json({
        success: true,
        message: `Password reset request send to ${email}, check your inbox!`,
      });
    } catch (error) {
      console.error("Error occured:", error);
      res.status(500).json({ success: false, message: "Internal server error." });
    }

  }

  async UpdatePassword(req, res) {

    const { password, code } = req.body;
    if (!password || !code) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }
    try {
      const admin = await this.db.getAdminByToken(code)
      if (!admin) {
        return res.json({
          success: false,
          message: "User does not exist!"
        })
      }
      const platform = await this.db.getPlatform(admin.platformID);
      if (!platform) {
        return res.json({
          success: false,
          message: "Platform does not exist!"
        })
      }
      const token = this.generateToken(admin.adminID, admin.platformID);
      const saltRounds = 10;
      const hashedPassword = await bcrypt.hash(password, saltRounds);
      const upd = await this.db.updateAdmin(admin.id, { token, password: hashedPassword });

      const subject = `Password updated!`
      const message = `Someone updated your account password.\n If this was not you update your password now.`;
      const data = {
        name: admin.name,
        type: "accounts",
        email: admin.email,
        subject: subject,
        message: message
      }
      const sendresetemail = await this.mailer.EmailTemplate(data);
      if (!sendresetemail.success) {
        return res.status(200).json({
          success: false,
          message: sendresetemail.message,
        });
      }

      return res.status(200).json({
        success: true,
        message: `Password updated succesfully, login now!`,
      });
    } catch (error) {
      console.error("Error occured:", error);
      res.status(500).json({ success: false, message: "Internal server error." });
    }

  }

  async UpdateProfile(req, res) {

    const { token, name, phone } = req.body;
    if (!token || !name || !phone) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }
    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success || !auth.admin) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }
      const admin = auth.admin
      if (!admin) {
        return res.json({
          success: false,
          message: "User does not exist!"
        })
      }

      const upd = await this.db.updateAdmin(admin.id, { token, name, phone });

      return res.status(200).json({
        success: true,
        message: `Profile updated succesfully`,
      });
    } catch (error) {
      console.error("Error occured:", error);
      res.status(500).json({ success: false, message: "Internal server error." });
    }

  }

  async fetchAllTemplates(req, res) {

    const { token } = req.body;

    try {
      const session = await this.authManagerSession(token);
      if (!session.success) {
        return res.json({
          success: false,
          message: session.message,
        });
      }

      const templates = await this.db.getTemplates();

      return res.json({
        success: true,
        message: "Templates fetched succesfully!",
        templates: templates,
      });
    } catch (err) {
      console.error("An error occured", err)
      return res.json({
        success: false,
        message: "An internal error occured, try again.",
        error: err
      });
    }

  }

  async addTemplates(req, res) {

    const { token, name, url } = req.body;

    if (!token || !url || !name) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const session = await this.authManagerSession(token);
      if (!session.success) {
        return res.json({
          success: false,
          message: session.message,
        });
      }

      const template = await this.db.createTemplate({ name, url });

      return res.json({
        success: true,
        message: "Template added succesfully!",
        template: template,
      });
    } catch (err) {
      console.error("An error occured", err)
      return res.json({
        success: false,
        message: "An internal error occured, try again.",
        error: err
      });
    }

  }

  async updateTemplates(req, res) {

    const { token, id, name, url } = req.body;

    if (!token || !id || !url || !name) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const session = await this.authManagerSession(token);
      if (!session.success) {
        return res.json({
          success: false,
          message: session.message,
        });
      }

      const template = await this.db.editTemplate(id, { name, url });

      return res.json({
        success: true,
        message: "Template updated succesfully!",
        template: template,
      });
    } catch (err) {
      console.error("An error occured", err)
      return res.json({
        success: false,
        message: "An internal error occured, try again.",
        error: err
      });
    }

  }

  async removeTemplates(req, res) {

    const { token, id } = req.body;

    if (!token || !id) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const session = await this.authManagerSession(token);
      if (!session.success) {
        return res.json({
          success: false,
          message: session.message,
        });
      }

      const template = await this.db.deleteTemplate(id);
      return res.json({
        success: true,
        message: "Template deleted succesfully!",
      });
    } catch (err) {
      console.error("An error occured", err)
      return res.json({
        success: false,
        message: "An internal error occured, try again.",
        error: err
      });
    }

  }

  async updateMyPassword(req, res) {

    const { token, currentPassword, newPassword } = req.body;

    if (!token || !currentPassword || !newPassword) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    if (newPassword.length < 6) {
      return res.json({
        success: false,
        message: "Password must be at least 6 characters long.",
      });
    }

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success || !auth.admin) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }

      const admin = auth.admin;
      const isMatch = await bcrypt.compare(currentPassword, admin.password);
      if (!isMatch) {
        return res.json({
          success: false,
          message: "Current password is incorrect.",
        });
      }
      const saltRounds = 10;
      const hashedPassword = await bcrypt.hash(newPassword, saltRounds);
      const upd = await this.db.updateAdmin(admin.id, { password: hashedPassword });

      const subject = "Password updated!";
      const message =
        "Someone updated your account password.\nIf this was not you, update your password now.";

      const data = {
        name: admin.name,
        type: "accounts",
        email: admin.email,
        subject,
        message,
      };

      const sendresetemail = await this.mailer.EmailTemplate(data);
      if (!sendresetemail.success) {
        return res.status(200).json({
          success: false,
          message: sendresetemail.message,
        });
      }

      return res.status(200).json({
        success: true,
        message: "Password updated successfully!",
      });
    } catch (error) {
      console.error("Error occurred:", error);
      res.status(500).json({ success: false, message: "Internal server error." });
    }

  }

  async fetchPPPoEInfo(req, res) {

    const { paymentLink } = req.body;
    if (!paymentLink) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }
    try {
      const pppoe = await this.db.getPPPoEByPaymentLink(paymentLink)

      return res.status(200).json({
        success: true,
        pppoe,
        message: `PPPoE fetched succesfully`,
      });
    } catch (error) {
      console.error("Error occured:", error);
      res.status(500).json({ success: false, message: "Internal server error." });
    }

  }

  async filterRevenue(req, res) {

    const { token, to, from } = req.body;

    if (!token || !to || !from) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success || !auth.admin) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }

      if (auth.admin.role !== "superuser") {
        return res.json({
          success: false,
          message: "Unauthorised!",
        });
      }
      const admin = auth.admin;
      const platformID = auth.admin.platformID;
      const revenue = await this.db.getRevenueByCustomDateRange(platformID, from, to);

      return res.status(200).json({
        success: true,
        message: "Revenue retrieved successfully!",
        totalRevenue: revenue?.totalRevenue || 0
      });
    } catch (error) {
      console.error("Error occurred:", error);
      res.status(500).json({ success: false, message: "Internal server error." });
    }

  }

  async logoutAdmin(req, res) {

    try {
      const { token } = req.body;
      if (!token) {
        return res.json({
          success: false,
          message: "Missing credentials required!",
        });
      }
      const session = await this.db.getSessionByToken(token.trim());
      if (!session) {
        return res.json({
          success: false,
          message: "Invalid token. Logout failed!",
        });
      }
      await this.db.deleteSession(session.id);
      return res.json({
        success: true,
        message: "Logout successful",
      });
    } catch (error) {
      console.error("An error occurred during logout:", error);
      return res.json({
        success: false,
        message: "Internal server error. Please try again later.",
      });
    }

  }

  async checkIfDomainResolvesToServer(req, res) {

    const { url } = req.body;
    if (!url) {
      return res.json({
        success: false,
        message: "No URL provided to check.",
      });
    }

    try {
      const hostname = url.replace(/^https?:\/\//, "").split("/")[0];
      const addresses = await dns.lookup(hostname);
      const valid = addresses.address === process.env.SERVER_IP;

      return res.json({
        success: true,
        valid,
        ip: addresses.address,
        message: "URL resolves successfully.",
      });
    } catch (err) {
      return res.json({
        success: false,
        message: `Failed to resolve URL "${url}". DNS lookup failed.`,
        error: err.message,
      });
    }

  }

  async updatePayments(req, res) {

    const { token, paymentData } = req.body;

    if (!token || !paymentData) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }

      const platformID = auth.admin.platformID;
      if (!platformID) {
        return res.json({
          success: false,
          message: "Missing platform ID!",
        });
      }

      const payment = await this.db.getMpesaByID(paymentData.id);
      if (!payment) {
        return res.json({
          success: false,
          message: "Payment not found!",
        });
      }

      const updatedPayment = await this.db.updateMpesaCodeByID(paymentData.id, {
        status: paymentData.status,
        code: paymentData.code
      });

      await this.refreshDashboardStats(platformID, { role: auth.admin.role });
      return res.json({
        success: true,
        message: "Payment updated successfully",
        payment: updatedPayment,
      });
    } catch (error) {
      console.error("An error occurred:", error);
      return res.json({ success: false, message: "An error occurred" });
    }

  }

  async installLetsEncryptSSLCert(req, res) {

    const { token, domain } = req.body;
    if (!token || !domain) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }
    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({ success: false, message: auth.message });
      }

      if (auth.admin.role !== "superuser") {
        return res.json({
          success: false,
          message: "Unauthorised!",
        });
      }

      const installSSL = await this.installLetsEncryptCert(domain);
      if (!installSSL.success) {
        return res.json({
          success: false,
          message: installSSL.message,
          error: installSSL.error
        });
      }

      return res.json({
        success: true,
        message: installSSL.message,
        output: installSSL.output
      });

    } catch (error) {
      console.error("An error occurred", error);
      return res.json({ success: false, message: "Internal server error." });
    }

  }

  async checkSSL(req, res) {

    const { token, domain } = req.body;
    if (!token || !domain) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({ success: false, message: auth.message });
      }

      if (auth.admin.role !== "superuser") {
        return res.json({
          success: false,
          message: "Unauthorised!",
        });
      }

      const url = domain.startsWith("https://") ? domain : `https://${domain}`;
      const sslValid = await new Promise((resolve) => {
        https
          .get(url, (response) => {
            resolve(true);
          })
          .on("error", (err) => {
            console.error("SSL check error:", err.message);
            resolve(false);
          });
      });

      if (sslValid) {
        return res.json({ success: true, message: "SSL certificate is valid." });
      } else {
        return res.json({ success: false, message: "SSL certificate is invalid or not installed." });
      }
    } catch (error) {
      console.error("An error occurred", error);
      return res.json({ success: false, message: "SSL certificate is invalid or an error occurred." });
    }

  }

  async checkSSLBatch(req, res) {
    const { token, domains } = req.body;
    if (!token || !Array.isArray(domains) || domains.length === 0) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({ success: false, message: auth.message });
      }

      if (auth.admin.role !== "superuser") {
        return res.json({
          success: false,
          message: "Unauthorised!",
        });
      }

      const checkDomain = (domain) =>
        new Promise((resolve) => {
          const url = String(domain || "");
          if (!url) return resolve(false);
          const httpsUrl = url.startsWith("https://") ? url : `https://${url}`;
          https
            .get(httpsUrl, () => resolve(true))
            .on("error", (err) => {
              console.error("SSL check error:", err.message);
              resolve(false);
            });
        });

      const results = await Promise.all(
        domains.map(async (item) => {
          const domain = item?.domain;
          const sslValid = await checkDomain(domain);
          return {
            id: item?.id,
            domain,
            sslValid,
          };
        })
      );

      return res.json({
        success: true,
        message: "SSL check completed.",
        results,
      });
    } catch (error) {
      console.error("An error occurred", error);
      return res.json({ success: false, message: "SSL certificate is invalid or an error occurred." });
    }
  }

  generateToken(adminID, platformID) {
    return jwt.sign({ adminID, platformID }, this.JWT_SECRET, {
      expiresIn: "30d",
    });
  };

  async generatePackageAccountNumber(platformID) {
    const digits = "0123456789";
    for (let i = 0; i < 10; i++) {
      let candidate = "";
      for (let j = 0; j < 6; j++) {
        candidate += digits[Math.floor(Math.random() * digits.length)];
      }
      const existing = await this.db.getPackageByAccountNumber(platformID, candidate);
      if (!existing) return candidate;
    }
    return `${Date.now()}`.slice(-6);
  }

  async AuthenticateRequest(token) {
    if (!token) {
      return {
        success: false,
        message: "Missing token!",
      };
    }

    const session = await this.db.getSessionByToken(token);
    if (!session) {
      const superuser = await this.db.getSuperUserByToken(token);
      if (superuser) {
        return {
          success: true,
          message: "Authenticated successfully",
          admin: null,
          superuser: superuser || null,
        };
      }
      return {
        success: false,
        message: "Session not found or expired",
      };
    }

    const admin = await this.db.getAdminByID(session.adminID);
    if (!admin) {
      return {
        success: false,
        message: "Invalid token provided",
      };
    }

    if (session.platformID !== admin.platformID) {
      return {
        success: false,
        message: "Invalid token provided",
      };
    }

    return {
      success: true,
      message: "Authenticated successfully",
      admin: admin || null,
      superuser: null,
    };
  }

  async authManagerSession(token) {
    if (!token) {
      return {
        success: false,
        message: "Missing credentials required!",
      };
    }

    try {
      const admin = await this.db.getSuperUserByToken(token);
      if (!admin) {
        return {
          success: false,
          message: "Invalid token. Authentication failed!",
        };
      }
      return {
        success: true,
        message: "Authentication successful",
        admin,
      };
    } catch (error) {
      console.error("An error occurred during authentication:", error);
      return {
        success: false,
        message: "Internal server error. Please try again later.",
      };
    }
  };

  async Packages(req, res) {
    const { platformID, hash } = req.body;

    if (!platformID) {
      return res.status(400).json({ type: "error", message: "Platform ID is required." });
    }

    try {
      let packages;
      const platform = await this.db.getPlatform(platformID);
      const platformUrl = String(platform?.url || "").trim();
      const platformHost = platformUrl
        ? platformUrl.replace(/^https?:\/\//, "").split("/")[0]
        : "";
      let host = "";
      if (hash) {
        try {
          const decoded = Utils.decodeHashedIP(hash);
          if (Utils.isValidIP(decoded) && decoded.startsWith("10.10.10.")) {
            host = decoded;
          }
        } catch (error) {
          host = "";
        }
      }
      if (!host && platformHost) {
        host = platformHost;
      }
      if (host) {
        packages = await this.db.getPackagesByHost(platformID, host);
      } else {
        packages = await this.db.getPackages(platformID);
      }

      const config = await this.db.getPlatformConfig(platformID);
      if (config?.mpesaShortCodeType?.toLowerCase() === "paybill" && Array.isArray(packages)) {
        for (const pkg of packages) {
          if (!pkg.accountNumber) {
            const accountNumber = await this.generatePackageAccountNumber(platformID);
            await this.db.updatePackage(pkg.id, platformID, { accountNumber });
            pkg.accountNumber = accountNumber;
          }
        }
      }

      packages = packages.filter(pkg => pkg.status !== "hidden");
      const popular = await this.db.getMostPurchasedPackage(platformID);
      const popularId = popular?.id;
      const updatedPackages = packages.map(pkg => ({
        ...pkg,
        popular: pkg.id === popularId,
      }));

      res.status(200).json({ type: "success", packages: updatedPackages });
    } catch (error) {
      console.error("Error getting packages:", error);
      res.status(500).json({ type: "error", message: "Internal server error." });
    }
  };

  async requestHomeFibre(req, res) {
    const { platformID, phone, packageId } = req.body;
    const cleanPhone = phone ? phone.trim() : "";

    if (!platformID || !cleanPhone || !packageId) {
      return res.status(400).json({
        success: false,
        message: "Platform, phone, and package are required.",
      });
    }

    if (cleanPhone.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Phone number looks invalid.",
      });
    }

    try {
      const platform = await this.db.getPlatform(platformID);
      if (!platform) {
        return res.status(404).json({
          success: false,
          message: "Platform not found.",
        });
      }

      const pkg = await this.db.getPackagesByID(packageId);
      if (!pkg || pkg.platformID !== platformID || pkg.category !== "HomeFibre") {
        return res.status(404).json({
          success: false,
          message: "Home Fibre package not found.",
        });
      }

      const existingLead = await this.db.getOpenHomeFibreLeadByPhone(platformID, cleanPhone);
      if (existingLead) {
        return res.status(409).json({
          success: false,
          message: "A Home Fibre callback is already pending for this number.",
        });
      }

      const lead = await this.db.createHomeFibreLead({
        platformID,
        packageID: packageId,
        packageName: pkg.name,
        price: pkg.price,
        speed: pkg.speed,
        phone: cleanPhone,
      });

      return res.status(200).json({
        success: true,
        message: "Request submitted. Our team will contact you shortly.",
        lead,
      });
    } catch (error) {
      console.error("Home fibre request error:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to submit request.",
      });
    }
  }

  async fetchHomeFibreCallbacks(req, res) {
    const { token } = req.body;

    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    const auth = await this.AuthenticateRequest(token);
    if (!auth.success) {
      return res.json({
        success: false,
        message: auth.message,
      });
    }

    const platformID = auth.admin.platformID;
    if (!platformID) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const callbacks = await this.db.getHomeFibreLeadsByPlatform(platformID);
      return res.json({
        success: true,
        callbacks,
      });
    } catch (error) {
      console.error("Error fetching home fibre callbacks:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch home fibre callbacks.",
      });
    }
  }

  async resolveHomeFibreCallback(req, res) {
    const { token, id } = req.body;

    if (!token || !id) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    const auth = await this.AuthenticateRequest(token);
    if (!auth.success) {
      return res.json({
        success: false,
        message: auth.message,
      });
    }

    const platformID = auth.admin.platformID;
    if (!platformID) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const updated = await this.db.updateHomeFibreLeadStatus(id, platformID, "resolved");
      if (!updated) {
        return res.status(404).json({
          success: false,
          message: "Callback not found.",
        });
      }
      return res.json({
        success: true,
        message: "Callback marked as resolved.",
        callback: updated,
      });
    } catch (error) {
      console.error("Error resolving home fibre callback:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to resolve callback.",
      });
    }
  }

  async deleteHomeFibreCallback(req, res) {
    const { token, id } = req.body;

    if (!token || !id) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    const auth = await this.AuthenticateRequest(token);
    if (!auth.success) {
      return res.json({
        success: false,
        message: auth.message,
      });
    }

    const platformID = auth.admin.platformID;
    if (!platformID) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const deleted = await this.db.deleteHomeFibreLeadById(id, platformID);
      if (!deleted) {
        return res.status(404).json({
          success: false,
          message: "Callback not found.",
        });
      }
      return res.json({
        success: true,
        message: "Callback deleted.",
        callback: deleted,
      });
    } catch (error) {
      console.error("Error deleting home fibre callback:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to delete callback.",
      });
    }
  }

  async getCode(req, res) {
    const { phone, platformID } = req.body;
    let foundcodes = [];
    let cleanphone = "";
    if (phone) {
      cleanphone = phone.trim()
    }

    if (!platformID) {
      return res.json({
        type: "error",
        message: "Missing credentials required!",
      });
    }

    if (!cleanphone) {
      return res.json({
        type: "error",
        message: "Phone number is required!",
      });
    }

    try {
      const phoneCodes = await this.db.getCodesByPhone(cleanphone, platformID);
      if (phoneCodes?.length > 0) {
        foundcodes = phoneCodes;
      }

      if (foundcodes.length === 0) {
        const mpesaCodes = await this.db.getCodesByMpesa(cleanphone, platformID);
        if (mpesaCodes?.length > 0) {
          foundcodes = mpesaCodes;
        }
      }

      if (foundcodes.length === 0) {
        const mpesaPayments = await this.db.getMpesaByPhone(cleanphone, platformID);
        if (mpesaPayments?.length > 0) {
          for (const payment of mpesaPayments) {
            if (!payment?.code || !payment?.reason || !payment?.amount) continue;
            const existing = await this.db.getUserByCodeAndPlatform(payment.code, platformID);
            if (existing) {
              foundcodes.push(existing);
              continue;
            }
            const pkg = await this.db.getPackagesByAmount(payment.platformID, `${parseInt(payment.amount)}`, payment.reason);
            if (!pkg) continue;
            const data = {
              phone: payment.phone,
              packageID: pkg.id,
              platformID: payment.platformID,
              package: pkg,
              code: payment.code.trim(),
              mac: payment.code.trim(),
              token: "null"
            };
            const addcodetorouter = await this.mikrotik.addManualCode(data);
            if (addcodetorouter?.success && addcodetorouter.code) {
              foundcodes.push(addcodetorouter.code);
            }
          }
        }
      }

      if (foundcodes.length === 0) {
        return res.json({ type: "error", message: "No codes found." });
      }

      const uniqueCodes = new Map();
      for (const code of foundcodes) {
        if (!code) continue;
        const key = code.id || code.username || code.code;
        if (!uniqueCodes.has(key)) uniqueCodes.set(key, code);
      }
      const validCodes = Array.from(uniqueCodes.values());

      if (validCodes.length === 0) {
        return res.json({ type: "error", message: "No valid codes found." });
      }

      const formattedCodes = validCodes.map((code) => {
        const createdAt = moment(code.createdAt);
        const now = moment();

        const hasValidExpireAt = code.expireAt && moment(code.expireAt).isValid();
        const expireAt = hasValidExpireAt ? moment(code.expireAt) : null;

        const createdAtFormatted = createdAt.format("YYYY-MM-DD HH:mm:ss");
        const expireAtFormatted = expireAt ? expireAt.format("YYYY-MM-DD HH:mm:ss") : "No Expiry";

        let timeLeft = "Unknown";
        let isExpired = true;

        if (code.status === "active") {
          if (expireAt && expireAt.isAfter(now)) {
            const duration = moment.duration(expireAt.diff(now));
            const hours = Math.floor(duration.asHours());
            const minutes = duration.minutes();

            timeLeft = `${hours} hours ${minutes} minutes remaining`;
            isExpired = false;
          } else if (!expireAt) {
            timeLeft = "No Expiry (Unlimited)";
            isExpired = false;
          } else {
            timeLeft = "Expired";
            isExpired = true;
          }
        } else {
          timeLeft = "Expired";
          isExpired = true;
        }

        return {
          username: code.username,
          password: code.password,
          expired: isExpired,
          activeFrom: createdAtFormatted,
          timeLeft: timeLeft,
          createdAt: createdAtFormatted,
          expireAt: expireAtFormatted,
        };
      });

      return res.status(200).json({
        type: "success",
        foundcodes: formattedCodes
      });

    } catch (error) {
      console.error("Error getting codes:", error);
      return res.status(500).json({
        type: "error",
        message: "Internal server error.",
        error: error.message
      });
    }
  };

  async getCodes(req, res) {
    const { platformID } = req.body;
    if (!platformID) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }
    try {
      const codes = await this.db.getUsersByCodes(platformID);
      const latestFiveCodes = codes
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 5);

      let newCodes = [];

      for (const code of latestFiveCodes) {
        const pkg = await this.db.getPackagesByID(code.packageID);
        newCodes.push({
          ...code,
          package: pkg.name,
        });
      }

      return res.status(200).json({
        success: true,
        message: "Codes fetched",
        codes: newCodes,
      });
    } catch (error) {
      console.error("Error getting codes:", error);
      res.status(500).json({ success: false, message: "Internal server error." });
    }
  }

  async addPlatform(req, res) {
    const { token, name, url, platformID, adminID, email, password, role, phone, adminName } = req.body;
    if (!token || !name || !url || !platformID || !adminID || !email || !password || !role) {
      return res.json({
        success: false,
        message: "Missing credentials are required!",
      });
    }
    const data = {
      name: name,
      url: url,
      platformID: platformID,
      adminID: adminID,
    };
    try {
      const session = await this.authManagerSession(token);
      if (!session.success) {
        return res.json({
          success: false,
          message: session.message,
        });
      }
      const check = await this.db.getPlatformByURLData(url);
      if (check) {
        return res.json({
          success: false,
          message: "Platform name already exists choose another name",
        });
      }
      const existingAdmin = await this.db.getAdminByEmail(email);
      if (existingAdmin) {
        return res.json({
          success: false,
          message: "User with this email already exists!",
        });
      }
      const siteUser = Utils.generateUsername();
      const siteUserPassword = Utils.generateRandomString();

      if (!siteUser || !siteUserPassword) {
        return res.json({
          success: false,
          message: "Internal error, missing critical configuration files, try again later"
        });
      }

      const addProxy = await this.addReverseProxySite(url, "http://localhost:3001");
      if (!addProxy.success) {
        return res.json({
          success: false,
          message: "Reverse proxy creation failed, try again.",
          error: addProxy.error
        });
      }

      const addSSL = await this.installLetsEncryptCert(url);
      if (!addSSL.success) {
        return res.json({
          success: false,
          message: addSSL.message
        });
      }

      const newSettings = await this.db.createPlatformConfig(platformID, {
        template: "Nova Special",
        adminID: adminID
      })
      await this.db.createPlatformEmailTemplate({
        platformID: platformID
      });
      await this.db.createPlatformSMS({
        platformID: platformID,
      })

      const createdAt = new Date();
      let dueDate = null;
      let totalAmount = 0;
      const serviceKey = "billing";
      const service = await this.db.getSystemServiceByKey(serviceKey);
      if (!service) {
        return res.status(500).json({
          success: false,
          message: "System service 'billing' is not configured.",
        });
      }
      if (service?.period) {
        const match = service.period.toLowerCase().match(/^(\d+)\s+(hour|minute|day|month|year)s?$/i);
        if (match) {
          const value = parseInt(match[1]);
          const unit = match[2].toLowerCase();
          dueDate = Utils.addPeriod(createdAt, value, unit);
          const now = new Date();
          let periodsPast = 0;
          while (dueDate <= now) {
            periodsPast++;
            dueDate = Utils.addPeriod(dueDate, value, unit);
          }
          periodsPast += 1;
          totalAmount = periodsPast * Number(service.price);
        }
      }

      const subdata = {
        name: service?.name,
        platformID,
        amount: totalAmount.toString(),
        price: service?.price,
        currency: service?.currency,
        dueDate,
        status: "Unpaid",
        description: service?.description,
      };

      const newBilling = await this.db.createPlatformBilling(subdata);

      const add = await this.db.createPlatform(data);
      await this.refreshDashboardStats(platformID);
      const saltRounds = 10;
      const hashedPassword = await bcrypt.hash(password, saltRounds);
      const adminToken = this.generateToken(adminID, platformID);
      await this.db.createAdmin({
        platformID,
        adminID,
        phone: phone || "",
        role,
        email,
        password: hashedPassword,
        name: adminName || name,
        token: adminToken,
      });

      return res.status(201).json({
        success: true,
        message: "Platform added successfully",
      });
    } catch (error) {
      console.log("An error occured", error);
      return res.json({ success: false, message: "An error occured" });
    }
  };

  async updatePlatform(req, res) {
    const { token, platformID, name, status } = req.body;
    if (!token || !platformID || !name) {
      return res.json({
        success: false,
        message: "Missing credentials are required!",
      });
    }
    try {
      const session = await this.authManagerSession(token);
      if (!session.success) {
        return res.json({
          success: false,
          message: session.message,
        });
      }

      const existing = await this.db.getPlatform(platformID);
      if (!existing) {
        return res.status(404).json({
          success: false,
          message: "Platform not found!",
        });
      }

      const normalizedStatus = status
        ? String(status).trim().toLowerCase()
        : String(existing.status || "active").trim().toLowerCase();
      const allowedStatuses = new Set(["active", "inactive", "premium"]);
      if (!allowedStatuses.has(normalizedStatus)) {
        return res.status(400).json({
          success: false,
          message: "Invalid status value.",
        });
      }

      const data = {
        name,
        status: normalizedStatus,
      };
      const upd = await this.db.updatePlatform(platformID, data);
      this.cache.del("main:platforms:all");

      return res.status(200).json({
        success: true,
        message: "Platform updated successfully",
        platform: upd,
      });
    } catch (error) {
      console.log("An error occured", error);
      return res.json({ success: false, message: "An error occured" });
    }
  };

  async registerPlatform(req, res) {
    const { name, email, password, url, platformID, adminID } = req.body;
    if (!name || !url || !email || !password || !platformID || !adminID) {
      return res.status(400).json({
        success: false,
        message: "All credentials are required!",
      });
    }

    try {
      const checkplatform = await this.db.getPlatformByURLData(url);
      if (checkplatform) {
        return res.status(409).json({
          success: false,
          message: "Platform name or URL already exists. Please choose another name.",
        });
      }

      const user = await this.db.getAdminByEmail(email);
      if (user) {
        return res.status(409).json({
          success: false,
          message: "User with this email already exists!",
        });
      }

      const provision = await this.addReverseProxySite(url, "http://127.0.0.1:3001");
      if (!provision.success) {
        return res.json({
          success: false,
          message: provision.message || "Reverse proxy provisioning failed, try again.",
          error: provision.error
        });
      }

      const saltRounds = 10;
      const hashedPassword = await bcrypt.hash(password, saltRounds);
      const token = this.generateToken(adminID, platformID);
      await this.db.createAdmin({
        platformID,
        adminID,
        phone: "",
        role: "superuser",
        email,
        password: hashedPassword,
        name: name,
        token,
      });

      await this.db.createPlatformConfig(platformID, {
        template: "Nova Special",
        adminID: adminID
      })
      await this.db.createPlatformEmailTemplate({
        platformID: platformID
      });
      await this.db.createPlatformSMS({
        platformID: platformID,
      })

      const createdAt = new Date();
      let dueDate = null;
      let totalAmount = 0;
      const serviceKey = "billing";
      const service = await this.db.getSystemServiceByKey(serviceKey);
      if (!service) {
        return res.status(500).json({
          success: false,
          message: "System service 'billing' is not configured.",
        });
      }
      if (service?.period) {
        const match = service.period.toLowerCase().match(/^(\d+)\s+(hour|minute|day|month|year)s?$/i);
        if (match) {
          const value = parseInt(match[1]);
          const unit = match[2].toLowerCase();
          dueDate = Utils.addPeriod(createdAt, value, unit);
          const now = new Date();
          let periodsPast = 0;
          while (dueDate <= now) {
            periodsPast++;
            dueDate = Utils.addPeriod(dueDate, value, unit);
          }
          periodsPast += 1;
          totalAmount = periodsPast * Number(service.price);
        }
      }

      const billingdata = {
        name: service?.name,
        platformID,
        amount: totalAmount.toString(),
        price: service?.price,
        currency: service?.currency,
        dueDate,
        status: "Unpaid",
        description: service?.description,
      };

      await this.db.createPlatformBilling(billingdata);
      const newPlatform = await this.db.createPlatform({
        name,
        url: url,
        platformID,
        adminID
      });
      await this.refreshDashboardStats(platformID);

      const subject = `Account created!`
      const message = `Your platform ${name} has been created. Login to your Admin dashboard at https://${url}/admin/login.`;
      const data = {
        name: name,
        type: "accounts",
        email: email,
        subject: subject,
        message: message
      }
      const sendwithdrawalemail = await this.mailer.EmailTemplate(data);
      if (!sendwithdrawalemail.success) {
        return res.status(200).json({
          success: false,
          message: sendwithdrawalemail.message,
        });
      }

      return res.status(201).json({
        success: true,
        message: "Platform created successfully",
        user: {
          id: adminID,
          email: email,
          name: name,
          role: "superuser"
        },
        token: token,
        platform: newPlatform
      });

    } catch (error) {
      console.error("Registration error:", error);

      let errorMessage = "An error occurred during registration";
      if (error.response) {
        errorMessage = error.response.data?.errors?.map(err => err.message).join(', ') || errorMessage;
      } else if (error instanceof Error) {
        errorMessage = error.message;
      }

      return res.status(500).json({
        success: false,
        message: "An error occurred during registration",
        error: error
      });
    }
  };

  sanitizeDomain(domain) {
    const normalized = String(domain || "").trim().toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(normalized)) return null;
    if (normalized.includes("..") || normalized.includes("/") || normalized.startsWith(".") || normalized.endsWith(".")) return null;
    return normalized;
  }

  buildNginxConfig(domain, targetUrl) {
    return [
      "server {",
      "    listen 80;",
      `    server_name ${domain};`,
      "",
      "    location / {",
      `        proxy_pass ${targetUrl};`,
      "        proxy_http_version 1.1;",
      "",
      "        proxy_set_header Host $host;",
      "        proxy_set_header X-Real-IP $remote_addr;",
      "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
      "        proxy_set_header X-Forwarded-Proto $scheme;",
      "",
      "        proxy_set_header Upgrade $http_upgrade;",
      "        proxy_set_header Connection \"upgrade\";",
      "    }",
      "}",
      "",
    ].join("\n");
  }

  async addReverseProxySite(domain, targetUrl) {
    const safeDomain = this.sanitizeDomain(domain);
    if (!safeDomain) {
      return { success: false, message: "Invalid domain provided." };
    }

    const config = this.buildNginxConfig(safeDomain, targetUrl);
    const tmpPath = `/tmp/nginx-${safeDomain}.conf`;
    const availablePath = `/etc/nginx/sites-available/${safeDomain}`;
    const enabledPath = `/etc/nginx/sites-enabled/${safeDomain}`;

    try {
      await fsp.writeFile(tmpPath, config, "utf8");
    } catch (err) {
      return { success: false, message: "Failed to write nginx config", error: err.message };
    }

    const run = (cmd, args = []) =>
      new Promise((resolve, reject) => {
        execFile(cmd, args, (err, stdout, stderr) => {
          if (err) return reject(stderr || err.message);
          resolve(stdout);
        });
      });

    try {
      await run("sudo", ["-n", "mv", tmpPath, availablePath]);
      await run("sudo", ["-n", "ln", "-sf", availablePath, enabledPath]);
      await run("sudo", ["-n", "/usr/sbin/nginx", "-t"]);
      await run("sudo", ["-n", "/usr/bin/systemctl", "reload", "nginx"]);

      return {
        success: true,
        message: `Nginx reverse proxy configured for ${safeDomain}`,
      };
    } catch (error) {
      console.error(`[Nginx] Error for "${safeDomain}":`, error);
      return {
        success: false,
        message: `Failed to configure nginx for ${safeDomain}`,
        error,
      };
    }
  }

  async installLetsEncryptCert(domain) {
    const safeDomain = this.sanitizeDomain(domain);
    if (!safeDomain) {
      return { success: false, message: "Invalid domain provided." };
    }
    const baseDomain = process.env.DOMAIN || "novawifi.co.ke";
    const adminEmail = `admin@${baseDomain}`;

    return new Promise((resolve) => {
      execFile(
        "sudo",
        ["-n", "certbot", "--nginx", "-d", safeDomain, "--non-interactive", "--agree-tos", "-m", adminEmail],
        (err, stdout, stderr) => {
          if (err) {
            console.error(`[Certbot] ERROR for ${safeDomain}:`, stderr || err.message);
            return resolve({
              success: false,
              message: `SSL installation failed for ${safeDomain}`,
              error: stderr || err.message,
            });
          }

          resolve({
            success: true,
            message: `SSL installed for ${safeDomain}`,
            output: stdout?.trim(),
          });
        }
      );
    });
  }

  async provisionReverseProxyAndSSL(domain, targetUrl) {
    const proxy = await this.addReverseProxySite(domain, targetUrl);
    if (!proxy.success) return proxy;
    const ssl = await this.addReverseProxySite(domain);
    if (!ssl.success) return ssl;
    return { success: true, message: "Reverse proxy and SSL provisioned successfully." };
  }

  async deleteSiteRecord(domain) {
    const safeDomain = this.sanitizeDomain(domain);
    if (!safeDomain) {
      return { success: false, message: "Invalid domain provided." };
    }

    const availablePath = `/etc/nginx/sites-available/${safeDomain}`;
    const enabledPath = `/etc/nginx/sites-enabled/${safeDomain}`;

    const run = (cmd, args = []) =>
      new Promise((resolve, reject) => {
        execFile(cmd, args, (err, stdout, stderr) => {
          if (err) return reject(stderr || err.message);
          resolve(stdout);
        });
      });

    const enabledExists = fs.existsSync(enabledPath);
    const availableExists = fs.existsSync(availablePath);

    if (!enabledExists && !availableExists) {
      return {
        success: true,
        message: `Site ${safeDomain} does not exist, skipping delete.`,
      };
    }

    try {
      if (enabledExists) await run("sudo", ["-n", "rm", "-f", enabledPath]);
      if (availableExists) await run("sudo", ["-n", "rm", "-f", availablePath]);
      await run("sudo", ["-n", "/usr/sbin/nginx", "-t"]);
      await run("sudo", ["-n", "/usr/bin/systemctl", "reload", "nginx"]);

      return {
        success: true,
        message: `Deleted nginx site ${safeDomain}`,
      };
    } catch (error) {
      const errorMsg = String(error || "");
      if (errorMsg.includes("No such file") || errorMsg.includes("cannot access")) {
        return {
          success: true,
          message: `Site ${safeDomain} does not exist, skipping delete.`,
        };
      }
      console.error(`[Delete] ERROR:`, error);
      return {
        success: false,
        message: `Delete nginx site failed for ${safeDomain}`,
        error,
      };
    }
  };

  async createMpesaSubaccount(data) {
    const { businessName, accountNumber, type, secretKey } = data;
    if (!businessName || !accountNumber || !type || !secretKey) {
      return { success: false, message: "Missing business name, account number, type, or secret key." };
    }
    let paymentType = null;
    if (type === "Till") paymentType = 799;
    else if (type === "Paybill") paymentType = 798;
    else if (type === "Phone") paymentType = 231;
    else return { success: false, message: "Invalid type. Must be 'Till', 'Paybill', or 'Phone'." };
    try {
      const response = await axios.post(
        'https://api.paystack.co/subaccount',
        {
          business_name: businessName,
          settlement_bank: paymentType,
          account_number: accountNumber,
          percentage_charge: 0,
          currency: "KES"
        },
        { headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' } }
      );
      const subaccountData = response.data.data;
      const subaccountId = subaccountData?.id;
      if (!subaccountId) return { success: false, message: "Failed to retrieve subaccount ID after creation.", data: subaccountData };
      let verified = false;
      let verificationData = null;
      try {
        const jwtToken = process.env.PAYSTACK_TOKEN || "";
        const verifyRes = await axios.post(
          'https://api.paystack.co/subaccount/verify',
          { ids: [subaccountId] },
          { headers: { Authorization: `Bearer ${jwtToken}`, 'Content-Type': 'application/json', 'jwt-auth': 'true' } }
        );
        verified = verifyRes.data?.data?.verified_ids?.includes(subaccountId);
        verificationData = verifyRes.data;
      } catch (verifyError) { }
      return { success: true, message: verified ? "Subaccount created and verified successfully." : "Subaccount created but verification was skipped or failed.", data: subaccountData, verification: verificationData };
    } catch (error) {
      return { success: false, message: "An error occurred during subaccount creation.", error: error?.response?.data || error.message };
    }
  }

  async fetchSubaccount(data) {
    const { secretKey, idOrCode } = data;
    if (!idOrCode || !secretKey) return { success: false, message: "Missing subaccount ID/code or secret key." };
    try {
      const response = await axios.get(`https://api.paystack.co/subaccount/${idOrCode}`, { headers: { Authorization: `Bearer ${secretKey}` } });
      return { success: true, message: "Subaccount retrieved successfully.", data: response.data.data };
    } catch (error) {
      return { success: false, message: error.response?.data?.message || "Failed to fetch subaccount.", error };
    }
  }

  async updateSubaccount(data) {
    const { businessName, accountNumber, type, secretKey, idOrCode } = data;
    if (!idOrCode || !businessName || !accountNumber || !type || !secretKey) {
      return { success: false, message: "Missing business name, account number, type, or secret key." };
    }
    let paymentType = null;
    if (type === "Till") paymentType = 799;
    else if (type === "Paybill") paymentType = 798;
    else if (type === "Phone") paymentType = 231;
    else return { success: false, message: "Invalid type. Must be 'Till', 'Paybill', or 'Phone'." };
    const updateData = {
      business_name: businessName,
      description: businessName,
      bank_code: paymentType,
      account_number: accountNumber,
      percentage_charge: 0,
      currency: "KES"
    };
    try {
      const response = await axios.put(`https://api.paystack.co/subaccount/${idOrCode}`, updateData, { headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' } });
      return { success: true, message: "Subaccount updated successfully.", data: response.data.data };
    } catch (error) {
      return { success: false, message: error.response?.data?.message || "Failed to update subaccount.", error };
    }
  }

  async addSubdomainToCloudflare(data) {
    const { url, ip } = data;
    if (!url) return { success: false, message: "No Subdomain provided for A Record!" };
    const zoneId = process.env.ZONE_ID;
    const apiToken = process.env.API_TOKEN;
    if (!zoneId || !apiToken) return { success: false, message: "Internal server error. Please try again later." };
    try {
      const dnsName = url.replace(/^https?:\/\//, '').split('/')[0];
      const cfResponse = await axios.post(
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
        { type: "A", name: dnsName, content: ip || process.env.SERVER_IP, ttl: 1, proxied: false },
        { headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" } }
      );
      if (cfResponse && cfResponse.data && !cfResponse.data.success) {
        const errorMessages = cfResponse.data.errors ? cfResponse.data.errors.map(err => err.message).join(', ') : 'Unknown error';
        return { success: false, message: `DNS creation failed: ${errorMessages}` };
      }
      return { success: true, message: "DNS record created successfully." };
    } catch (err) {
      return { success: false, message: "Internal server error. Please try again later.", error: err };
    }
  }

  async checkIfCloudflareDNSExists(url) {
    if (!url) return { success: false, message: "No subdomain provided." };
    const zoneId = process.env.ZONE_ID;
    const apiToken = process.env.API_TOKEN;
    if (!zoneId || !apiToken) return { success: false, message: "Internal server error. Missing Cloudflare credentials." };
    try {
      const host = url.replace(/^https?:\/\//, "").split("/")[0];
      const response = await axios.get(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=A&name=${host}`, { headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" } });
      const records = response.data.result || [];
      if (records.length > 0) return { success: true, exists: true, message: "DNS record exists in Cloudflare.", record: records[0] };
      return { success: false, exists: false, message: "DNS record does not exist in Cloudflare." };
    } catch (err) {
      return { success: false, message: "Failed to check DNS record in Cloudflare.", error: err };
    }
  }

  async deleteCloudflareDNSRecord(url) {
    if (!url) return { success: false, message: "No subdomain provided." };
    const zoneId = process.env.ZONE_ID;
    const apiToken = process.env.API_TOKEN;
    if (!zoneId || !apiToken) return { success: false, message: "Missing Cloudflare zone ID or API token." };
    try {
      const dnsName = url.replace(/^https?:\/\//, "").split("/")[0];
      const lookupResponse = await axios.get(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=A&name=${dnsName}`, { headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" } });
      const record = lookupResponse.data.result[0];
      if (!record) return { success: false, message: "DNS record not found in Cloudflare." };
      const deleteResponse = await axios.delete(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${record.id}`, { headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" } });
      if (deleteResponse.data.success) return { success: true, message: "DNS record deleted successfully." };
      return { success: false, message: "Failed to delete DNS record.", errors: deleteResponse.data.errors };
    } catch (err) {
      return { success: false, message: "Error occurred while deleting DNS record.", error: err };
    }
  }

  async checkIfUrlResolves(url) {
    if (!url) return { success: false, message: "No URL provided to check." };
    try {
      const hostname = url.replace(/^https?:\/\//, '').split('/')[0];
      const addresses = await dns.lookup(hostname);
      const valid = addresses.address === process.env.SERVER_IP;
      return { valid, ip: addresses.address, success: true, message: "URL resolves successfully." };
    } catch (err) {
      return { success: false, message: `Failed to resolve URL "${url}". DNS lookup failed.`, error: err };
    }
  }

  async resolveMikrotikHost(mikrotikPublicHost) {
    const endpointHost = mikrotikPublicHost;
    if (!endpointHost) return { success: false, message: 'Public router host is required.' };
    if (Utils.isValidIP && Utils.isValidIP(endpointHost)) return { success: true, host: endpointHost, addresses: [endpointHost] };
    if (Utils.validateDdnsHost && Utils.validateDdnsHost(endpointHost)) {
      try {
        const addresses = await dns.resolve4(endpointHost);
        return { success: true, host: endpointHost, addresses };
      } catch (err) {
        return { success: false, message: `Failed to resolve '${endpointHost}'. Make sure it points to a valid Public IP Address` };
      }
    }
    return { success: false, message: 'Invalid host: must be a valid IP or hostname.' };
  }

  async deleteBackupFolder(host) {
    if (!host) return null;
    const folderPath = path.join(appRoot, 'backups', 'remote-hosts', host);
    try {
      await fsp.access(folderPath);
    } catch {
      return { success: true, message: `${host} folder not found, nothing to delete.` };
    }
    try {
      await fsp.rm(folderPath, { recursive: true, force: true });
      return { success: true, message: `${host} folder deleted.` };
    } catch (error) {
      return { success: false, message: `${host} folder failed to delete.` }
    }
  }

  async fetchBackUp(req, res) {
    const { token } = req.body;
    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }
    const auth = await this.AuthenticateRequest(token);
    if (!auth.success) {
      return res.json({
        success: false,
        message: auth.message,
      });
    }

    if (auth.admin.role !== "superuser") {
      return res.json({
        success: false,
        message: "Unauthorised!",
      });
    }
    const platformID = auth.admin.platformID;
    if (!platformID) {
      return res.json({
        success: false,
        message: "Missing credentials required 3!",
      });
    }
    try {
      const backup = await this.db.getPlatformMikrotikBackUp(platformID);
      return res.json({ success: true, message: "Backup fetched", backup });
    } catch (error) {
      console.log("An error occured", error);
      return res.json({ success: false, message: "An error occured" });
    }
  };

  async fetchPlatformBills(req, res) {
    const { token } = req.body;
    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }
      if (auth.admin.role !== "superuser") {
        return res.json({
          success: false,
          message: "Unauthorised!",
        });
      }

      const platformID = auth.admin.platformID;
      if (!platformID) {
        return res.json({
          success: false,
          message: "Missing credentials required (platformID)!",
        });
      }

      const cacheKey = `main:bills:${platformID}`;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return res.json(cached);
      }
      const platform = await this.db.getPlatform(platformID);
      if (!platform) {
        return res.json({
          success: false,
          message: "Platform not found!",
        });
      }
      const bills = await this.db.getPlatformBilling(platformID);
      const response = {
        success: true,
        message: `Bills fetched successfully!`,
        bills,
      };
      this.cache.set(cacheKey, response, 60000);
      return res.json(response);
    } catch (error) {
      console.error("Billing error:", error);
      return res.json({
        success: false,
        message: "An error occurred when creating bills!",
      });
    }
  };

  async fetchFunds(req, res) {
    const { token } = req.body;

    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }

      if (auth.admin.role !== "superuser") {
        return res.json({
          success: false,
          message: "Unauthorised!",
        });
      }

      const platformID = auth.admin.platformID;
      const cacheKey = `main:funds:${platformID}`;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return res.json(cached);
      }
      const funds = await this.db.getFunds(platformID);
      const response = {
        success: true,
        message: "Funds fetched successfully.",
        funds,
      };
      this.cache.set(cacheKey, response, 30000);
      return res.json(response);
    } catch (err) {
      console.error("An error occured", err)
      return res.json({
        success: false,
        message: "An internal error occured, try again.",
        error: err
      });
    }
  };

  async fetchSessions(req, res) {
    const { token, adminID } = req.body;

    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }

      const cacheKey = `main:sessions:${adminID}`;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return res.json(cached);
      }
      const sessions = await this.db.getSessions(adminID);
      const response = {
        success: true,
        message: "Sessions fetched successfully.",
        sessions,
      };
      this.cache.set(cacheKey, response, 20000);
      return res.json(response);
    } catch (err) {
      console.error("An error occured", err)
      return res.json({
        success: false,
        message: "An internal error occured, try again.",
        error: err
      });
    }
  };

  async deleteMySession(req, res) {
    const { token, id } = req.body;

    if (!token || !id) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }
      const deltoken = await this.db.getSessionByID(id)
      if (!deltoken) {
        return res.json({
          success: true,
          message: "Sessions deleted successfully.",
          token,
        });
      }
      await this.db.deleteSession(id);
      return res.json({
        success: true,
        message: "Sessions deleted successfully.",
        token: deltoken.token,
      });
    } catch (err) {
      console.error("An error occured", err)
      return res.json({
        success: false,
        message: "An internal error occured, try again.",
        error: err
      });
    }
  };

  async enableSMS(req, res) {
    try {
      const { token, sms } = req.body;
      if (!token) {
        return res.json({
          success: false,
          message: "Missing credentials required!",
        });
      }

      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }

      if (auth.admin.role !== "superuser") {
        return res.json({
          success: false,
          message: "Unauthorised!",
        });
      }

      const smsexists = await this.db.getPlatformSMS(auth.admin.platformID);
      if (!smsexists) {
        await this.db.createPlatformSMS({
          platformID: auth.admin.platformID,
        })
      }

      const updated = await this.db.updatePlatformConfig(auth.admin.platformID, {
        sms
      });

      if (updated) {
        return res.json({
          message: sms ? "SMS notifications have been enabled" : "SMS notifications have been disabled",
          success: true,
        });
      } else {
        return res.json({
          message: "Failed to update SMS notifications",
          success: false,
        });
      }
    } catch (error) {
      return res.json({
        message: "An error occurred",
        success: false,
        error: error.message,
      });
    }
  };

  async fetchSMS(req, res) {
    try {
      const { token } = req.body;
      if (!token) {
        return res.json({
          success: false,
          message: "Missing credentials required!",
        });
      }

      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }

      if (auth.admin.role !== "superuser") {
        return res.json({
          success: false,
          message: "Unauthorised!",
        });
      }

      const platformID = auth.admin.platformID;
      const cacheKey = `main:sms:${platformID}`;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return res.json(cached);
      }
      const sms = await this.db.getPlatformSMS(platformID);
      const response = {
        message: "SMS fetched ",
        success: true,
        sms
      };
      this.cache.set(cacheKey, response, 60000);
      return res.json(response);

    } catch (error) {
      return res.json({
        message: "An error occurred",
        success: false,
        error: error.message,
      });
    }
  };

  async fetchEmailTemplates(req, res) {
    try {
      const { token } = req.body;
      if (!token) {
        return res.json({
          success: false,
          message: "Missing credentials required!",
        });
      }

      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }

      if (auth.admin.role !== "superuser") {
        return res.json({
          success: false,
          message: "Unauthorised!",
        });
      }
      console.log("Admin", auth.admin);

      const platformID = auth.admin.platformID;
      const cacheKey = `main:emailTemplates:${platformID}`;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return res.json(cached);
      }
      const emails = await this.db.getPlatformEmailTemplate(platformID);
      console.log("Email", emails);

      const response = {
        message: "Email templates fetched ",
        success: true,
        emails
      };
      this.cache.set(cacheKey, response, 60000);
      return res.json(response);

    } catch (error) {
      return res.json({
        message: "An error occurred",
        success: false,
        error: error.message,
      });
    }
  };

  async saveSMSTemplates(req, res) {
    try {
      const { token, data } = req.body;
      if (!token || !data) {
        return res.json({
          success: false,
          message: "Missing credentials required!",
        });
      }

      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }

      if (auth.admin.role !== "superuser") {
        return res.json({
          success: false,
          message: "Unauthorised!",
        });
      }

      await this.db.updatePlatformSMS(auth.admin.platformID, {
        hotspotTemplate: data.hotspotTemplate,
        pppoeRegisterSMS: data.pppoeRegisterSMS,
        pppoeInactiveSMS: data.pppoeInactiveSMS,
        pppoeReminderSMS: data.pppoeReminderSMS,
        pppoeExpiredSMS: data.pppoeExpiredSMS
      });
      this.cache.del(`main:sms:${auth.admin.platformID}`);

      return res.json({
        message: "SMS template has been saved",
        success: true,
      });
    } catch (error) {
      return res.json({
        message: "An error occurred",
        success: false,
        error: error.message,
      });
    }
  };

  async saveSMSConfig(req, res) {
    try {
      const { token, data } = req.body;
      console.log(data);

      if (!token || !data) {
        return res.json({
          success: false,
          message: "Missing credentials required!",
        });
      }

      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }

      if (auth.admin.role !== "superuser") {
        return res.json({
          success: false,
          message: "Unauthorised!",
        });
      }

      data.default === false ? await this.db.updatePlatformSMS(auth.admin.platformID, {
        senderID: data.senderID,
        provider: data.provider,
        apiKey: data.apiKey,
        patnerID: data.patnerID,
        default: data.default,
        sentHotspot: data.sentHotspot,
        sentPPPoE: data.sentPPPoE
      }) :
        await this.db.updatePlatformSMS(auth.admin.platformID, {
          default: data.default,
          sentHotspot: data.sentHotspot,
          sentPPPoE: data.sentPPPoE
        });
      this.cache.del(`main:sms:${auth.admin.platformID}`);

      return res.json({
        message: "SMS config has been saved",
        success: true,
      });
    } catch (error) {
      return res.json({
        message: "An error occurred",
        success: false,
        error: error.message,
      });
    }
  };

  async rechargeSMS(req, res) {
    const { token, amount } = req.body;
    if (!amount || !token) {
      return res.status(400).json({ success: false, message: "Missing credentials are required." });
    }

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }

      if (auth.admin.role !== "superuser") {
        return res.json({
          success: false,
          message: "Unauthorised!",
        });
      }

      const platformID = auth.admin.platformID;
      const smswallet = await this.db.getPlatformSMS(platformID)
      const funds = await this.db.getFunds(platformID);

      if (!smswallet) {
        return res.status(400).json({ success: false, message: "SMS Wallet does not exists!" });
      }

      if (!funds) {
        return res.status(400).json({ success: false, message: "Funds Wallet does not exists!" });
      }

      if (amount > funds.balance) {
        return res.json({ success: false, message: "Insufficient balance!" });
      }

      if (amount < 10) {
        return res.json({ success: false, message: "Minimum recharge is Ksh 10" });
      }

      const newFundsBalance = Number(funds.balance) - Number(amount);
      const newSMSBalance = Number(smswallet.balance) + Number(amount);
      const newSMS = Math.floor(Number(amount) / Number(smswallet.costPerSMS)) + Number(smswallet.remainingSMS);

      await this.db.updateFunds(funds.platformID, {
        balance: newFundsBalance.toString()
      })

      await this.db.updatePlatformSMS(smswallet.platformID, {
        balance: newSMSBalance.toString(),
        remainingSMS: newSMS.toString()
      })

      await this.refreshDashboardStats(platformID, { role: auth.admin.role });
      return res.status(200).json({
        success: true,
        message: `Amount KSH ${amount} has been added to your SMS Wallet.`
      });
    } catch (error) {
      console.error('Error recharging sms:', error);
      return res.status(500).json({
        success: false,
        message: "Failed to recharge sms",
        error: error.message
      });
    }
  };

  async saveEmailTemplates(req, res) {
    try {
      const { token, data } = req.body;
      if (!token || !data) {
        return res.json({
          success: false,
          message: "Missing credentials required!",
        });
      }

      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }

      if (auth.admin.role !== "superuser") {
        return res.json({
          success: false,
          message: "Unauthorised!",
        });
      }

      await this.db.updatePlatformEmailTemplate(auth.admin.platformID, {
        pppoeRegisterTemplate: data.pppoeRegisterTemplate,
        pppoeInactiveTemplate: data.pppoeInactiveTemplate,
        pppoeReminderTemplate: data.pppoeReminderTemplate,
        pppoeExpiredTemplate: data.pppoeExpiredTemplate,
        customTemplates: data.customTemplates || null,
      });
      this.cache.del(`main:emailTemplates:${auth.admin.platformID}`);

      return res.json({
        message: "Email templates have been saved",
        success: true,
      });
    } catch (error) {
      console.error("Error saving email templates:", error);
      return res.json({
        message: "An error occurred",
        success: false,
        error: error.message,
      });
    }
  };

  async updateManagerSettings(req, res) {
    const { token, data, id } = req.body;

    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    const auth = await this.AuthenticateRequest(token);
    if (!auth.success) {
      return res.json({
        success: false,
        message: auth.message,
      });
    }

    try {
      let updatedConfig;

      if (id) {
        updatedConfig = await this.db.updatePlatformSettings(id, data);
      } else {
        updatedConfig = await this.db.createPlatformSettings(data || {});
      }

      if (updatedConfig?.platformID) {
        await this.refreshDashboardStats(updatedConfig.platformID, { role: auth.admin.role });
      }
      return res.json({
        success: true,
        message: id
          ? "Platform Settings updated."
          : "Platform Settings created.",
        settings: updatedConfig,
      });
    } catch (error) {
      console.error("An error occurred updating/creating settings:", error);
      return res.json({ success: false, message: "An error occurred" });
    }
  };

  async fetchConfigFiles(req, res) {
    const { token } = req.body;

    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }

      const configs = await this.db.getConfigFiles();

      return res.json({
        success: true,
        message: "Config files fetched succesfully!",
        configs
      });
    } catch (err) {
      console.error("An error occured", err)
      return res.json({
        success: false,
        message: "An internal error occured, try again.",
        error: err
      });
    }
  }

  async UploadConfig(req, res) {
    const { token, filename, title, description, content, file } = req.body;
    console.log("Request data", req.body);

    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }

      const folderPath = path.join(appRoot, "files");
      if (!fs.existsSync(folderPath)) {
        execSync(`sudo -u novawifi-api-v1 mkdir -p "${folderPath}"`);
      }

      if (file && filename) {
        const base64Data = file.split(";base64,").pop(); // remove prefix
        const finalPath = path.join(folderPath, filename);
        fs.writeFileSync(finalPath, Buffer.from(base64Data, "base64"));
      }

      const savedConfig = await this.db.createConfigFile({
        filename: filename || "unnamed-config.rsc",
        title: title || filename || "Unnamed Configuration",
        description: description || "No description provided.",
        content: content || "",
      });

      return res.status(200).json({
        success: true,
        message: "File uploaded successfully.",
        config: savedConfig,
      });
    } catch (error) {
      console.error("Error uploading file:", error);
      return res.status(500).json({
        success: false,
        message: "An error occurred while uploading the file.",
        error: error.message,
      });
    }
  };

  async uploadBrandingLogo(req, res) {
    const { token, file, filename } = req.body || {};
    if (!token || !file) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({ success: false, message: auth.message });
      }
      if (auth.admin?.role !== "superuser") {
        return res.json({ success: false, message: "Unauthorised!" });
      }

      const platformID = auth.admin.platformID;
      const adminID = auth.admin.adminID;
      if (!platformID) {
        return res.json({ success: false, message: "Missing platform ID" });
      }

      const match = String(file).match(/^data:image\/(png|jpe?g);base64,/i);
      if (!match) {
        return res.json({ success: false, message: "Unsupported image format. Use PNG or JPG." });
      }

      const ext = match[1].toLowerCase().replace("jpeg", "jpg");
      const base64Data = String(file).replace(/^data:image\/(png|jpe?g);base64,/i, "");

      const folderPath = path.join(appRoot, "public", "branding-logos");
      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
      }

      const safeNameBase = (filename || "branding-logo")
        .replace(/\.[^/.]+$/, "")
        .replace(/[^a-zA-Z0-9._-]/g, "_");
      const finalName = `${safeNameBase}-${platformID}-${Date.now()}.${ext}`;
      const finalPath = path.join(folderPath, finalName);
      fs.writeFileSync(finalPath, Buffer.from(base64Data, "base64"));

      const imageUrl = `/branding-logos/${finalName}`;
      const proto = (req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
      const host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
      const absoluteUrl = host ? `${proto}://${host}${imageUrl}` : imageUrl;
      const existingConfig = await this.db.getPlatformConfig(platformID);
      if (existingConfig) {
        await this.db.updatePlatformConfig(platformID, { brandingImage: imageUrl });
      } else {
        await this.db.createPlatformConfig(platformID, {
          adminID,
          brandingImage: imageUrl,
        });
      }
      this.cache.del(`main:settings:${platformID}`);

      return res.status(200).json({
        success: true,
        message: "Branding logo uploaded successfully.",
        url: absoluteUrl,
        image: imageUrl
      });
    } catch (error) {
      console.error("Error uploading branding logo:", error);
      return res.status(500).json({ success: false, message: "An error occurred while uploading the logo." });
    }
  }

  async updateConfig(req, res) {
    const { token, id, title, description } = req.body;
    if (!token || !id) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }

      const existingConfig = await this.db.getConfigFileByID(id);
      if (!existingConfig) {
        return res.status(404).json({ success: false, message: "Config file not found." });
      }

      const updatedConfig = await this.db.updateConfigFile(id, {
        title: title || existingConfig.title,
        description: description || existingConfig.description,
      });

      return res.status(200).json({
        success: true,
        message: "Config file updated successfully.",
        config: updatedConfig
      });
    } catch (error) {
      console.error("Error updating config file:", error);
      return res.status(500).json({
        success: false,
        message: "An error occurred while updating the config file.",
        error: error.message
      });
    }
  }

  async deleteConfig(req, res) {
    const { token, id } = req.body;
    if (!token || !id) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }

      const existingConfig = await this.db.getConfigFileByID(id);
      if (!existingConfig) {
        return res.status(404).json({ success: false, message: "Config file not found." });
      }

      const folderPath = path.join(appRoot, 'files', existingConfig.filename);
      if (fs.existsSync(folderPath)) {
        fs.unlinkSync(folderPath);
      }

      await this.db.deleteConfigFile(id);

      return res.status(200).json({
        success: true,
        message: "Config file deleted successfully."
      });
    } catch (error) {
      console.error("Error deleting config file:", error);
      return res.status(500).json({
        success: false,
        message: "An error occurred while deleting the config file.",
        error: error.message
      });
    }
  }

  async fetchPPPoEPhoneNumbers(req, res) {
    const { token } = req.body;
    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }
    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success || !auth.admin) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }
      const admin = auth.admin;
      const platformID = auth.admin.platformID;
      const pppoes = await this.db.getPPPoE(platformID);
      const phoneNumbers = pppoes.map(pppoe => pppoe.phone);

      return res.status(200).json({
        success: true,
        message: "Phone numbers retrieved successfully!",
        phoneNumbers
      });
    } catch (error) {
      console.error("Error occurred:", error);
      res.status(500).json({ success: false, message: "Internal server error." });
    }
  };

  async fetchHotspotPhoneNumbers(req, res) {
    const { token } = req.body;
    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }
    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success || !auth.admin) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }
      const admin = auth.admin;
      const platformID = auth.admin.platformID;
      const hotspots = await this.db.getActivePlatformUsers(platformID);
      const phoneNumbers = hotspots.map(hotspot => hotspot.phone);

      return res.status(200).json({
        success: true,
        message: "Phone numbers retrieved successfully!",
        phoneNumbers
      });
    } catch (error) {
      console.error("Error occurred:", error);
      res.status(500).json({ success: false, message: "Internal server error." });
    }
  };

  async sendBulkSMS(req, res) {
    const { token, message, phoneNumbers } = req.body;

    if (!token || !message || !phoneNumbers) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({ success: false, message: auth.message });
      }
      if (auth.admin?.role !== "superuser") {
        return res.json({ success: false, message: "Unauthorised!" });
      }

      const platformID = auth.admin.platformID;

      const smsConfig = await this.db.getPlatformConfig(platformID);
      if (!smsConfig || !smsConfig.sms) {
        return res.json({ success: false, message: "SMS service is not enabled for this platform." });
      }

      const sms = await this.db.getPlatformSMS(platformID);
      if (!sms) {
        return res.json({ success: false, message: "SMS configuration not found for this platform." });
      }

      if (sms.default === true && Number(sms.balance) < Number(sms.costPerSMS)) {
        return res.json({ success: false, message: "Insufficient SMS balance. Please recharge your SMS wallet." });
      }

      const numbers = Array.isArray(phoneNumbers)
        ? phoneNumbers.map(n => n.trim()).filter(Boolean)
        : phoneNumbers.split(",").map(n => n.trim()).filter(Boolean);

      const success = [];
      const failed = [];

      for (const phone of numbers) {
        const valid = Utils.validatePhoneNumber(phone);
        if (!valid.valid) {
          failed.push({ phone, reason: "Invalid phone number format." });
          continue;
        }
        const result = await this.sms.sendSMS(phone, message, sms);

        if (result?.success) {
          success.push(phone);

          if (sms.default !== true) {
            continue;
          }

          const newBalance = Number(sms.balance) - Number(sms.costPerSMS);
          const newRemaining = Math.floor(Number(sms.remainingSMS)) - 1;

          sms.balance = newBalance.toString();
          sms.remainingSMS = newRemaining.toString();

          await this.db.updatePlatformSMS(platformID, {
            balance: sms.balance,
            remainingSMS: sms.remainingSMS
          });
        } else {
          failed.push({
            phone,
            reason: result?.message || "Failed to send"
          });
        }
      }

      return res.status(200).json({
        success: true,
        message: "Bulk SMS process completed.",
        summary: {
          total: numbers.length,
          sent: success.length,
          failed: failed.length
        },
        sentNumbers: success,
        failedNumbers: failed
      });

    } catch (error) {
      console.error("Error sending bulk SMS:", error);
      return res.status(500).json({ success: false, message: "Internal server error." });
    }
  };

  async scheduleBulkSMS(req, res) {
    const { token, message, phoneNumbers, scheduledAt } = req.body;
    if (!token || !message || !phoneNumbers || !scheduledAt) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({ success: false, message: auth.message });
      }
      if (auth.admin?.role !== "superuser") {
        return res.json({ success: false, message: "Unauthorised!" });
      }

      const platformID = auth.admin.platformID;
      const smsConfig = await this.db.getPlatformConfig(platformID);
      if (!smsConfig || !smsConfig.sms) {
        return res.json({ success: false, message: "SMS service is not enabled for this platform." });
      }

      const scheduledTime = new Date(scheduledAt);
      if (Number.isNaN(scheduledTime.getTime())) {
        return res.json({ success: false, message: "Invalid scheduled time." });
      }

      const numbers = Array.isArray(phoneNumbers)
        ? phoneNumbers.map(n => n.trim()).filter(Boolean)
        : String(phoneNumbers).split(",").map(n => n.trim()).filter(Boolean);

      if (numbers.length === 0) {
        return res.json({ success: false, message: "No valid phone numbers provided." });
      }

      const sms = await this.db.getPlatformSMS(platformID);
      if (!sms) {
        return res.json({ success: false, message: "SMS configuration not found for this platform." });
      }

      if (sms.default === true) {
        const costPerSMS = Number(sms.costPerSMS);
        const totalCost = costPerSMS * numbers.length;
        const balance = Number(sms.balance);
        const remaining = Number(sms.remainingSMS);

        if (Number.isFinite(balance) && balance < totalCost) {
          return res.json({
            success: false,
            message: "Insufficient SMS balance to schedule this bulk message. Please recharge your SMS wallet.",
          });
        }
        if (Number.isFinite(remaining) && remaining > 0 && remaining < numbers.length) {
          return res.json({
            success: false,
            message: "Insufficient SMS credits to schedule this bulk message. Please recharge your SMS wallet.",
          });
        }
      }

      const scheduled = await this.db.createScheduledSms({
        platformID,
        message,
        phoneNumbers: numbers,
        scheduledAt: scheduledTime,
        status: "scheduled",
      });

      return res.json({
        success: true,
        message: "Bulk SMS scheduled successfully.",
        scheduled,
      });
    } catch (error) {
      console.error("Error scheduling bulk SMS:", error);
      return res.status(500).json({ success: false, message: "Internal server error." });
    }
  };

  async sendInternalSMS(req, res) {
    const { token, message, phoneNumbers } = req.body || {};
    if (!token || !message || !phoneNumbers) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({ success: false, message: auth.message });
      }
      if (!auth.superuser && auth.admin?.role !== "superuser") {
        return res.json({ success: false, message: "Unauthorised!" });
      }

      const numbers = Array.isArray(phoneNumbers)
        ? phoneNumbers.map(n => n.trim()).filter(Boolean)
        : String(phoneNumbers).split(",").map(n => n.trim()).filter(Boolean);

      const success = [];
      const failed = [];

      for (const phone of numbers) {
        const valid = Utils.validatePhoneNumber(phone);
        if (!valid.valid) {
          failed.push({ phone, reason: "Invalid phone number format." });
          continue;
        }
        const result = await this.sms.sendInternalSMS(phone, message);
        if (result?.success) {
          success.push(phone);
        } else {
          failed.push({ phone, reason: result?.message || "Failed to send" });
        }
      }

      return res.status(200).json({
        success: true,
        message: "Internal SMS process completed.",
        summary: {
          total: numbers.length,
          sent: success.length,
          failed: failed.length
        },
        sentNumbers: success,
        failedNumbers: failed
      });
    } catch (error) {
      console.error("Error sending internal SMS:", error);
      return res.status(500).json({ success: false, message: "Internal server error." });
    }
  }

  async scheduleInternalSMS(req, res) {
    const { token, message, phoneNumbers, scheduledAt } = req.body || {};
    if (!token || !message || !phoneNumbers || !scheduledAt) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }

    try {
      const session = await this.authManagerSession(token);
      if (!session.success) {
        return res.json({ success: false, message: session.message });
      }

      const scheduledTime = new Date(scheduledAt);
      if (Number.isNaN(scheduledTime.getTime())) {
        return res.json({ success: false, message: "Invalid scheduled time." });
      }

      const numbers = Array.isArray(phoneNumbers)
        ? phoneNumbers.map(n => String(n).trim()).filter(Boolean)
        : String(phoneNumbers).split(",").map(n => n.trim()).filter(Boolean);

      if (numbers.length === 0) {
        return res.json({ success: false, message: "No valid phone numbers provided." });
      }

      const scheduled = await this.db.createScheduledInternalSms({
        message,
        phoneNumbers: numbers,
        scheduledAt: scheduledTime,
        status: "scheduled",
      });

      return res.json({
        success: true,
        message: "Internal SMS scheduled successfully.",
        scheduled,
      });
    } catch (error) {
      console.error("Error scheduling internal SMS:", error);
      return res.status(500).json({ success: false, message: "Internal server error." });
    }
  }

  async scheduleInternalEmail(req, res) {
    const { token, subject, message, emails, scheduledAt } = req.body || {};
    if (!token || !subject || !message || !emails || !scheduledAt) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }

    try {
      const session = await this.authManagerSession(token);
      if (!session.success) {
        return res.json({ success: false, message: session.message });
      }

      const scheduledTime = new Date(scheduledAt);
      if (Number.isNaN(scheduledTime.getTime())) {
        return res.json({ success: false, message: "Invalid scheduled time." });
      }

      const recipients = Array.isArray(emails)
        ? emails.map((email) => String(email).trim()).filter(Boolean)
        : String(emails).split(",").map((email) => email.trim()).filter(Boolean);

      if (recipients.length === 0) {
        return res.json({ success: false, message: "No valid email addresses provided." });
      }

      const scheduled = await this.db.createScheduledInternalEmail({
        subject,
        message,
        emails: recipients,
        scheduledAt: scheduledTime,
        status: "scheduled",
      });

      return res.json({
        success: true,
        message: "Internal email scheduled successfully.",
        scheduled,
      });
    } catch (error) {
      console.error("Error scheduling internal email:", error);
      return res.status(500).json({ success: false, message: "Internal server error." });
    }
  }

  async sendInternalEmail(req, res) {
    const { token, subject, message, emails } = req.body || {};
    if (!token || !subject || !message || !emails) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success || (!auth.admin && !auth.superuser)) {
        return res.json({ success: false, message: auth.message });
      }

      const recipients = Array.isArray(emails)
        ? emails.map((email) => String(email).trim()).filter(Boolean)
        : String(emails).split(",").map((email) => email.trim()).filter(Boolean);

      const success = [];
      const failed = [];

      for (const email of recipients) {
        if (!email.includes("@")) {
          failed.push({ email, reason: "Invalid email address." });
          continue;
        }
        const result = await this.mailer.sendInternalEmail({
          to: email,
          subject,
          message,
          name: email,
        });
        if (result?.success) {
          success.push(email);
        } else {
          failed.push({ email, reason: result?.message || "Failed to send" });
        }
      }

      return res.status(200).json({
        success: true,
        message: "Internal email process completed.",
        summary: {
          total: recipients.length,
          sent: success.length,
          failed: failed.length
        },
        sentEmails: success,
        failedEmails: failed
      });
    } catch (error) {
      console.error("Error sending internal email:", error);
      return res.status(500).json({ success: false, message: "Internal server error." });
    }
  }

  async fetchBlockedUsers(req, res) {
    const { token } = req.body;
    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }
    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success || !auth.admin) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }
      const admin = auth.admin;
      const platformID = auth.admin.platformID;
      const blockedUsers = await this.db.getBlockedUsersByPlatform(platformID);

      return res.status(200).json({
        success: true,
        message: "Blocked users retrieved successfully!",
        users: blockedUsers
      });
    } catch (error) {
      console.error("Error occurred:", error);
      res.status(500).json({ success: false, message: "Internal server error." });
    }
  }

  async addBlockedUser(req, res) {
    const { token, phone, reason } = req.body || {};
    if (!token || !phone) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }

    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success || !auth.admin) {
        return res.json({ success: false, message: auth.message });
      }

      const platformID = auth.admin.platformID;
      const valid = Utils.validatePhoneNumber(phone);
      if (!valid.valid) {
        return res.json({ success: false, message: valid.reason || "Invalid phone number" });
      }

      const existing = await this.db.getBlockedUserByPhone(valid.phone, platformID);
      if (existing && existing.platformID === platformID) {
        return res.json({ success: false, message: "User is already blocked." });
      }

      const blockedUser = await this.db.createBlockedUser({
        phone: valid.phone,
        reason: reason || "Violation of terms",
        platformID,
        blockedBy: auth.admin.adminID,
        status: "blocked"
      });

      return res.status(200).json({
        success: true,
        message: "User blocked successfully!",
        user: blockedUser
      });
    } catch (error) {
      console.error("Error occurred:", error);
      return res.status(500).json({ success: false, message: "Internal server error." });
    }
  }

  async DownloadMikrotikBackUpFile(req, res) {
    const { host, filename } = req.params;
    const token = req.query.token || req.headers["authorization"];
    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    const auth = await this.AuthenticateRequest(token);
    if (!auth.success) {
      return res.json({
        success: false,
        message: auth.message,
      });
    }

    const platformID = auth.admin.platformID;
    if (!platformID) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    const basePath = path.join(appRoot, "backups", "remote-hosts", host, filename);
    const safePath = path.normalize(basePath);

    if (!safePath.startsWith(path.join(appRoot, "backups"))) {
      return res.status(403).send("Invalid path");
    }

    if (!fs.existsSync(safePath)) {
      return res.status(404).send("File not found");
    }

    return res.download(safePath);
  }

  async DownloadConfigFile(req, res) {
    const { filename } = req.params;
    const token = req.query.token || req.headers["authorization"];
    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    const auth = await this.AuthenticateRequest(token);
    if (!auth.success) {
      return res.json({
        success: false,
        message: auth.message,
      });
    }

    const platformID = auth.admin.platformID;
    if (!platformID) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    const basePath = path.join(appRoot, "files", filename);
    const safePath = path.normalize(basePath);

    if (!safePath.startsWith(path.join(appRoot, "files"))) {
      return res.status(403).send("Invalid path");
    }

    if (!fs.existsSync(safePath)) {
      return res.status(404).send("File not found");
    }

    return res.download(safePath);
  }

  async DownloadLoginFile(req, res) {
    const token = req.query.token || req.headers["authorization"];
    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    const auth = await this.AuthenticateRequest(token);
    if (!auth.success) {
      return res.json({
        success: false,
        message: auth.message,
      });
    }
    if (auth.admin.role !== "superuser") {
      return res.json({ success: false, message: "Unauthorised!" });
    }

    const platformID = auth.admin.platformID;
    if (!platformID) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    const platform = await this.db.getPlatform(platformID);
    const config = await this.db.getPlatformConfig(platformID);
    if (!platform || !config) {
      return res.json({
        success: false,
        message: "Platform data not found!",
      });
    }

    const url = platform.url;
    const mikrotikHost = config.mikrotikHost;
    const hash = Utils.hashInternalIP(mikrotikHost);

    const htmlContent = `
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"
   "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta http-equiv="pragma" content="no-cache" />
<meta http-equiv="expires" content="-1" />
<meta name="viewport" content="width=device-width; initial-scale=1.0; maximum-scale=1.0;"/>
<title>Logging in...</title>
</head>

<body onload="autoLogin()">
<script type="text/javascript" src="/md5.js"></script>
<script type="text/javascript">
    function autoLogin() {
        const urlParams = new URLSearchParams(window.location.search);
        const username = urlParams.get('username');
        const password = urlParams.get('password');

        if (username && password) {
            const form = document.createElement('form');
            form.action = "$(link-login-only)";
            form.method = 'post';

            const inputUsername = document.createElement('input');
            inputUsername.type = 'hidden';
            inputUsername.name = 'username';
            inputUsername.value = username;
            form.appendChild(inputUsername);

            const inputPassword = document.createElement('input');
            inputPassword.type = 'hidden';
            inputPassword.name = 'password';
            inputPassword.value = hexMD5('$(chap-id)' + password + '$(chap-challenge)');
            form.appendChild(inputPassword);

            const inputDst = document.createElement('input');
            inputDst.type = 'hidden';
            inputDst.name = 'dst';
            inputDst.value = "$(link-orig)";
            form.appendChild(inputDst);

            const inputPopup = document.createElement('input');
            inputPopup.type = 'hidden';
            inputPopup.name = 'popup';
            inputPopup.value = 'true';
            form.appendChild(inputPopup);

            document.body.appendChild(form);
            form.submit();
        } else {
            window.location.href = "${url}/login?hash=${hash}";
        }
    }
</script>

</body>
</html>
    `;

    const basePath = path.join(appRoot, "backups", `login-${platformID}.html`);
    const safePath = path.normalize(basePath);

    fs.writeFileSync(safePath, htmlContent, "utf8");

    return res.download(safePath, "login.html", (err) => {
      if (err) {
        console.error("Error sending file:", err);
      }
      fs.unlink(safePath, () => { });
    });
  }

  async deleteBlockedUsers(req, res) {
    const { token, id } = req.body;
    if (!token || !id) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }
    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success || !auth.admin) {
        return res.json({
          success: false,
          message: auth.message,
        });
      }
      const admin = auth.admin;
      const platformID = auth.admin.platformID;

      const blockedUser = await this.db.getBlockedUserByID(id);
      if (!blockedUser || blockedUser.platformID !== platformID) {
        return res.status(404).json({
          success: false,
          message: "Blocked user not found.",
        });
      }

      const blockeduserpayments = await this.db.getMpesaByPhone(blockedUser.phone, platformID);
      for (const payment of blockeduserpayments) {
        if (payment.status === "FAILED") {
          await this.db.deleteMpesaPayment(payment.id);
        }
      }

      await this.db.deleteBlockedUserByID(id);
      return res.status(200).json({
        success: true,
        message: "Blocked user removed successfully!",
      });
    } catch (error) {
      console.error("Error occurred:", error);
      res.status(500).json({ success: false, message: "Internal server error." });
    }
  }

  async resolveStationPublicIp(station) {
    const candidates = [
      station?.mikrotikDDNS,
      station?.mikrotikPublicHost,
      station?.mikrotikHost,
    ]
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean);

    for (const candidate of candidates) {
      if (Utils.isValidIP(candidate)) return candidate;
      if (Utils.validateDdnsHost(candidate)) {
        try {
          const addresses = await dns.resolve4(candidate);
          if (addresses && addresses.length > 0) return addresses[0];
        } catch { }
      }
    }

    return null;
  }

  async configureRouterForRadius(platformID, station, radiusServerIp, secret) {
    try {
      const connection = await this.mikrotik.config.createSingleMikrotikClient(platformID, station.mikrotikHost);
      if (!connection?.channel) {
        return { success: false, message: "No valid MikroTik connection" };
      }
      const { channel } = connection;
      try {
        const entries = await channel.write("/radius/print", []);
        const existing = Array.isArray(entries)
          ? entries.find((r) => String(r.address || "") === radiusServerIp)
          : null;
        if (existing && existing[".id"]) {
          await channel.write("/radius/set", [
            `=.id=${existing[".id"]}`,
            `=secret=${secret}`,
            "=service=ppp,hotspot",
            "=timeout=300ms",
          ]);
        } else {
          await channel.write("/radius/add", [
            `=address=${radiusServerIp}`,
            `=secret=${secret}`,
            "=service=ppp,hotspot",
            "=timeout=300ms",
          ]);
        }
        await channel.write("/radius/incoming/set", ["=accept=yes"]);
        await channel.write("/ppp/aaa/set", [
          "=use-radius=yes",
          "=accounting=yes",
          "=interim-update=1m",
        ]);
        const profiles = await channel.write("/ip/hotspot/profile/print", []);
        if (Array.isArray(profiles)) {
          for (const profile of profiles) {
            if (!profile[".id"]) continue;
            await channel.write("/ip/hotspot/profile/set", [
              `=.id=${profile[".id"]}`,
              "=use-radius=yes",
            ]);
          }
        }
        return { success: true };
      } finally {
        await this.mikrotik.safeCloseChannel(channel);
      }
    } catch (error) {
      return { success: false, message: error?.message || "Router radius config failed" };
    }
  }

  async configureRouterForApi(platformID, station, radiusServerIp) {
    try {
      const connection = await this.mikrotik.config.createSingleMikrotikClient(platformID, station.mikrotikHost);
      if (!connection?.channel) {
        return { success: false, message: "No valid MikroTik connection" };
      }
      const { channel } = connection;
      try {
        const entries = await channel.write("/radius/print", []);
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            const addr = String(entry.address || "");
            if (!radiusServerIp || addr === radiusServerIp) {
              if (entry[".id"]) {
                await channel.write("/radius/remove", [`=.id=${entry[".id"]}`]);
              }
            }
          }
        }
        await channel.write("/radius/incoming/set", ["=accept=no"]);
        await channel.write("/ppp/aaa/set", ["=use-radius=no"]);
        const profiles = await channel.write("/ip/hotspot/profile/print", []);
        if (Array.isArray(profiles)) {
          for (const profile of profiles) {
            if (!profile[".id"]) continue;
            await channel.write("/ip/hotspot/profile/set", [
              `=.id=${profile[".id"]}`,
              "=use-radius=no",
            ]);
          }
        }
        return { success: true };
      } finally {
        await this.mikrotik.safeCloseChannel(channel);
      }
    } catch (error) {
      return { success: false, message: error?.message || "Router API config failed" };
    }
  }

  async migrateSystemBasis(req, res) {
    const { token, target, stationId } = req.body || {};
    if (!token || !target || !stationId) {
      return res.status(400).json({ success: false, message: "Missing token, target, or stationId" });
    }
    try {
      const auth = await this.AuthenticateRequest(token);
      if (!auth.success || !auth.admin) {
        return res.status(401).json({ success: false, message: auth.message });
      }
      if (auth.admin.role !== "superuser") {
        return res.status(403).json({ success: false, message: "Unauthorised!" });
      }

      const platformID = auth.admin.platformID;
      const normalizedTarget = String(target).toUpperCase();
      if (!["API", "RADIUS"].includes(normalizedTarget)) {
        return res.status(400).json({ success: false, message: "Invalid target basis" });
      }

      const station = await this.db.getStation(stationId);
      if (!station || station.platformID !== platformID) {
        return res.status(404).json({ success: false, message: "Station not found" });
      }
      const packages = (await this.db.getPackagesByPlatformID(platformID)) || [];
      const stationPackages = packages.filter((pkg) => pkg.routerHost === station.mikrotikHost);
      const users = (await this.db.getUsersByCodes(platformID)) || [];
      const activeUsers = users.filter((u) => String(u.status || "").toLowerCase() === "active");
      const pppoe = (await this.db.getPPPoE(platformID)) || [];
      const stationPppoe = pppoe.filter((entry) => entry.station === station.mikrotikHost);
      const plans = (await this.db.getPPPoEPlans(platformID)) || [];
      const planMap = new Map(plans.map((p) => [p.id, p]));
      const packageMap = new Map(stationPackages.map((p) => [p.id, p]));
      const radiusServerIp = (process.env.RADIUS_SERVER_IP || process.env.SERVER_IP || "").toString().split(":")[0];

      const summary = {
        target: normalizedTarget,
        stationUpdated: false,
        routerConfigured: false,
        usersMigrated: 0,
        pppoeMigrated: 0,
        packagesUpdated: 0,
        radiusClientAdded: false,
        radiusClientRemoved: false,
        /** @type {string[]} */
        warnings: [],
        /** @type {string[]} */
        errors: [],
      };

      if (normalizedTarget === "RADIUS") {
        const stations = (await this.db.getStations(platformID)) || [];
        const existingNames = new Set(stations.map((s) => s.radiusClientName).filter(Boolean));
        const generateName = () => {
          const base = `rad-${platformID.slice(0, 6)}`;
          const suffix = crypto.randomBytes(3).toString("hex");
          return `${base}-${suffix}`;
        };

        let clientName = station.radiusClientName || generateName();
        while (existingNames.has(clientName)) {
          clientName = generateName();
        }
        existingNames.add(clientName);
        const clientSecret = station.radiusClientSecret || crypto.randomBytes(12).toString("hex");
        const publicIp = await this.resolveStationPublicIp(station);
        if (!publicIp) {
          summary.warnings.push(`Station ${station.name || station.mikrotikHost}: missing public IP/DDNS`);
        }

        await this.db.updateStation(station.id, {
          systemBasis: "RADIUS",
          radiusClientName: clientName,
          radiusClientSecret: clientSecret,
          radiusClientIp: publicIp || station.radiusClientIp || "",
          radiusServerIp: radiusServerIp || station.radiusServerIp || "",
        });
        summary.stationUpdated = true;

        if (publicIp && radiusServerIp) {
          const addResult = await ensureRadiusClient({
            name: clientName,
            ip: publicIp,
            secret: clientSecret,
            shortname: station.name || station.mikrotikHost,
            server: radiusServerIp,
            description: `Nova RADIUS client for ${station.name || station.mikrotikHost}`,
          });
          if (addResult.success) {
            summary.radiusClientAdded = true;
          } else {
            summary.warnings.push(`RADIUS client add failed: ${addResult?.message || "unknown error"}`);
            console.warn("[RADIUS] ensureRadiusClient failed", addResult?.message || addResult);
          }
        }

        const routerResult = await this.configureRouterForRadius(platformID, station, radiusServerIp, clientSecret);
        if (routerResult.success) {
          summary.routerConfigured = true;
        } else {
          summary.warnings.push(`Station ${station.name || station.mikrotikHost}: ${routerResult.message}`);
        }

        for (const user of activeUsers) {
          const pkg = packageMap.get(user.packageID);
          if (!pkg) {
            summary.warnings.push(`User ${user.username || user.code}: missing package`);
            continue;
          }
          const username = user.username || user.code || user.phone;
          if (!username) continue;
          const password = user.password || username;
          const speedVal = String(pkg.speed || "").replace(/[^0-9.]/g, "");
          const rateLimit = speedVal ? `${speedVal}M/${speedVal}M` : "";
          let dataLimitBytes = null;
          if (String(pkg.category || "").toLowerCase() === "data" && pkg.usage && pkg.usage !== "Unlimited") {
            const [value, unit] = String(pkg.usage).split(" ");
            if (value && unit) {
              const unitMap = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
              const factor = unitMap[unit.toUpperCase()];
              if (factor) {
                dataLimitBytes = Math.round(parseFloat(value) * factor);
              }
            }
          }
          await this.db.upsertRadiusUser({
            username,
            password,
            groupname: pkg.name,
            rateLimit,
            dataLimitBytes,
          });
          summary.usersMigrated += 1;
        }

        for (const entry of stationPppoe) {
          const plan = entry.planId ? planMap.get(entry.planId) : null;
          const speedSource = plan?.profile || entry.profile || plan?.name || entry.name || "";
          const speedVal = String(speedSource).replace(/[^0-9.]/g, "");
          const rateLimit = speedVal ? `${speedVal}M/${speedVal}M` : "";
          await this.db.upsertRadiusUser({
            username: entry.clientname,
            password: entry.clientpassword,
            groupname: plan?.name || entry.name,
            rateLimit,
          });
          summary.pppoeMigrated += 1;
        }
      } else {
        await this.db.updateStation(station.id, { systemBasis: "API" });
        summary.stationUpdated = true;
        if (station.radiusClientName) {
          const removeResult = await removeRadiusClient({ name: station.radiusClientName });
          if (removeResult.success && removeResult.removed) {
            summary.radiusClientRemoved = true;
          }
        }
        const routerResult = await this.configureRouterForApi(platformID, station, station.radiusServerIp || radiusServerIp);
        if (routerResult.success) {
          summary.routerConfigured = true;
        } else {
          summary.warnings.push(`Station ${station.name || station.mikrotikHost}: ${routerResult.message}`);
        }

        for (const user of users) {
          const pkg = packageMap.get(user.packageID);
          if (!pkg) continue;
          const username = user.username || user.code || user.phone;
          if (username) {
            await this.db.deleteRadiusUser(username);
          }
        }

        for (const entry of stationPppoe) {
          if (entry.clientname) {
            await this.db.deleteRadiusUser(entry.clientname);
          }
        }

        const poolCache = new Map();
        for (const pkg of stationPackages) {
          let poolName = pkg.pool || "";
          if (!poolName && pkg.routerHost) {
            let pools = poolCache.get(pkg.routerHost);
            if (!pools) {
              try {
                const conn = await this.mikrotik.config.createSingleMikrotikClient(platformID, pkg.routerHost);
                if (conn?.channel) {
                  pools = await this.mikrotik.mikrotik.listPools(conn.channel);
                  await this.mikrotik.safeCloseChannel(conn.channel);
                }
              } catch { }
              poolCache.set(pkg.routerHost, pools || []);
            }
            if (pools && pools.length > 0) {
              poolName = pools[0].name || "";
              if (poolName) {
                await this.db.updatePackage(pkg.id, platformID, { pool: poolName });
                summary.packagesUpdated += 1;
              }
            } else {
              summary.warnings.push(`Package ${pkg.name}: no address pool found on ${pkg.routerHost}`);
            }
          }

          if (pkg.routerHost && poolName) {
            const rateLimit = `${pkg.speed}M/${pkg.speed}M`;
            const profileResult = await this.mikrotik.createMikrotikProfile(
              platformID,
              pkg.name,
              rateLimit,
              poolName,
              pkg.routerHost,
              pkg.devices,
              pkg.period,
              pkg.category
            );
            if (!profileResult?.success) {
              summary.warnings.push(`Package ${pkg.name}: ${profileResult?.message || "profile creation failed"}`);
            }
          }
        }

        for (const user of activeUsers) {
          const pkg = packageMap.get(user.packageID);
          if (!pkg || !pkg.routerHost) continue;
          const username = user.username || user.code || user.phone;
          if (!username) continue;
          await this.mikrotik.manageMikrotikUser({
            platformID,
            action: "add",
            profileName: pkg.name,
            host: pkg.routerHost,
            code: username,
            username,
          });
          summary.usersMigrated += 1;
        }

        if (stationPppoe.length > 0) {
          const conn = await this.mikrotik.config.createSingleMikrotikClient(platformID, station.mikrotikHost);
          if (!conn?.channel) {
            summary.warnings.push(`PPPoE: no connection to ${station.mikrotikHost}`);
          } else {
            const { channel } = conn;
            try {
              const secrets = await this.mikrotik.mikrotik.listSecrets(channel);
              for (const entry of stationPppoe) {
                const existing = secrets.find((s) => s.name === entry.clientname);
                const isdisabled = entry.status === "active" ? "no" : "yes";
                if (existing) {
                  await this.mikrotik.mikrotik.updateSecret(channel, existing[".id"], {
                    name: entry.clientname,
                    password: entry.clientpassword,
                    service: "pppoe",
                    profile: entry.profile,
                    disabled: isdisabled,
                  });
                } else {
                  await this.mikrotik.mikrotik.addSecret(channel, {
                    name: entry.clientname,
                    password: entry.clientpassword,
                    service: "pppoe",
                    profile: entry.profile,
                  });
                  if (isdisabled === "yes") {
                    const updated = await this.mikrotik.mikrotik.getSecretsByName(channel, entry.clientname);
                    if (updated?.[0]?.[".id"]) {
                      await this.mikrotik.mikrotik.updateSecret(channel, updated[0][".id"], { disabled: "yes" });
                    }
                  }
                }
                summary.pppoeMigrated += 1;
              }
            } finally {
              await this.mikrotik.safeCloseChannel(channel);
            }
          }
        }
      }

      await this.refreshDashboardStats(platformID, { role: auth.admin.role });
      return res.json({ success: true, message: `Migration to ${normalizedTarget} completed`, summary });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Migration failed", error: error?.message || error });
    }
  }
}

module.exports = { Controller };
