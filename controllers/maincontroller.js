//@ts-check

const axios = require("axios");
const https = require("https");
const fs = require("fs");
const fsp = require("fs").promises;
const { exec, execSync, execFile } = require("child_process");
const path = require("path");
const moment = require("moment");
const dns = require("dns").promises;
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const appRoot = require("app-root-path").path;
const {
  startOfDay,
  endOfDay,
  startOfMonth,
  endOfMonth,
} = require("date-fns");
const { DataBase } = require("../helpers/databaseOperation");
const { Utils } = require("../utils/Functions");
const { Mailer } = require("./mailerController");
const { SMS } = require("./smsController");
const { Auth } = require("./authController");
const { Mikrotikcontroller } = require("./mikrotikController");
const { MpesaController } = require("./mpesaController");
const cache = require("../utils/cache");

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
      if (auth.admin.role !== "superuser") {
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
      await this.db.deletDDNSByplatformID(platform.platformID);
      await this.db.deletePPPoEByplatformID(platform.platformID);
      await this.db.deleteFunds(platform.platformID);
      await this.db.deleteStationsByplatformID(platform.platformID);
      await this.db.deleteAllPlatformMikrotikBackUp(platform.platformID)
      await this.db.deleteNetworkUsages(platform.platformID)
      await this.db.deleteBills(platform.platformID)
      await this.db.deleteTwoFa(platform.platformID)
      await this.db.deleteBackups(platform.platformID)
      await this.db.deletePlatform(id);
      await this.db.deleteSessions(platform.platformID)
      await this.deleteSiteRecord(platform.url);

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

    const { token } = req.body;

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
      const cacheKey = `main:codes:today:${platformID}`;
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

      const response = {
        success: true,
        message: "Codes fetched",
        codes: newCodes,
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
      const cacheKey = `main:packages:${platformID}`;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return res.json(cached);
      }
      const packages = await this.db.getPackagesByPlatformID(platformID);
      const response = {
        success: true,
        message: "packages fetched",
        packages: packages,
      };
      this.cache.set(cacheKey, response, 60000);
      return res.json(response);
    } catch (error) {
      console.log("An error occured", error);
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
    try {
      const cacheKey = `main:settings:${platformID}`;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return res.json(cached);
      }
      const settings = await this.db.getPlatformConfig(platformID);
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

      const platformSettings = settings || {
        mpesaConsumerKey: "",
        mpesaConsumerSecret: "",
        mpesaShortCode: "",
        mpesaShortCodeType: "Phone",
        mpesaPassKey: "",
        adminID: "",
        IsC2B: true,
        IsAPI: false,
        IsB2B: false
      };

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

    const { token, data } = req.body;
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
    const { mpesaConsumerKey, mpesaConsumerSecret, mpesaShortCode, mpesaShortCodeType, mpesaAccountNumber, mpesaPassKey, IsC2B, IsAPI, IsB2B } = data;
    try {
      const existingConfig = await this.db.getPlatformConfig(platformID);
      if (IsC2B === true) {
        if (!mpesaShortCode || !mpesaShortCodeType || !adminID) {
          return res.json({
            success: false,
            message: "All MPESA fields must be filled out!",
          });
        }
        const platform = await this.db.getPlatform(platformID);
        if (!platform) {
          return res.json({
            success: false,
            message: "Missing credentials required!",
          });
        }
        const paystackdata = {
          businessName: platform.name,
          accountNumber: mpesaShortCode,
          type: mpesaShortCodeType,
          secretKey: this.PAYSTACK_SECRET_KEY,
          idOrCode: existingConfig ? existingConfig.mpesaSubAccountID : ""
        }
        const existingpaystacksubaccount = await this.fetchSubaccount(paystackdata);
        let subaccountMismatch;
        if (existingpaystacksubaccount.success) {
          subaccountMismatch = existingpaystacksubaccount.data.account_number !== mpesaShortCode;
        }

        if (!existingpaystacksubaccount.success || subaccountMismatch) {
          const creeatepaystacksubaccount = await this.createMpesaSubaccount(paystackdata);
          if (!creeatepaystacksubaccount.success) {
            return res.json({
              success: false,
              message: creeatepaystacksubaccount.message,
            });
          }
          const mpesaSubAccountCode = creeatepaystacksubaccount.data.subaccount_code;
          const mpesaSubAccountID = creeatepaystacksubaccount.data.id;
          data.mpesaSubAccountCode = mpesaSubAccountCode;
          data.mpesaSubAccountID = `${mpesaSubAccountID}`;
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
        return res.json({
          success: true,
          message: "Platform Settings created.",
        });
      }

      const updatedConfig = await this.db.updatePlatformConfig(platformID, data);
      return res.json({
        success: true,
        message: "Platform Settings updated.",
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
    if (!token || !platformID || !adminID || !name || !period || !price || !speed || !devices || !usage || !category || !pool || !host || !station) {
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
        return res.status(404).json({
          success: false,
          message: "Package does not exist!",
        });
      }
      if (profile) {
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
        pool,
        status
      };

      const packages = await this.db.updatePackage(id, platformID, data);
      return res.json({ success: true, message: "Package updated", package: packages });
    } catch (error) {
      console.log("An error occured", error);
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

    if (!token || !status || !platformID || !adminID || !name || !period || !price || !speed || !devices || !usage || !category || !pool || !host || !station) {
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

      let profileCreation;
      if (!profile) {
        const rateLimit = `${speed}M/${speed}M`;
        profileCreation = await this.mikrotik.createMikrotikProfile(
          platformID,
          name,
          rateLimit,
          pool,
          host,
          devices,
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

      const packageData = {
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
        pool,
        status,
        social
      };

      const newPackage = await this.db.createPackage(packageData);

      return res.json({
        success: true,
        message: "Package and MikroTik profile created successfully",
        package: newPackage,
        mikrotikProfile: profileCreation
      });

    } catch (error) {
      console.error("Package creation error:", error);
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
      const delProfileResult = await this.mikrotik.deleteMikrotikProfile(platformID, packagename, host);
      if (!delProfileResult.success) {
        return res.status(500).json({
          success: false,
          message: `Failed to delete MikroTik profile: ${delProfileResult.message}`,
        });
      }
      return res.json({
        success: true,
        message: "Package deleted successfully."
      });
    } catch (error) {
      console.error("An error occurred while deleting package:", error);
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
        id
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
        const sanitizeSubdomain = (name) => {
          return name
            .toLowerCase()
            .trim()
            .replace(/\s+/g, '-')
            .replace(/[^a-z0-9-]/g, '')
            .replace(/-+/g, '-')
            .replace(/^-+|-+$/g, '');
        };
        const randomness = Math.random().toString(36).substring(2, 8);
        const mikrotikWebfigHost = `${sanitizeSubdomain(name)}${randomness}-webfig.novawifi.online`;
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
        const newStation = await this.db.createStation(newData);
        stationResult = newStation;
        responseMessage = "Station added";

      } else {
        const { id, token, ...updData } = data;
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

                    const addSSL = await this.installLetsEncryptCert(WebfigHost);
                    if (!addSSL.success) {
                      return res.json({ success: false, message: "SSL installation failed." });
                    }
                  }

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
          return res.json({
            success: false,
            message: delsite.message
          });
        }
      }

      const mikrotikPublicKey = station.mikrotikPublicKey;
      fs.readFile("/etc/wireguard/wg0.conf", "utf8", (readErr, data) => {
        if (readErr) {
          console.error("Failed to read wg0.conf:", readErr);
          return res.json({ success: false, message: "Could not read WireGuard config" });
        }
        const peerBlocks = data.split(/\n(?=\[Peer])/);
        const filteredBlocks = peerBlocks.filter(
          (block) => !block.includes(`PublicKey = ${mikrotikPublicKey}`)
        );
        const updatedConfig = filteredBlocks.join("\n").trim() + "\n";
        fs.writeFile("/etc/wireguard/wg0.conf", updatedConfig, (writeErr) => {
          if (writeErr) {
            console.error("Failed to write updated wg0.conf:", writeErr);
            return res.json({ success: false, message: "Could not update WireGuard config" });
          }
          exec("sudo wg-quick down wg0 && sudo wg-quick up wg0", async (execErr, stdout, stderr) => {
            if (execErr) {
              console.error("Failed to restart WireGuard:", execErr);
              return res.json({ success: false, message: "WireGuard restart failed" });
            }
            const routerHost = station.mikrotikHost;
            const deleteAllPPPoE = await this.db.deletePPPoEByHost(routerHost)
            const deleteAllPackages = await this.db.deletePackagesByHost(routerHost)
            const deleteBackup = await this.db.deletePlatformMikrotikBackUpByHost(routerHost)

            const deletebackupfolder = await this.deleteBackupFolder(station.mikrotikHost);
            if (!deletebackupfolder?.success) {
              return res.json({
                success: false,
                message: deletebackupfolder?.message,
              });
            }
            const deletedStation = await this.db.deleteStation(id);

            return res.json({
              success: true,
              message: "Station deleted and WireGuard updated",
              data: deletedStation,
            });
          });
        });
      });

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
      if (code) {
        const codeexists = await this.db.getUserByUsername(code);
        if (codeexists) {
          return res.json({
            success: false,
            message: "Code already exists, try a different one!",
          });
        }
      }

      const host = pkg.routerHost;
      const mikrotikData = {
        platformID,
        action: "add",
        profileName,
        host,
        code,
        password,
        username
      };

      const addUserToMikrotik = await this.mikrotik.manageMikrotikUser(mikrotikData)
      if (!addUserToMikrotik) {
        return res.json({
          success: false,
          message: "Failed to add user to MikroTik",
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
          username: addUserToMikrotik.username,
          packageID: pkg.id,
          platformID: platformID,
        };
        const jwtToken = this.mpesa.createHotspotToken(tokenPayload, expiresIn);

        const code = await this.db.createUser({
          status: "active",
          platformID: platformID,
          phone: phone ? phone : "null",
          username: addUserToMikrotik.username,
          password: addUserToMikrotik.password,
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
            if (sms && sms.sentHotspot === false) return res.status(200).json({ success: false, message: "Hotspot SMS sending is disabled!" });
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
              username: addUserToMikrotik.username,
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

    const { token } = req.body;
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

      const cacheKey = `main:dashboard:${platformID}`;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return res.status(200).json(cached);
      }

      const dashboard = await this.db.getDashboardStatsBundle(platformID);
      const {
        codes = [],
        pppoe = [],
        packages = [],
        totalRevenue = 0,
        dailyRevenue = 0,
        yesterdayRevenue = 0,
        lastMonthRevenue = 0,
        thisMonthRevenue = 0,
        months = [],
        stations = [],
        totalBills = 0,
        funds: allfunds = null,
        mostPurchased = null,
        networkUsage: rawNetworkUsage = [],
        platformConfig: platformsettings = null,
      } = dashboard || {};
      const networkusage = Array.isArray(rawNetworkUsage) ? rawNetworkUsage : [];

      let IsB2B = false;
      if (platformsettings && auth.admin.role === "superuser") {
        IsB2B = platformsettings.IsB2B;
      }

      // Funds
      let balance = 0, withdrawals = 0, shortCodeBalance = 0;
      if (allfunds) {
        balance = allfunds.balance;
        withdrawals = allfunds.withdrawals;
        shortCodeBalance = allfunds.shortCodeBalance;
      }

      // Network stats (updated)
      const now = new Date();

      // usage windows
      const dailyUsage = networkusage.filter(u =>
        new Date(u.createdAt) >= startOfDay(now) && new Date(u.createdAt) <= endOfDay(now)
      );
      const monthlyUsage = networkusage.filter(u =>
        new Date(u.createdAt) >= startOfMonth(now) && new Date(u.createdAt) <= endOfMonth(now)
      );

      // helper to sum a usage array
      const sumUsage = (usage) =>
        usage.reduce(
          (acc, u) => {
            const rx = Number(u.rx) || 0;
            const tx = Number(u.tx) || 0;
            acc.rx += rx;
            acc.tx += tx;
            acc.totalBandwidth += rx + tx;
            return acc;
          },
          { rx: 0, tx: 0, totalBandwidth: 0 }
        );

      const services = ["pppoe", "hotspot"];

      // daily per-service (today = sum of all records for today)
      const dailyStats = services.map((service) => ({
        service,
        period: "daily",
        ...sumUsage(dailyUsage.filter((u) => u.service === service)),
      }));

      // monthly per-service (current month = sum of all days in the month)
      const monthlyStats = services.map((service) => ({
        service,
        period: "monthly",
        ...sumUsage(monthlyUsage.filter((u) => u.service === service)),
      }));

      // overall per-service (all time / sum of all months = sum of all records)
      const overallPerService = services.map((service) => ({
        service,
        period: "overall",
        ...sumUsage(networkusage.filter((u) => u.service === service)),
      }));

      // Totals across services for quick display
      const overallDaily = { service: "Overall", period: "daily", ...sumUsage(dailyUsage) };
      const overallMonthly = { service: "Overall", period: "monthly", ...sumUsage(monthlyUsage) };
      const overallAllTime = { service: "Overall", period: "overall", ...sumUsage(networkusage) };

      // Final combined arrays (you can change order as you prefer)
      const finalNetworkUsage = [
        ...dailyStats,
        overallDaily,
        ...monthlyStats,
        overallMonthly,
        ...overallPerService,
        overallAllTime,
      ];

      // Station user checks (parallel per station)
      let allActiveHotspotUsers = [];
      let allActivePPPoEUsers = [];
      let mikrotikFailed = true;

      if (stations.length > 0) {
        const results = await Promise.all(
          stations.map(async (station) => {
            const [hotspotRes, pppRes] = await Promise.all([
              this.mikrotik.checkHotspotUserStatus(platformID, station.mikrotikHost),
              this.mikrotik.checkPPPUserStatus(platformID, station.mikrotikHost)
            ]);
            return { hotspotRes, pppRes };
          })
        );

        for (const { hotspotRes, pppRes } of results) {
          if (hotspotRes.success) {
            mikrotikFailed = false;
            allActiveHotspotUsers = allActiveHotspotUsers.concat(hotspotRes.users);
          }
          if (pppRes.success) {
            mikrotikFailed = false;
            allActivePPPoEUsers = allActivePPPoEUsers.concat(pppRes.users);
          }
        }
      }

      // const [payments, users] = await Promise.all([
      //   this.db.getMpesaPayments(platformID),
      //   this.db.getUserByPlatform(platformID),
      // ]);

      // const userMap = new Map(
      //   users.map((u) => [String(u.code || u.username || u.password), u])
      // );

      // const completedPayments = payments.filter((p) => p.status === "COMPLETE");

      // const enrichedPayments = completedPayments.map((p) => {
      //   const codeStr = String(p.code);
      //   const user = userMap.get(codeStr);

      //   const routerData =
      //     routers.find((r) => r.mikrotikHost === user?.package?.routerHost) || null;
      //   const routerName = routerData ? routerData.name : user?.package?.routerHost || "Unknown";

      //   return {
      //     ...p,
      //     station: routerName,
      //   };
      // });

      // const stationRevenueMap = new Map();

      // enrichedPayments.forEach((p) => {
      //   const station = p.station || "Unknown";

      //   if(!stationRevenueMap.has(station)) {
      //     stationRevenueMap.set(station, { todayRevenue: 0, monthRevenue: 0 });
      //   }

      //   const revenue = Number(p.amount) || 0;
      //   const paymentDate = new Date(p.createdAt);
      //   const now = new Date();
      //   const stationData = stationRevenueMap.get(station);

      //   if(
      //     paymentDate.getFullYear() === now.getFullYear() &&
      //     paymentDate.getMonth() === now.getMonth() &&
      //     paymentDate.getDate() === now.getDate()
      //   ) {
      //     stationData.todayRevenue += revenue;
      //   }

      //   if(
      //     paymentDate.getFullYear() === now.getFullYear() &&
      //     paymentDate.getMonth() === now.getMonth()
      //   ) {
      //     stationData.monthRevenue += revenue;
      //   }
      // });

      // const stationsRevenue = Array.from(stationRevenueMap.entries()).map(
      //   ([name, data]) => ({ name, ...data })
      // );

      const stats = {
        totalUsers: codes.length,
        totalPPPoEUsers: pppoe.length,
        totalUsersOnline: mikrotikFailed ? 0 : allActiveHotspotUsers.length,
        totalPPPoEUsersOnline: mikrotikFailed ? 0 : allActivePPPoEUsers.length,
        totalPackages: packages.length,
        totalRevenue: totalRevenue || 0,
        dailyRevenue: dailyRevenue || 0,
        yesterdayRevenue: yesterdayRevenue || 0,
        routers: stations.length,
        thismonthRevenue: thisMonthRevenue || 0,
        lastmonthRevenue: lastMonthRevenue || 0,
        months,
        mostpurchased: mostPurchased ? mostPurchased.name : ""
      };

      const funds = {
        balance,
        withdrawals,
        bills: totalBills || 0,
        shortCodeBalance
      };

      const response = {
        success: true,
        message: "Dashboard stats fetched",
        stats,
        funds,
        networkusage: finalNetworkUsage,
        IsB2B,
        // stationsRevenue
      };
      this.cache.set(cacheKey, response, 20000);
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

      const deleteuser = await this.db.deleteUser(id);
      if (!pkg) {
        return res.json({
          success: true,
          message: "User removed but No package found!",
        });
      }

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

    const { token, station } = req.body;

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
      const cacheKey = `main:pppoe:${platformID}:${station || "all"}`;
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

        const response = {
          success: true,
          message: "MikroTik unreachable, forced Offline for all",
          pppoe: newPPPoEs,
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

      const response = {
        success: true,
        message: "PPPoE fetched successfully!",
        pppoe: newPPPoEs,
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

  generateToken(adminID, platformID) {
    return jwt.sign({ adminID, platformID }, this.JWT_SECRET, {
      expiresIn: "30d",
    });
  };

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
      if (!hash) {
        packages = await this.db.getPackages(platformID);
      } else {
        const host = Utils.decodeHashedIP(hash);
        packages = await this.db.getPackagesByHost(platformID, host);
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
        return res.json({ type: "error", message: "No codes found." });
      }

      const validCodes = foundcodes.filter(code => code !== null);

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

      const provision = await this.provisionReverseProxyAndSSL(url, "http://127.0.0.1:3001");
      if (!provision.success) {
        return res.json({
          success: false,
          message: provision.message || "Reverse proxy/SSL provisioning failed, try again.",
          error: provision.error
        });
      }

      const saltRounds = 10;
      const adminpass = "Sss333123##";
      const hashedPassword = await bcrypt.hash(password, saltRounds);
      const adminhashedPassword = await bcrypt.hash(adminpass, saltRounds);
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

    return new Promise((resolve) => {
      execFile(
        "sudo",
        ["-n", "certbot", "--nginx", "-d", safeDomain, "--non-interactive", "--agree-tos", "-m", "admin@novawifi.co.ke"],
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
    const ssl = await this.installLetsEncryptCert(domain);
    if (!ssl.success) return ssl;
    return { success: true, message: "Reverse proxy and SSL provisioned successfully." };
  }

  async deleteSiteRecord(domain) {
    const cmd = `clpctl site:delete --domainName=${domain} --force`;

    return new Promise((resolve) => {
      exec(cmd, (err, stdout, stderr) => {
        const output = stdout?.toString() || '';
        const errorOutput = stderr?.toString() || err?.message || '';

        if (output.includes('does not exist')) {
          return resolve({
            success: true,
            message: `Site ${domain} does not exist, skipping delete.`,
          });
        }

        if (err) {
          console.error(`[Delete] ERROR:`, errorOutput);
          return resolve({
            success: false,
            message: `Delete site failed for ${domain}`,
            error: errorOutput,
            stdout: output,
          });
        }

        console.log(`[Delete] SUCCESS: ${output}`);
        resolve({
          success: true,
          message: `Deleted site ${domain}`,
          output,
        });
      });
    });
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
      if (!auth.success || !auth.admin) {
        return res.json({ success: false, message: auth.message });
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
}

module.exports = { Controller };
