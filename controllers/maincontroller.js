const axios = require("axios");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs").promises;
const { exec, execSync, execFile } = require("child_process");
const path = require("path");
const os = require("os");
const moment = require("moment");
const dns = require("dns").promises;
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const appRoot = require("app-root-path").path;
const { Prisma } = require("@prisma/client");
const { DataBase } = require("../helpers/databaseOperation");
const { Utils } = require("../utils/Functions");
const { getHotspotHash, renderOfflineBoxLoginTemplate } = require("../utils/hotspotTemplate");
const { Mailer } = require("./mailerController");
const { SMS } = require("./smsController");
const { Auth } = require("./authController");
const { Mikrotikcontroller } = require("./mikrotikController");
const { MpesaController } = require("./mpesaController");
const { socketManager } = require("./socketController");
const cache = require("../utils/cache");
const { ensureRadiusClient, getRadiusClientIp, getRadiusClientSecret, getRadiusServerIp, removeRadiusClient } = require("../utils/radiusConfig");
const { getMikrotikRescueConfig } = require("../utils/mikrotikRescue");
const { WebdockService } = require("../services/webdockService");

class Controller {
  constructor() {
    this.db = new DataBase();
    this.mailer = new Mailer();
    this.sms = new SMS();
    this.auth = new Auth();
    this.mikrotik = new Mikrotikcontroller();
    this.mpesa = new MpesaController();
    this.cache = cache;
    this.webdock = new WebdockService();

    this.ENVIRONMENT = process.env.ENVIRONMENT || process.env.NODE_ENV;
    this.PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || "";
    this.JWT_SECRET = process.env.JWT_SECRET || "";
    // Ensure older DB implementations without upsertPlatformNotification don't crash
    try {
      if (this.db && typeof this.db.upsertPlatformNotification !== "function" && typeof this.db.createPlatformNotification === "function") {
        this.db.upsertPlatformNotification = async (platformID, title, data) => {
          return this.db.createPlatformNotification({ platformID, title, ...data });
        };
      }
    } catch (e) {
      console.warn("Error setting up db.upsertPlatformNotification fallback:", e);
    }
  }

  notifyNewPlatformCreatedSilently(platform = {}, admin = {}) {
    Promise.resolve().then(async () => {
      try {
        const platformName = String(platform?.name || "Unknown platform").trim();
        const phone = String(admin?.phone || platform?.phone || "").trim();
        const url = String(platform?.url || "").trim();
        const message = `New platform created: ${platformName}. Phone: ${phone || "N/A"}${url ? `. URL: ${url}` : ""}`;

        await this.sms.sendInternalSMS("0723551116", message, { silent: true });
      } catch (_) {
        // Silent notification only. Platform creation must never depend on this SMS.
      }
    });
  }

  logPlatform(platformID, message, meta = {}) {
    socketManager.log(platformID, message, {
      context: meta.context || "main",
      level: meta.level || "info",
      ...meta,
    });
  }

  async findRadiusStationSharingClientIp(radiusClientIp, currentStationId = "") {
    const ip = String(radiusClientIp || "").trim();
    if (!ip || !this.db?.getAllStations) return null;
    try {
      const stations = await this.db.getAllStations();
      return (stations || []).find((station) =>
        String(station?.id || "") !== String(currentStationId || "") &&
        String(station?.radiusClientIp || "").trim() === ip &&
        String(station?.radiusClientSecret || "").trim()
      ) || null;
    } catch (_error) {
      return null;
    }
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

  normalizePlatformPlan(plan) {
    const normalized = String(plan || "basic").trim().toLowerCase();
    if (normalized === "stater") return "starter";
    if (["basic", "starter", "professional"].includes(normalized)) return normalized;
    return "basic";
  }

  isTrialLimitedPlan(plan) {
    return ["basic", "starter"].includes(this.normalizePlatformPlan(plan));
  }

  getAccountPlan(plan) {
    const plans = {
      basic: { id: "basic", name: "Basic", price: 500, trialDays: 3 },
      starter: { id: "starter", name: "Starter", price: 999, trialDays: 3 },
      professional: { id: "professional", name: "Professional", price: 2499, trialDays: 0 },
    };
    return plans[this.normalizePlatformPlan(plan)] || plans.basic;
  }

  getDedicatedServerPricing() {
    return {
      baseMonthlyKes: Number(process.env.DEDICATED_SERVER_BASE_PRICE_KES || 0),
      cpuThreadKes: Number(process.env.DEDICATED_SERVER_CPU_THREAD_PRICE_KES || 500),
      ramGbKes: Number(process.env.DEDICATED_SERVER_RAM_GB_PRICE_KES || 350),
      diskGbKes: Number(process.env.DEDICATED_SERVER_DISK_GB_PRICE_KES || 40),
      networkGbpsKes: Number(process.env.DEDICATED_SERVER_NETWORK_GBPS_PRICE_KES || 0),
    };
  }

  calculateDedicatedServerPrice(current = {}, requested = {}) {
    const pricing = this.getDedicatedServerPricing();
    const currentCpu = Number(current.cpuThreads || this.webdock.defaultCpuThreads);
    const currentRam = Number(current.ramGb || this.webdock.defaultRamGb);
    const currentDisk = Number(current.diskGb || this.webdock.defaultDiskGb);
    const currentNetwork = Number(current.networkBandwidth || this.webdock.defaultNetworkBandwidth);
    const nextCpu = Math.max(currentCpu, Number(requested.cpuThreads || currentCpu));
    const nextRam = Math.max(currentRam, Number(requested.ramGb || currentRam));
    const nextDisk = Math.max(currentDisk, Number(requested.diskGb || currentDisk));
    const nextNetwork = Math.max(currentNetwork, Number(requested.networkBandwidth || currentNetwork));
    const additionalMonthlyKes =
      Math.max(0, nextCpu - currentCpu) * pricing.cpuThreadKes +
      Math.max(0, nextRam - currentRam) * pricing.ramGbKes +
      Math.max(0, nextDisk - currentDisk) * pricing.diskGbKes +
      Math.max(0, nextNetwork - currentNetwork) * pricing.networkGbpsKes;

    return {
      additionalMonthlyKes,
      resources: {
        cpuThreads: nextCpu,
        ramGb: nextRam,
        diskGb: nextDisk,
        networkBandwidth: nextNetwork,
      },
      pricing,
    };
  }

  isPaidBillStatus(status) {
    return String(status || "").trim().toLowerCase() === "paid";
  }

  isPremiumPlatform(platform) {
    return String(platform?.status || "").trim().toLowerCase() === "premium";
  }

  addDays(date, days) {
    const next = new Date(date || Date.now());
    next.setDate(next.getDate() + days);
    return next;
  }

  parseFlexibleTrial({ plan, baseDate = new Date(), trialMode, trialDays, trialEndsAt, currentTrialEndsAt }) {
    const mode = String(trialMode || "").trim().toLowerCase();
    if (mode === "disabled" || mode === "none") {
      return { hasValue: true, value: null };
    }

    if (mode === "date" || trialEndsAt !== undefined) {
      const text = String(trialEndsAt || "").trim();
      if (!text) return { hasValue: mode === "date", value: null };
      const date = new Date(text);
      if (Number.isNaN(date.getTime())) {
        return { hasValue: true, error: "Invalid trial end date." };
      }
      return { hasValue: true, value: date };
    }

    if (mode === "days" || trialDays !== undefined) {
      const days = Number(trialDays);
      if (!Number.isFinite(days) || days < 0 || days > 365) {
        return { hasValue: true, error: "Trial days must be between 0 and 365." };
      }
      return { hasValue: true, value: this.addDays(baseDate, Math.floor(days)) };
    }

    if (currentTrialEndsAt !== undefined) {
      return { hasValue: false, value: currentTrialEndsAt || null };
    }

    const defaultDays = this.getAccountPlan(plan).trialDays;
    if (defaultDays > 0) {
      return { hasValue: true, value: this.addDays(baseDate, defaultDays) };
    }
    return { hasValue: true, value: null };
  }

  normalizeFundsPayload(payload = {}) {
    const moneyFields = ["balance", "withdrawals", "deposits", "shortCodeBalance"];
    const data = {};
    for (const field of moneyFields) {
      if (payload[field] === undefined) continue;
      const amount = Number(String(payload[field] || "0").replace(/,/g, ""));
      if (!Number.isFinite(amount) || amount < 0) {
        return { error: `${field} must be a valid non-negative amount.` };
      }
      data[field] = amount.toFixed(2);
    }
    if (payload.shortIdentifier !== undefined) {
      const shortIdentifier = String(payload.shortIdentifier || "").trim();
      data.shortIdentifier = shortIdentifier || "null";
    }
    return { data };
  }

  parseDataLimitBytes(value) {
    if (!value) return null;
    const text = String(value).trim();
    if (!text || /^unlimited$/i.test(text)) return null;
    const match = text.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)$/i);
    if (!match) return null;
    const amount = Number(match[1]);
    const unit = match[2].toUpperCase();
    const unitMap = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
    const factor = unitMap[unit];
    if (!Number.isFinite(amount) || amount <= 0 || !factor) return null;
    return Math.round(amount * factor);
  }

  getBillingDueDate(platform, service, plan) {
    const normalizedPlan = this.normalizePlatformPlan(plan);
    if (this.isTrialLimitedPlan(normalizedPlan)) {
      return platform?.trialEndsAt || this.addDays(platform?.createdAt || new Date(), 3);
    }
    if (!service?.period) return null;

    const match = service.period.toLowerCase().match(/^(\d+)\s+(hour|minute|day|month|year)s?$/i);
    if (!match) return null;

    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    let dueDate = Utils.addPeriod(platform?.createdAt || new Date(), value, unit);
    const now = new Date();
    while (dueDate <= now) {
      dueDate = Utils.addPeriod(dueDate, value, unit);
    }
    return dueDate;
  }

  async notifyPlatform(platformID, title, data) {
    if (!platformID || !title) return null;
    try {
      if (this.db && typeof this.db.upsertPlatformNotification === "function") {
        return await this.db.upsertPlatformNotification(platformID, title, data);
      }
      if (this.db && typeof this.db.createPlatformNotification === "function") {
        return await this.db.createPlatformNotification({ platformID, title, ...data });
      }
      console.warn("notifyPlatform: no suitable db notification method available");
      return null;
    } catch (error) {
      console.error("Error notifying platform:", error);
      return null;
    }
  }

  async ensurePlatformBillingService(platformID) {
    if (!platformID) return null;
    const platform = await this.db.getPlatformByplatformID(platformID);
    if (!platform) return null;

    const service = await this.db.getSystemServiceByKey("billing");
    if (!service) return null;

    const plan = this.getAccountPlan(platform.subscriptionPlan);
    const isPremium = this.isPremiumPlatform(platform);
    const amount = String(plan.price);
    const dueDate = this.getBillingDueDate(platform, service, plan.id);
    const existing = await this.db.getPlatformBillingByName(service.name, platformID);
    const data = {
      name: service.name,
      platformID,
      amount: isPremium ? "0" : amount,
      price: amount,
      currency: service.currency,
      period: service.period,
      dueDate: isPremium ? null : dueDate,
      description: service.description,
      meta: { serviceKey: "billing", plan: plan.id, premium: isPremium },
    };

    if (!existing) {
      return this.db.createPlatformBilling({ ...data, status: isPremium ? "Paid" : "Unpaid" });
    }

    if (isPremium) {
      return this.db.updatePlatformBilling(existing.id, {
        ...data,
        status: "Paid",
        paidAt: existing.paidAt || new Date(),
      });
    }

    if (String(existing.status || "").toLowerCase() === "paid") {
      return existing;
    }

    return this.db.updatePlatformBilling(existing.id, data);
  }

  async enforcePlatformSubscription(platformID) {
    if (!platformID) return null;
    await this.ensurePlatformBillingService(platformID);
    const platform = await this.db.getPlatformByplatformID(platformID);
    if (!platform) return null;
    if (this.isPremiumPlatform(platform)) {
      return { ...platform, subscriptionPlan: this.normalizePlatformPlan(platform.subscriptionPlan) };
    }

    const plan = this.normalizePlatformPlan(platform.subscriptionPlan);
    const trialEndsAt = platform.trialEndsAt || this.addDays(platform.createdAt, 3);
    const unpaidBills = await this.getUnpaidPlatformBilling(platformID);
    const hasUnpaidAmount = unpaidBills.some((bill) => Number(bill?.amount || 0) > 0);
    const shouldDisable =
      this.isTrialLimitedPlan(plan) &&
      hasUnpaidAmount &&
      new Date(trialEndsAt).getTime() < Date.now();

    if (shouldDisable && String(platform.status || "").toLowerCase() !== "inactive") {
      await this.db.updatePlatform(platformID, { status: "inactive" });
      platform.status = "inactive";
    }

    const unpaidBill = unpaidBills.find((bill) => Number(bill?.amount || 0) > 0);
    if (shouldDisable && unpaidBill) {
      await this.db.upsertPlatformNotification(platformID, "Platform disabled: payment required", {
        message: `Your ${plan} plan trial ended and KES ${unpaidBill.amount} is unpaid. Pay now to reactivate your platform.`,
        status: "error",
        actionLabel: "Pay Now",
        actionUrl: "/admin/bills",
      });
    } else if (this.isTrialLimitedPlan(plan) && hasUnpaidAmount && unpaidBill) {
      const daysLeft = Math.max(0, Math.ceil((new Date(trialEndsAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
      await this.db.upsertPlatformNotification(platformID, "Trial payment due", {
        message: `Your ${plan} plan has ${daysLeft} day(s) left before it is disabled. Amount due: KES ${unpaidBill.amount}.`,
        status: "info",
        actionLabel: "Pay Bill",
        actionUrl: "/admin/bills",
      });
    }

    return { ...platform, subscriptionPlan: plan, trialEndsAt };
  }

  async getUnpaidPlatformBilling(platformID) {
    if (!platformID) return [];
    if (typeof this.db.getUnpaidPlatformBilling === "function") {
      return this.db.getUnpaidPlatformBilling(platformID);
    }

    const bills = await this.db.getPlatformBilling(platformID);
    return (Array.isArray(bills) ? bills : [])
      .filter((bill) => !this.isPaidBillStatus(bill?.status))
      .sort((a, b) => {
        const left = a?.dueDate ? new Date(a.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
        const right = b?.dueDate ? new Date(b.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
        return left - right;
      });
  }

  getIntaSendBaseUrl() {
    return this.ENVIRONMENT === "production"
      ? "https://api.intasend.com"
      : "https://sandbox.intasend.com";
  }

  getIntaSendSecretKey() {
    return process.env.INTASEND_SECRET_KEY || "";
  }

  async intasendRequest(method, resource, data = null) {
    const secretKey = this.getIntaSendSecretKey();
    if (!secretKey) {
      throw new Error("IntaSend secret key is not configured.");
    }
    const response = await axios({
      method,
      url: `${this.getIntaSendBaseUrl()}${resource}`,
      data,
      timeout: 20000,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        Authorization: `Bearer ${secretKey}`,
      },
    });
    return response.data;
  }

  getBillCardAutopay(bill) {
    const meta = bill?.meta && typeof bill.meta === "object" ? bill.meta : {};
    return meta.cardAutopay && typeof meta.cardAutopay === "object" ? meta.cardAutopay : null;
  }

  async updateBillCardAutopay(bill, cardAutopay) {
    const meta = bill?.meta && typeof bill.meta === "object" ? { ...bill.meta } : {};
    const cleanCardAutopay = Object.fromEntries(
      Object.entries(cardAutopay || {}).filter(([, value]) => value !== undefined)
    );
    meta.cardAutopay = {
      ...(meta.cardAutopay || {}),
      ...cleanCardAutopay,
      updatedAt: new Date().toISOString(),
    };
    return this.db.updatePlatformBilling(bill.id, { meta });
  }

  splitCustomerName(name, email) {
    const parts = String(name || email || "Nova Customer").trim().split(/\s+/).filter(Boolean);
    return {
      first_name: parts[0] || "Nova",
      last_name: parts.slice(1).join(" ") || "Customer",
    };
  }

  getClientBaseUrl() {
    return process.env.CLIENT_URL || process.env.NEXT_PUBLIC_CLIENT_URL || "https://novawifi.online";
  }

  getServerBaseUrl() {
    return process.env.SERVER_URL || process.env.NEXT_PUBLIC_SERVER_URL || "https://api.novawifi.online";
  }

  getPaystackSecretKey() {
    return process.env.PAYSTACK_SECRET_KEY || "";
  }

  async paystackRequest(method, resource, data = null) {
    const secretKey = this.getPaystackSecretKey();
    if (!secretKey) {
      throw new Error("Paystack secret key is not configured.");
    }
    const response = await axios({
      method,
      url: `https://api.paystack.co${resource}`,
      data,
      timeout: 20000,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        Authorization: `Bearer ${secretKey}`,
      },
    });
    return response.data;
  }

  buildCardBillingReference(platformID, billID) {
    return `nc:${platformID}:${String(billID || "").replace(/-/g, "")}`;
  }

  buildPaystackBillReference(platformID, billID) {
    return `ncp.${platformID}.${String(billID || "").replace(/-/g, "")}.${Date.now()}`;
  }

  parseCardBillingReference(reference) {
    const referenceText = String(reference || "");
    const paystackParts = referenceText.split(".");
    if (paystackParts.length === 4 && ["ncp", "ncr"].includes(paystackParts[0])) {
      const compactBillID = paystackParts[2];
      const uuidMatch = compactBillID.match(/^([a-f0-9]{8})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{12})$/i);
      if (!uuidMatch) return null;
      return {
        provider: "paystack",
        type: paystackParts[0] === "ncr" ? "retry" : "checkout",
        platformID: paystackParts[1],
        billID: uuidMatch.slice(1).join("-"),
      };
    }

    const parts = referenceText.split(":");
    if (parts.length !== 3 && parts.length !== 4) return null;
    if (["ncp", "ncr"].includes(parts[0])) {
      const compactBillID = parts[2];
      const uuidMatch = compactBillID.match(/^([a-f0-9]{8})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{12})$/i);
      if (!uuidMatch) return null;
      return {
        provider: "paystack",
        type: parts[0] === "ncr" ? "retry" : "checkout",
        platformID: parts[1],
        billID: uuidMatch.slice(1).join("-"),
      };
    }
    if (parts[0] === "nova-card") {
      return { provider: "intasend", platformID: parts[1], billID: parts[2] };
    }
    if (parts[0] !== "nc") return null;

    const compactBillID = parts[2];
    const uuidMatch = compactBillID.match(/^([a-f0-9]{8})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{12})$/i);
    if (!uuidMatch) return null;
    return {
      provider: "intasend",
      platformID: parts[1],
      billID: uuidMatch.slice(1).join("-"),
    };
  }

  mapPaystackTransactionStatus(status) {
    const normalized = String(status || "").toLowerCase();
    if (normalized === "success") return "COMPLETE";
    if (["failed", "reversed", "abandoned"].includes(normalized)) return "FAILED";
    return "PENDING";
  }

  getPaystackCardMask(transaction) {
    const auth = transaction?.authorization || {};
    const last4 = auth.last4 ? String(auth.last4) : "";
    const brand = auth.card_type || auth.brand || "Card";
    return last4 ? `${brand} **** ${last4}` : "";
  }

  verifyPaystackWebhook(req) {
    const secretKey = this.getPaystackSecretKey();
    const signature = req.headers["x-paystack-signature"];
    if (!secretKey || !signature) return false;
    const body = req.rawBody || JSON.stringify(req.body || {});
    const hash = crypto.createHmac("sha512", secretKey).update(body).digest("hex");
    try {
      return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(String(signature)));
    } catch (_error) {
      return false;
    }
  }

  async settlePaystackBillTransaction(transaction) {
    const reference = transaction?.reference;
    const parsedReference = this.parseCardBillingReference(reference);
    if (!parsedReference || parsedReference.provider !== "paystack") {
      return { success: true, ignored: true, message: "Ignored unrelated transaction." };
    }

    const { platformID, billID } = parsedReference;
    const bill = await this.db.getPlatformBillingByID(billID);
    if (!bill || bill.platformID !== platformID) {
      return { success: false, message: "Bill not found." };
    }

    const status = this.mapPaystackTransactionStatus(transaction.status);
    const amount = Number(transaction.amount || 0) / 100;
    const fees = Number(transaction.fees || 0) / 100;
    const customer = transaction.customer || {};
    const authorization = transaction.authorization || {};
    const paymentData = {
      platformID,
      amount: String(amount || bill.amount || bill.price || "0"),
      code: reference,
      reqcode: reference,
      phone: customer.email || customer.phone || "card",
      status,
      service: "bill",
      paymentMethod: "PAYSTACK-CARD",
      reason: null,
      referenceID: billID,
      type: "deposit",
      charges: fees ? fees.toFixed(2) : "0.00",
      failed_reason: transaction.gateway_response || transaction.message || "null",
      FirstName: customer.first_name || "N/A",
      LastName: customer.last_name || "N/A",
      verified: status === "COMPLETE",
    };

    let payment = await this.db.getMpesaCode(reference);
    const wasComplete = String(payment?.status || "").toUpperCase() === "COMPLETE";
    if (!payment) {
      payment = await this.db.addMpesaCode(paymentData);
    } else if (payment.status !== status || payment.verified !== paymentData.verified) {
      payment = await this.db.updateMpesaCodeByID(payment.id, {
        status,
        charges: paymentData.charges,
        failed_reason: paymentData.failed_reason,
        verified: paymentData.verified,
      });
    }

    await this.updateBillCardAutopay(bill, {
      provider: "paystack",
      status,
      reference,
      setupUrl: null,
      paymentMethod: "PAYSTACK-CARD",
      cardMask: this.getPaystackCardMask(transaction),
      cardType: authorization.card_type || authorization.brand,
      cardExpiry: authorization.exp_month && authorization.exp_year ? `${authorization.exp_month}/${authorization.exp_year}` : undefined,
      authorizationCode: authorization.authorization_code,
      authorizationReusable: authorization.reusable,
      customerEmail: customer.email,
      amount: paymentData.amount,
      currency: transaction.currency || bill.currency || "KES",
      paidAt: status === "COMPLETE" ? new Date().toISOString() : undefined,
      paystackTransactionID: transaction.id,
    });

    if (status === "COMPLETE" && payment && !wasComplete) {
      await this.mpesa.completePaymentForService(payment);
    }

    return { success: true, status, payment };
  }

  async fetchCardBilling(req, res) {
    const { token } = req.body || {};
    if (!token) return res.json({ success: false, message: "Missing credentials required!" });
    try {
      const auth = await this.auth.AuthenticateRequest(token);
      if (!auth.success || !auth.admin) return res.json({ success: false, message: auth.message });
      if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });

      const bills = await this.db.getPlatformBilling(auth.admin.platformID);
      const cards = (Array.isArray(bills) ? bills : [])
        .map((bill) => ({ billID: bill.id, billName: bill.name, cardAutopay: this.getBillCardAutopay(bill) }))
        .filter((entry) => entry.cardAutopay);
      return res.json({ success: true, cards });
    } catch (error) {
      console.error("Card billing fetch error:", error);
      return res.json({ success: false, message: "Failed to fetch card billing." });
    }
  }

  async setupCardBilling(req, res) {
    const { token, billID } = req.body || {};
    if (!token || !billID) return res.json({ success: false, message: "Missing credentials required!" });
    try {
      const auth = await this.auth.AuthenticateRequest(token);
      if (!auth.success || !auth.admin) return res.json({ success: false, message: auth.message });
      if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });

      const platformID = auth.admin.platformID;
      const [platform, bill] = await Promise.all([
        this.db.getPlatform(platformID),
        this.db.getPlatformBillingByID(billID),
      ]);
      if (!platform || !bill || bill.platformID !== platformID) {
        return res.json({ success: false, message: "Bill not found." });
      }

      const existing = this.getBillCardAutopay(bill);
      if (existing?.provider === "paystack" && existing?.setupUrl && ["PENDING", "PROCESSING"].includes(String(existing.status || "").toUpperCase())) {
        return res.json({
          success: true,
          message: "Paystack card checkout already exists.",
          cardAutopay: existing,
          setupUrl: existing.setupUrl,
        });
      }

      const amount = Number(bill.amount || 0);
      const billIsPaid = ["PAID", "COMPLETE", "COMPLETED"].includes(String(bill.status || "").toUpperCase());
      if (billIsPaid || amount <= 0) {
        return res.json({ success: false, message: "This bill is already paid. There is no amount due for card payment." });
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.json({ success: false, message: "Bill amount due is invalid." });
      }

      const reference = this.buildPaystackBillReference(platformID, bill.id);
      const email = auth.admin.email || platform.email || `billing-${platformID}@novawifi.local`;
      const transaction = await this.paystackRequest("post", "/transaction/initialize", {
        amount: String(Math.round(amount * 100)),
        email,
        currency: bill.currency || "KES",
        reference,
        callback_url: `${this.getServerBaseUrl()}/req/paystack/cardBilling/callback`,
        channels: ["card"],
        metadata: {
          platformID,
          billID: bill.id,
          billName: bill.name || "Nova Billing",
          custom_fields: [
            {
              display_name: "Bill",
              variable_name: "bill",
              value: bill.name || "Nova Billing",
            },
          ],
        },
      });
      const paystackData = transaction?.data || {};

      const cardAutopay = {
        provider: "paystack",
        status: "PENDING",
        reference,
        accessCode: paystackData.access_code,
        setupUrl: paystackData.authorization_url,
        paymentMethod: "PAYSTACK-CARD",
        amount: amount.toFixed(2),
        currency: bill.currency || "KES",
        initializedAt: new Date().toISOString(),
      };
      await this.updateBillCardAutopay(bill, cardAutopay);
      await this.db.addMpesaCode({
        platformID,
        amount: amount.toFixed(2),
        code: reference,
        reqcode: reference,
        phone: email,
        status: "PENDING",
        service: "bill",
        paymentMethod: "PAYSTACK-CARD",
        reason: null,
        referenceID: bill.id,
        type: "deposit",
        charges: "0.00",
        failed_reason: "null",
      });

      return res.json({
        success: true,
        message: "Paystack card checkout created.",
        setupUrl: paystackData.authorization_url,
        cardAutopay,
      });
    } catch (error) {
      console.error("Card billing setup error:", error?.response?.data || error);
      return res.json({ success: false, message: error?.response?.data?.detail || error.message || "Failed to create card billing setup." });
    }
  }

  async cancelCardBilling(req, res) {
    const { token, billID } = req.body || {};
    if (!token || !billID) return res.json({ success: false, message: "Missing credentials required!" });
    try {
      const auth = await this.auth.AuthenticateRequest(token);
      if (!auth.success || !auth.admin) return res.json({ success: false, message: auth.message });
      if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });

      const bill = await this.db.getPlatformBillingByID(billID);
      if (!bill || bill.platformID !== auth.admin.platformID) {
        return res.json({ success: false, message: "Bill not found." });
      }
      const cardAutopay = this.getBillCardAutopay(bill);
      if (cardAutopay?.provider === "paystack") {
        await this.updateBillCardAutopay(bill, {
          status: "CANCELED",
          setupUrl: null,
          canceledAt: new Date().toISOString(),
        });
        return res.json({ success: true, message: "Paystack card checkout canceled." });
      }
      if (!cardAutopay?.subscriptionID) {
        return res.json({ success: false, message: "No card billing subscription found." });
      }

      await this.intasendRequest("post", `/api/v1/subscriptions/${cardAutopay.subscriptionID}/unsubscribe/`, {});
      await this.updateBillCardAutopay(bill, {
        status: "CANCELED",
        canceledAt: new Date().toISOString(),
      });
      return res.json({ success: true, message: "Card billing canceled." });
    } catch (error) {
      console.error("Card billing cancel error:", error?.response?.data || error);
      return res.json({ success: false, message: error?.response?.data?.detail || "Failed to cancel card billing." });
    }
  }

  async intasendSubscriptionWebhook(req, res) {
    try {
      const payload = req.body || {};
      const expectedChallenge = process.env.INTASEND_WEBHOOK_CHALLENGE || process.env.INTASEND_SUBSCRIPTION_WEBHOOK_CHALLENGE;
      if (expectedChallenge && String(payload.challenge || "") !== String(expectedChallenge)) {
        return res.status(401).json({ success: false, message: "Invalid webhook challenge." });
      }

      const parsedReference = this.parseCardBillingReference(payload.reference);
      if (!parsedReference) {
        return res.json({ success: true, message: "Ignored unrelated subscription." });
      }

      const { platformID, billID } = parsedReference;
      const bill = await this.db.getPlatformBillingByID(billID);
      if (!bill || bill.platformID !== platformID) {
        return res.json({ success: false, message: "Bill not found." });
      }

      const latestPayment = Array.isArray(payload.payments) ? payload.payments[payload.payments.length - 1] : null;
      const invoice = latestPayment?.invoice || {};
      const invoiceID = invoice.invoice_id || latestPayment?.transaction_id || payload.subscription_id;
      const invoiceState = String(invoice.state || payload.status || "").toUpperCase();
      const status = invoiceState === "COMPLETE" || invoiceState === "ACTIVE" ? "COMPLETE" : invoiceState === "FAILED" ? "FAILED" : "PENDING";

      await this.updateBillCardAutopay(bill, {
        status: payload.status || status,
        subscriptionID: payload.subscription_id,
        setupUrl: payload.setup_url,
        cardMask: payload.card_mask,
        cardType: payload.card_type,
        cardExpiry: payload.card_expiry,
        paymentMethod: payload.payment_method || "CARD-PAYMENT",
        nextDate: payload.next_date,
        completedCycles: payload.completed_cycles,
        failReason: payload.fail_reason || invoice.failed_reason,
        lastInvoiceID: invoiceID,
      });

      if (invoiceID) {
        const existingPayment = await this.db.getMpesaCode(invoiceID);
        if (!existingPayment) {
          const amount = String(invoice.value || payload.plan?.amount || bill.price || bill.amount || "0");
          const payment = await this.db.addMpesaCode({
            platformID,
            amount,
            code: invoiceID,
            reqcode: invoiceID,
            phone: payload.customer?.email || "card",
            status,
            service: "bill",
            paymentMethod: "CARD-PAYMENT",
            reason: null,
            referenceID: billID,
            type: "deposit",
            charges: String(invoice.charges || "0.00"),
            failed_reason: invoice.failed_reason || payload.fail_reason || "null",
          });
          if (status === "COMPLETE") {
            await this.mpesa.completePaymentForService(payment);
          }
        } else if (existingPayment.status !== status) {
          const payment = await this.db.updateMpesaCodeByID(existingPayment.id, {
            status,
            charges: String(invoice.charges || existingPayment.charges || "0.00"),
            failed_reason: invoice.failed_reason || payload.fail_reason || existingPayment.failed_reason,
          });
          if (status === "COMPLETE") {
            await this.mpesa.completePaymentForService(payment);
          }
        }
      }

      return res.json({ success: true });
    } catch (error) {
      console.error("IntaSend subscription webhook error:", error);
      return res.status(500).json({ success: false, message: "Webhook processing failed." });
    }
  }

  async verifyPaystackCardBilling(req, res) {
    const { token, reference } = req.body || {};
    if (!token || !reference) return res.json({ success: false, message: "Missing credentials required!" });
    try {
      const auth = await this.auth.AuthenticateRequest(token);
      if (!auth.success || !auth.admin) return res.json({ success: false, message: auth.message });
      if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });

      const parsedReference = this.parseCardBillingReference(reference);
      if (!parsedReference || parsedReference.provider !== "paystack" || parsedReference.platformID !== auth.admin.platformID) {
        return res.json({ success: false, message: "Invalid Paystack bill reference." });
      }

      const verification = await this.paystackRequest("get", `/transaction/verify/${encodeURIComponent(reference)}`);
      const result = await this.settlePaystackBillTransaction(verification?.data);
      return res.json({
        success: Boolean(result.success),
        message: result.success ? "Paystack payment verified." : result.message || "Paystack payment verification failed.",
        status: result.status,
      });
    } catch (error) {
      console.error("Paystack card billing verify error:", error?.response?.data || error);
      return res.json({ success: false, message: error?.response?.data?.message || "Failed to verify Paystack payment." });
    }
  }

  async paystackCardBillingCallback(req, res) {
    const reference = req.query?.reference || req.query?.trxref;
    try {
      if (reference) {
        const verification = await this.paystackRequest("get", `/transaction/verify/${encodeURIComponent(reference)}`);
        await this.settlePaystackBillTransaction(verification?.data);
      }
    } catch (error) {
      console.error("Paystack card billing callback error:", error?.response?.data || error);
    }
    return res.redirect(`${this.getClientBaseUrl()}/admin/bills`);
  }

  async paystackCardBillingWebhook(req, res) {
    try {
      if (!this.verifyPaystackWebhook(req)) {
        return res.status(401).json({ success: false, message: "Invalid Paystack signature." });
      }
      const payload = req.body || {};
      if (payload.event !== "charge.success") {
        return res.json({ success: true, message: "Ignored Paystack event." });
      }
      const result = await this.settlePaystackBillTransaction(payload.data);
      return res.json({ success: Boolean(result.success), message: result.message || "Paystack webhook processed." });
    } catch (error) {
      console.error("Paystack card billing webhook error:", error?.response?.data || error);
      return res.status(500).json({ success: false, message: "Paystack webhook processing failed." });
    }
  }

  async refreshDashboardStats(platformID, options = {}) {
    if (!platformID) return null;
    let onlineHotspotUsers;
    let onlinePPPoEUsers;
    let stationOnlineUsers;
    try {
      const active = await this.mikrotik.fetchActiveConnectionsPerStation(platformID);
      onlineHotspotUsers = active?.totals?.hotspot || 0;
      onlinePPPoEUsers = active?.totals?.pppoe || 0;
      stationOnlineUsers = active?.perStation || {};
    } catch (error) {
      console.error("Error fetching station online users:", error);
      try {
        onlineHotspotUsers = await this.mikrotik.fetchActiveHotspotConnections(platformID);
      } catch (err) {
        console.error("Error fetching hotspot active users:", err);
      }
      try {
        onlinePPPoEUsers = await this.mikrotik.fetchActivePPPoEConnections(platformID);
      } catch (err) {
        console.error("Error fetching pppoe active users:", err);
      }
      stationOnlineUsers = {};
    }

    const payload = await this.db.rebuildDashboardStats(platformID, {
      ...options,
      onlineHotspotUsers,
      onlinePPPoEUsers,
      stationOnlineUsers,
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

    const { token, search, entity, limit = 20, offset = 0, date, station } = req.body;

    if (!token || !entity) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields"
      });
    }

    try {
      const auth = await this.auth.AuthenticateRequest(token);

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
      const stationKey = entity === "payments" ? "" : (station || "");
      const cacheKey = `main:search:${platformID}:${entity}:${stationKey}:${search || ""}:${limit}:${offset}:${date || ""}`;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return res.status(200).json(cached);
      }

      let result;
      let rows;
      let summary;

      switch (entity) {
        case "payments":
          result = await this.db.searchMpesa({
            platformID,
            search,
            station: null,
            limit,
            offset,
            date
          });

          rows = (result?.rows || []).map((row) => ({
            ...row,
            station: row?.package?.routerHost || "",
          }));
          break;

        case "users":
          result = await this.db.searchUsers({
            platformID,
            search,
            station,
            limit,
            offset
          });

          let allActiveUsers = [];
          let mikrotikFailed = true;
          let codes = result?.rows || [];
          const stations = await this.db.getStations(platformID);
          const stationAliasMap = new Map();
          for (const st of Array.isArray(stations) ? stations : []) {
            const canonicalHost = st?.mikrotikHost || st?.name || st?.id || "";
            for (const alias of this.db.stationRouterAliases(st)) {
              stationAliasMap.set(alias, canonicalHost);
            }
          }
          const stationsToCheck = station
            ? stations.filter((s) => this.db.stationRouterAliases(s).includes(station))
            : stations;
          const radiusHosts = new Set(
            (Array.isArray(stations) ? stations : [])
              .filter((item) => String(item?.systemBasis || "API").toUpperCase() === "RADIUS")
              .map((item) => stationAliasMap.get(item?.mikrotikHost) || item?.mikrotikHost)
              .filter(Boolean)
          );
          const radiusUsernames = codes
            .filter((code) => {
              const pkg = code.package;
              const rowStation = stationAliasMap.get(pkg?.routerHost) || pkg?.routerHost;
              return radiusHosts.has(rowStation);
            })
            .map((code) => code.username)
            .filter(Boolean);
          const radiusUsage = await this.db.getRadiusUsageDetailsByUsernames(radiusUsernames, {
            requireRecentActivity: false,
          });
          const apiStationsToCheck = stationsToCheck.filter(
            (st) => String(st?.systemBasis || "API").toUpperCase() !== "RADIUS"
          );
          for (const st of apiStationsToCheck) {
            const activeRes = await this.mikrotik.checkHotspotUserStatus(platformID, st.mikrotikHost);
            if (activeRes.success) {
              mikrotikFailed = false;
              allActiveUsers = allActiveUsers.concat(activeRes.users);
            }
          }
          if (apiStationsToCheck.length === 0) mikrotikFailed = false;

          if (mikrotikFailed) {
            const newCodes = await Promise.all(
              codes.map(async (code) => {
                const pkg = code.package;
                const rowStation = stationAliasMap.get(pkg?.routerHost) || pkg?.routerHost;
                const isRadius = radiusHosts.has(rowStation);
                const userRadiusUsage = isRadius
                  ? radiusUsage[code.username] || { uploadBytes: 0, downloadBytes: 0, totalBytes: 0, online: false }
                  : null;
                return {
                  ...code,
                  station: rowStation,
                  package: pkg?.name,
                  active: isRadius && code.status === "active" && userRadiusUsage?.online ? "Online" : "Offline",
                  systemBasis: isRadius ? "RADIUS" : "API",
                  bandwidthUsage: userRadiusUsage,
                };
              })
            );

            return rows = newCodes;
          }

          const newCodes = [];
          for (const code of codes) {
            const pkg = code.package;
            const rowStation = stationAliasMap.get(pkg?.routerHost) || pkg?.routerHost;
            const isRadius = radiusHosts.has(rowStation);
            const userRadiusUsage = isRadius
              ? radiusUsage[code.username] || { uploadBytes: 0, downloadBytes: 0, totalBytes: 0, online: false }
              : null;
            if (code.status !== "active") {
              newCodes.push({
                ...code,
                station: rowStation,
                package: pkg?.name,
                active: "Offline",
                systemBasis: isRadius ? "RADIUS" : "API",
                bandwidthUsage: userRadiusUsage,
              });
              continue;
            }

            const isActive = isRadius
              ? Boolean(userRadiusUsage?.online)
              : allActiveUsers.some(u => u.user === code.username);
            newCodes.push({
              ...code,
              station: rowStation,
              package: pkg?.name,
              active: isActive ? "Online" : "Offline",
              systemBasis: isRadius ? "RADIUS" : "API",
              bandwidthUsage: userRadiusUsage,
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
          [result, summary] = await Promise.all([
            this.db.searchPppoe({ platformID, search, station, limit, offset }),
            this.db.getPppoeSearchSummary({ platformID, search, station }),
          ]);
          rows = result?.rows || [];
          {
            const platform = await this.db.getPlatform(platformID);
            const platformUrl = platform?.url;
            const plans = (await this.db.getPPPoEPlans(platformID)) || [];
            const planById = new Map(plans.map((plan) => [plan.id, plan]));
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
            rows = rows.map((row) => ({
              ...row,
              planName: planById.get(row.planId)?.name || (row.planId ? "Unknown plan" : row.name || "-"),
            }));
            const stationHosts = station
              ? [station]
              : Array.from(new Set(rows.map((row) => row.station).filter(Boolean)));
            const stations = await this.db.getStations(platformID);
            const radiusHosts = new Set(
              (Array.isArray(stations) ? stations : [])
                .filter((item) => String(item?.systemBasis || "API").toUpperCase() === "RADIUS")
                .map((item) => item.mikrotikHost)
                .filter(Boolean)
            );
            const radiusStationHosts = stationHosts.filter((host) => radiusHosts.has(host));
            const radiusUsernames = rows
              .filter((row) => radiusHosts.has(row.station))
              .map((row) => row.clientname)
              .filter(Boolean);
            const apiStationHosts = stationHosts.filter((host) => !radiusHosts.has(host));
            const [radiusUsage, apiStatusResults, radiusStatusResults] = await Promise.all([
              this.db.getRadiusUsageDetailsByUsernames(radiusUsernames, {
                requireRecentActivity: false,
              }),
              Promise.all(
                apiStationHosts.map((host) =>
                  this.mikrotik.checkPPPUserStatus(platformID, host)
                )
              ),
              Promise.all(
                radiusStationHosts.map((host) =>
                  this.mikrotik.checkPPPUserStatus(platformID, host)
                )
              ),
            ]);
            const activeUsernames = new Set();
            const radiusActiveUsernames = new Set();
            let mikrotikFailed = apiStationHosts.length > 0;
            for (const status of apiStatusResults) {
              if (status?.success) {
                mikrotikFailed = false;
                for (const user of status.users || []) {
                  if (user?.name) activeUsernames.add(user.name);
                }
              }
            }
            for (const status of radiusStatusResults) {
              if (status?.success) {
                for (const user of status.users || []) {
                  if (user?.name) radiusActiveUsernames.add(user.name);
                }
              }
            }
            rows = rows.map((row) => {
              if (row.status !== "active") {
                return {
                  ...row,
                  active: "Offline",
                  bandwidthUsage: radiusHosts.has(row.station)
                    ? radiusUsage[row.clientname] || { uploadBytes: 0, downloadBytes: 0, totalBytes: 0, online: false }
                    : null,
                };
              }
              const isRadius = radiusHosts.has(row.station);
              const userRadiusUsage = isRadius
                ? radiusUsage[row.clientname] || { uploadBytes: 0, downloadBytes: 0, totalBytes: 0, online: false }
                : null;
              const isActive = isRadius
                ? Boolean(userRadiusUsage?.online) || radiusActiveUsernames.has(row.clientname)
                : !mikrotikFailed && activeUsernames.has(row.clientname);
              return { ...row, active: isActive ? "Online" : "Offline", bandwidthUsage: userRadiusUsage };
            });
            const summaryUsers = summary?.users || [];
            const onlineUsers = summaryUsers.filter((user) => {
              if (user.status !== "active") return false;
              const isRadius = radiusHosts.has(user.station);
              return isRadius
                ? Boolean(radiusUsage[user.clientname]?.online) || radiusActiveUsernames.has(user.clientname)
                : !mikrotikFailed && activeUsernames.has(user.clientname);
            }).length;
            summary = {
              totalUsers: result?.totalCount || 0,
              activeUsers: summary?.activeAccounts || 0,
              expiredUsers: summary?.expiredAccounts || 0,
              onlineUsers,
              offlineUsers: Math.max((result?.totalCount || 0) - onlineUsers, 0),
              mikrotikReachable: !mikrotikFailed || apiStationHosts.length === 0,
            };
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
        totalCount: result.totalCount,
        ...(summary && { summary }),
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
      const auth = await this.auth.AuthenticateRequest(token);
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

  async managerB2BPayments(req, res) {
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
      const payments = await this.db.getB2BPaymentsByPlatformPaged(platformID, safeLimit, safeOffset);
      return res.status(200).json({
        success: true,
        message: "B2B/Hotspot deposit payments retrieved successfully!",
        payments,
        nextOffset: safeOffset + (payments?.length || 0),
        hasMore: Array.isArray(payments) && payments.length === safeLimit,
      });
    } catch (error) {
      console.error("Error fetching manager B2B payments:", error);
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
      const nextStatus = paymentData.status || payment.status;
      const nextCode = paymentData.code || payment.code;
      const nextAmount = paymentData.amount ?? payment.amount;
      const amountValue = Number(nextAmount);
      if (Number.isNaN(amountValue) || amountValue < 0) {
        return res.json({ success: false, message: "Invalid amount provided." });
      }
      const updatedPayment = await this.db.updateMpesaCodeByID(paymentData.id, {
        status: nextStatus,
        code: nextCode,
        amount: String(nextAmount),
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

  async managerUpdateB2BPayment(req, res) {
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
      const isB2B = payment?.service === "Mpesa B2B";
      const isHotspotDeposit = payment?.service === "hotspot" && payment?.type === "deposit";
      if (!payment || (!isB2B && !isHotspotDeposit)) {
        return res.json({ success: false, message: "B2B/Hotspot deposit payment not found!" });
      }

      const nextStatus = paymentData.status || payment.status;
      const nextCode = paymentData.code || payment.code;
      const nextAmount = paymentData.amount ?? payment.amount;
      const amountValue = Number(nextAmount);
      if (Number.isNaN(amountValue) || amountValue < 0) {
        return res.json({ success: false, message: "Invalid amount provided." });
      }

      const prevStatus = String(payment.status || "").toUpperCase();
      const newStatus = String(nextStatus || "").toUpperCase();
      const updatedPayment = await this.db.updateMpesaCodeByID(paymentData.id, {
        status: nextStatus,
        code: nextCode,
        amount: String(nextAmount),
      });

      if (
        isB2B &&
        (prevStatus === "PENDING" || prevStatus === "PROCESSING") &&
        newStatus === "COMPLETE"
      ) {
        const funds = await this.db.getFunds(payment.platformID);
        const currentBalance = funds ? parseFloat(funds.balance || "0") : 0;
        const currentWithdrawals = funds ? parseFloat(funds.withdrawals || "0") : 0;
        const newBalance = currentBalance - amountValue;
        const newWithdrawals = currentWithdrawals + amountValue;
        if (funds) {
          await this.db.updateFunds(payment.platformID, {
            balance: newBalance.toFixed(2),
            withdrawals: newWithdrawals.toFixed(2),
          });
        } else {
          await this.db.createFunds({
            balance: newBalance.toFixed(2),
            withdrawals: newWithdrawals.toFixed(2),
            deposits: "0",
            platformID: payment.platformID,
          });
        }
      }

      if (
        isHotspotDeposit &&
        (prevStatus === "PENDING" || prevStatus === "PROCESSING") &&
        newStatus === "COMPLETE"
      ) {
        const funds = await this.db.getFunds(payment.platformID);
        const currentBalance = funds ? parseFloat(funds.balance || "0") : 0;
        const currentDeposits = funds ? parseFloat(funds.deposits || "0") : 0;
        const newBalance = currentBalance + amountValue;
        const newDeposits = currentDeposits + amountValue;
        if (funds) {
          await this.db.updateFunds(payment.platformID, {
            balance: newBalance.toFixed(2),
            deposits: newDeposits.toFixed(2),
          });
        } else {
          await this.db.createFunds({
            balance: newBalance.toFixed(2),
            withdrawals: "0",
            deposits: newDeposits.toFixed(2),
            platformID: payment.platformID,
          });
        }
      }

      return res.json({
        success: true,
        message: "B2B/Hotspot deposit payment updated successfully",
        payment: updatedPayment,
      });
    } catch (error) {
      console.error("Error updating manager B2B payment:", error);
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

  async managerDeleteB2BPayment(req, res) {
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
      const isB2B = payment?.service === "Mpesa B2B";
      const isHotspotDeposit = payment?.service === "hotspot" && payment?.type === "deposit";
      if (!payment || (!isB2B && !isHotspotDeposit)) {
        return res.json({ success: false, message: "B2B/Hotspot deposit payment not found!" });
      }
      await this.db.deleteMpesaPayment(id);
      return res.json({ success: true, message: "B2B/Hotspot deposit payment deleted successfully" });
    } catch (error) {
      console.error("Error deleting manager B2B payment:", error);
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
    const auth = await this.auth.AuthenticateRequest(token);
    if (!auth.success) {
      return res.json({
        success: false,
        message: auth.message,
      });
    }

    try {
      const settings = await this.db.getSettings();

      const response = {
        success: true,
        message: "Settings fetched",
        settings
      };
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
    const auth = await this.auth.AuthenticateRequest(token);
    if (!auth.success || !auth.admin) {
      return res.json({
        success: false,
        message: auth.message,
      });
    }
    try {
      const cacheKey = `main:platform:${auth.admin.platformID}`;
      await this.enforcePlatformSubscription(auth.admin.platformID);
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

  async fetchPlatformNotifications(req, res) {
    const { token } = req.body || {};
    if (!token) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }
    try {
      const auth = await this.auth.AuthenticateRequest(token);
      if (!auth.success || !auth.admin) {
        return res.json({ success: false, message: auth.message });
      }
      const includeDismissed = Boolean(req.body?.includeDismissed);
      const notifications = await this.db.getPlatformNotifications(auth.admin.platformID, includeDismissed);
      return res.json({ success: true, notifications });
    } catch (error) {
      console.error("Error fetching platform notifications:", error);
      return res.json({ success: false, message: "Failed to fetch notifications." });
    }
  }

  async dismissPlatformNotification(req, res) {
    const { token, id } = req.body || {};
    if (!token || !id) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }
    try {
      const auth = await this.auth.AuthenticateRequest(token);
      if (!auth.success || !auth.admin) {
        return res.json({ success: false, message: auth.message });
      }
      await this.db.dismissPlatformNot(id, auth.admin.platformID);
      return res.json({ success: true, message: "Notification dismissed." });
    } catch (error) {
      console.error("Error dismissing platform notification:", error);
      return res.json({ success: false, message: "Failed to dismiss notification." });
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
        await this.enforcePlatformSubscription(admin.platformID);
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

      await this.enforcePlatformSubscription(session.platformID);
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

    const auth = await this.auth.AuthenticateRequest(token);
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
      const allFunds = typeof this.db.getAllFunds === "function" ? await this.db.getAllFunds() : [];
      const fundsByPlatform = new Map((allFunds || []).map((funds) => [funds.platformID, funds]));
      const response = {
        success: true,
        message: "Platforms fetched!",
        platforms: (platforms || []).map((platform) => ({
          ...platform,
          funds: fundsByPlatform.get(platform.platformID) || null,
        })),
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
      const auth = await this.auth.AuthenticateRequest(token);
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
      const auth = await this.auth.AuthenticateRequest(token);
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
      const auth = await this.auth.AuthenticateRequest(token);
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
      const auth = await this.auth.AuthenticateRequest(token);
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
      const auth = await this.auth.AuthenticateRequest(token);
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
      const auth = await this.auth.AuthenticateRequest(token);
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

  sanitizeBlogHtml(content) {
    const raw = String(content || "");
    return raw
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
      .replace(/\son\w+="[^"]*"/gi, "")
      .replace(/\son\w+='[^']*'/gi, "");
  }

  createSlug(input) {
    return String(input || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

  async buildUniqueBlogSlug(base, currentId = null) {
    const fallback = this.createSlug(base) || `blog-${Date.now()}`;
    let slug = fallback;
    let counter = 2;
    while (true) {
      const existing = await this.db.getBlogBySlug(slug);
      if (!existing || existing.id === currentId) {
        return slug;
      }
      slug = `${fallback}-${counter}`;
      counter += 1;
    }
  }

  async managerFetchBlogs(req, res) {
    const { token } = req.body || {};
    if (!token) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }
    try {
      const session = await this.authManagerSession(token);
      if (!session.success) {
        return res.json({ success: false, message: session.message });
      }
      const blogs = await this.db.getBlogs();
      return res.json({
        success: true,
        message: "Blogs fetched successfully!",
        blogs,
      });
    } catch (error) {
      console.error("Error fetching blogs:", error);
      return res.status(500).json({ success: false, message: "Internal server error." });
    }
  }

  async managerAddBlog(req, res) {
    const {
      token,
      title,
      content,
      excerpt,
      slug,
      coverImage,
      seoTitle,
      seoDescription,
      tags,
      published,
    } = req.body || {};

    if (!token || !title || !content || !excerpt) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }
    try {
      const session = await this.authManagerSession(token);
      if (!session.success) {
        return res.json({ success: false, message: session.message });
      }

      const cleanTitle = String(title).trim();
      const cleanContent = this.sanitizeBlogHtml(content);
      const cleanExcerpt = String(excerpt).trim();
      if (!cleanTitle || !cleanContent || !cleanExcerpt) {
        return res.json({ success: false, message: "Title, excerpt and content are required." });
      }

      const finalSlug = await this.buildUniqueBlogSlug(slug || cleanTitle);
      const isPublished = published !== false;
      const blog = await this.db.createBlog({
        title: cleanTitle,
        slug: finalSlug,
        excerpt: cleanExcerpt,
        content: cleanContent,
        coverImage: coverImage ? String(coverImage).trim() : null,
        seoTitle: seoTitle ? String(seoTitle).trim() : null,
        seoDescription: seoDescription ? String(seoDescription).trim() : null,
        tags: Array.isArray(tags) ? tags.map((tag) => String(tag).trim()).filter(Boolean) : [],
        published: isPublished,
        publishedAt: isPublished ? new Date() : null,
      });

      return res.json({
        success: true,
        message: "Blog created successfully!",
        blog,
      });
    } catch (error) {
      console.error("Error creating blog:", error);
      return res.status(500).json({ success: false, message: "Internal server error." });
    }
  }

  async managerUpdateBlog(req, res) {
    const {
      token,
      id,
      title,
      content,
      excerpt,
      slug,
      coverImage,
      seoTitle,
      seoDescription,
      tags,
      published,
    } = req.body || {};

    if (!token || !id) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }
    try {
      const session = await this.authManagerSession(token);
      if (!session.success) {
        return res.json({ success: false, message: session.message });
      }
      const existing = await this.db.getBlogById(id);
      if (!existing) {
        return res.json({ success: false, message: "Blog not found." });
      }

      const nextTitle = title !== undefined ? String(title).trim() : existing.title;
      const nextSlugSource = slug !== undefined ? String(slug).trim() : nextTitle;
      const finalSlug = await this.buildUniqueBlogSlug(nextSlugSource, existing.id);
      const nextPublished = published === undefined ? existing.published : Boolean(published);
      const nextPublishedAt = nextPublished
        ? (existing.publishedAt || new Date())
        : null;

      const updated = await this.db.updateBlog(id, {
        ...(title !== undefined ? { title: nextTitle } : {}),
        ...(content !== undefined ? { content: this.sanitizeBlogHtml(content) } : {}),
        ...(excerpt !== undefined ? { excerpt: String(excerpt).trim() } : {}),
        ...(slug !== undefined || title !== undefined ? { slug: finalSlug } : {}),
        ...(coverImage !== undefined ? { coverImage: coverImage ? String(coverImage).trim() : null } : {}),
        ...(seoTitle !== undefined ? { seoTitle: seoTitle ? String(seoTitle).trim() : null } : {}),
        ...(seoDescription !== undefined ? { seoDescription: seoDescription ? String(seoDescription).trim() : null } : {}),
        ...(tags !== undefined
          ? { tags: Array.isArray(tags) ? tags.map((tag) => String(tag).trim()).filter(Boolean) : [] }
          : {}),
        ...(published !== undefined ? { published: nextPublished, publishedAt: nextPublishedAt } : {}),
      });
      return res.json({
        success: true,
        message: "Blog updated successfully!",
        blog: updated,
      });
    } catch (error) {
      console.error("Error updating blog:", error);
      return res.status(500).json({ success: false, message: "Internal server error." });
    }
  }

  async managerDeleteBlog(req, res) {
    const { token, id } = req.body || {};
    if (!token || !id) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }
    try {
      const session = await this.authManagerSession(token);
      if (!session.success) {
        return res.json({ success: false, message: session.message });
      }
      const existing = await this.db.getBlogById(id);
      if (!existing) {
        return res.json({ success: false, message: "Blog not found." });
      }
      await this.db.deleteBlog(id);
      return res.json({
        success: true,
        message: "Blog deleted successfully!",
      });
    } catch (error) {
      console.error("Error deleting blog:", error);
      return res.status(500).json({ success: false, message: "Internal server error." });
    }
  }

  async managerUploadBlogImage(req, res) {
    const { token, file, filename } = req.body || {};
    if (!token || !file) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }

    try {
      const session = await this.authManagerSession(token);
      if (!session.success) {
        return res.json({ success: false, message: session.message });
      }

      const match = String(file).match(/^data:image\/(png|jpe?g|webp|gif);base64,/i);
      if (!match) {
        return res.json({
          success: false,
          message: "Unsupported image format. Use PNG, JPG, WEBP or GIF.",
        });
      }

      const ext = match[1].toLowerCase().replace("jpeg", "jpg");
      const base64Data = String(file).replace(/^data:image\/(png|jpe?g|webp|gif);base64,/i, "");
      const buffer = Buffer.from(base64Data, "base64");
      if (!buffer || buffer.length === 0) {
        return res.json({ success: false, message: "Invalid image payload." });
      }
      if (buffer.length > 10 * 1024 * 1024) {
        return res.json({ success: false, message: "Image too large. Max 10MB." });
      }

      const safeNameBase = String(filename || "blog-image")
        .replace(/\.[^/.]+$/, "")
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(0, 80) || "blog-image";
      const uniqueName = `${safeNameBase}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`;

      const folderPath = path.join(appRoot, "public", "blog-uploads");
      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
      }

      const finalPath = path.join(folderPath, uniqueName);
      fs.writeFileSync(finalPath, buffer);

      const relativeUrl = `/blog-uploads/${uniqueName}`;
      const proto = (req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
      const host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
      const url = host ? `${proto}://${host}${relativeUrl}` : relativeUrl;

      return res.status(200).json({
        success: true,
        message: "Image uploaded successfully.",
        url,
        path: relativeUrl,
        filename: uniqueName,
      });
    } catch (error) {
      console.error("Error uploading blog image:", error);
      return res.status(500).json({
        success: false,
        message: "An error occurred while uploading the image.",
      });
    }
  }

  async fetchPublicBlogs(req, res) {
    try {
      const limitValue = Number(req.query?.limit || req.body?.limit || 100);
      const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(limitValue, 200)) : 100;
      const blogs = await this.db.getPublishedBlogs(limit);
      const sanitized = blogs.map((blog) => ({
        id: blog.id,
        title: blog.title,
        slug: blog.slug,
        excerpt: blog.excerpt,
        coverImage: blog.coverImage,
        seoTitle: blog.seoTitle,
        seoDescription: blog.seoDescription,
        tags: Array.isArray(blog.tags) ? blog.tags : [],
        publishedAt: blog.publishedAt,
        createdAt: blog.createdAt,
        updatedAt: blog.updatedAt,
      }));
      return res.json({
        success: true,
        message: "Blogs fetched successfully!",
        blogs: sanitized,
      });
    } catch (error) {
      console.error("Error fetching public blogs:", error);
      return res.status(500).json({ success: false, message: "Internal server error." });
    }
  }

  async fetchPublicBlogBySlug(req, res) {
    const slug = String(req.params?.slug || req.body?.slug || "").trim();
    if (!slug) {
      return res.status(400).json({ success: false, message: "Missing blog slug" });
    }
    try {
      const blog = await this.db.getBlogBySlug(slug);
      if (!blog || !blog.published) {
        return res.status(404).json({ success: false, message: "Blog not found" });
      }
      return res.json({
        success: true,
        message: "Blog fetched successfully!",
        blog: {
          ...blog,
          tags: Array.isArray(blog.tags) ? blog.tags : [],
        },
      });
    } catch (error) {
      console.error("Error fetching blog:", error);
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

    const auth = await this.auth.AuthenticateRequest(token);
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
      const [users, payments, pppoeUsers] = await Promise.all([
        this.db.getUserByPlatformToday(platformID),
        this.db.getMpesaPaymentsToday(platformID),
        this.db.getPPPoE(platformID),
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

      const pppoeStationMap = new Map();
      (pppoeUsers || []).forEach((user) => {
        [user.id, user.paymentLink, user.accountNumber, user.clientname]
          .filter(Boolean)
          .forEach((key) => pppoeStationMap.set(String(key), user.station));
      });

      const enrichedPayments = payments.map((p) => {
        const codeStr = String(p.code);
        const userStatus = userCodes.get(codeStr);
        const hasCode = userStatus !== undefined;
        const service = String(p.service || "").toLowerCase();
        const station = service === "hotspot"
          ? p.package?.routerHost || stationMap.get(codeStr) || null
          : service === "pppoe"
            ? [p.referenceID, p.account, p.reason]
              .filter(Boolean)
              .map((key) => pppoeStationMap.get(String(key)))
              .find(Boolean) || null
            : null;

        return {
          ...p,
          station,
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

    const auth = await this.auth.AuthenticateRequest(token);
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

    const auth = await this.auth.AuthenticateRequest(token);
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

    const auth = await this.auth.AuthenticateRequest(token);
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
    const auth = await this.auth.AuthenticateRequest(token);
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

    const auth = await this.auth.AuthenticateRequest(token);
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

      const stationByHost = new Map(
        (stations || []).map((station) => [station.mikrotikHost, station])
      );
      const apiStations = (stations || []).filter(
        (station) => String(station?.systemBasis || "API").toUpperCase() !== "RADIUS"
      );
      const radiusUsernames = (codes || [])
        .filter((code) => {
          const station = stationByHost.get(code.package?.routerHost);
          return String(station?.systemBasis || "API").toUpperCase() === "RADIUS";
        })
        .map((code) => code.username)
        .filter(Boolean);
      const radiusUsage = await this.db.getRadiusUsageDetailsByUsernames(radiusUsernames, {
        requireRecentActivity: false,
      });

      let allActiveUsers = [];
      let reachableApiStations = 0;

      for (const station of apiStations) {
        const activeRes = await this.mikrotik.checkHotspotUserStatus(platformID, station.mikrotikHost);
        if (activeRes.success) {
          reachableApiStations += 1;
          allActiveUsers = allActiveUsers.concat(activeRes.users);
        }
      }

      const newCodes = [];
      for (const code of codes) {
        const pkg = code.package;
        const station = stationByHost.get(pkg?.routerHost);
        const isRadius = String(station?.systemBasis || "API").toUpperCase() === "RADIUS";
        const userRadiusUsage = isRadius
          ? radiusUsage[code.username] || { uploadBytes: 0, downloadBytes: 0, totalBytes: 0, online: false }
          : null;
        if (code.status !== "active") {
          newCodes.push({
            ...code,
            station: pkg?.routerHost,
            package: pkg?.name,
            active: "Offline",
            systemBasis: isRadius ? "RADIUS" : "API",
            bandwidthUsage: userRadiusUsage,
          });
          continue;
        }

        const isActive = isRadius
          ? Boolean(userRadiusUsage?.online)
          : allActiveUsers.some(u => u.user === code.username);
        newCodes.push({
          ...code,
          station: pkg?.routerHost,
          package: pkg?.name,
          active: isActive ? "Online" : "Offline",
          systemBasis: isRadius ? "RADIUS" : "API",
          bandwidthUsage: userRadiusUsage,
        });
      }

      const total = newCodes.length;
      const pagedCodes = newCodes.slice(offset, offset + limit);
      const response = {
        success: true,
        message: apiStations.length > 0 && reachableApiStations === 0
          ? "Codes fetched; API MikroTik stations are unreachable"
          : "Codes fetched",
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
      const auth = await this.auth.AuthenticateRequest(token);
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
          const auth = await this.auth.AuthenticateRequest(token);
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

  getMpesaSettingsPayload(data = {}) {
    const b2bShortCodeType = ["till", "paybill"].includes(String(data.mpesaShortCodeType || "").toLowerCase())
      ? data.mpesaShortCodeType
      : "Till";
    const c2bShortCodeType = ["till", "paybill"].includes(String(data.mpesaC2BShortCodeType || "").toLowerCase())
      ? data.mpesaC2BShortCodeType
      : "Till";

    return {
      IsC2B: data.IsC2B === true,
      IsAPI: data.IsAPI === true,
      IsB2B: data.IsB2B === true,
      mpesaConsumerKey: data.mpesaConsumerKey || "",
      mpesaConsumerSecret: data.mpesaConsumerSecret || "",
      mpesaShortCode: data.mpesaShortCode || "",
      mpesaShortCodeType: b2bShortCodeType,
      mpesaAccountNumber: data.mpesaAccountNumber || "",
      mpesaC2BShortCode: data.mpesaC2BShortCode || "",
      mpesaC2BShortCodeType: c2bShortCodeType,
      mpesaC2BAccountNumber: data.mpesaC2BAccountNumber || "",
      mpesaAccountInitiator: data.mpesaAccountInitiator || "",
      mpesaAccountInitiatorPassword: data.mpesaAccountInitiatorPassword || "",
      mpesaPassKey: data.mpesaPassKey || "",
    };
  }

  validateMpesaSettings(data = {}, adminID) {
    if (data.IsC2B === true) {
      if (!data.mpesaC2BShortCode || !data.mpesaC2BShortCodeType || !adminID) {
        return "All MPESA fields must be filled out!";
      }
      if (String(data.mpesaC2BShortCodeType).toLowerCase() === "paybill" && !data.mpesaC2BAccountNumber) {
        return "Account Number is required for Paybill!";
      }
    } else if (data.IsAPI === true) {
      if (!data.mpesaConsumerKey || !data.mpesaConsumerSecret || !data.mpesaShortCode || !data.mpesaShortCodeType || !data.mpesaPassKey || !adminID) {
        return "All MPESA fields must be filled out!";
      }
    } else if (data.IsB2B === true) {
      if (!data.mpesaShortCode || !data.mpesaShortCodeType || !adminID) {
        return "All MPESA fields must be filled out!";
      }
    }
    return null;
  }

  buildStationMpesaSettings(station, platformSettings) {
    if (!station?.mpesaConfigEnabled) {
      return {
        ...platformSettings,
        stationId: station?.id || "",
        stationName: station?.name || "",
        inheritsMpesa: true,
      };
    }

    const mpesaFields = [
      "IsC2B",
      "IsAPI",
      "IsB2B",
      "mpesaConsumerKey",
      "mpesaConsumerSecret",
      "mpesaShortCode",
      "mpesaShortCodeType",
      "mpesaAccountNumber",
      "mpesaC2BShortCode",
      "mpesaC2BShortCodeType",
      "mpesaC2BAccountNumber",
      "mpesaAccountInitiator",
      "mpesaAccountInitiatorPassword",
      "mpesaPassKey",
    ];
    const stationSettings = { ...platformSettings };
    for (const field of mpesaFields) {
      if (station[field] !== undefined && station[field] !== null) {
        stationSettings[field] = station[field];
      }
    }
    return {
      ...stationSettings,
      stationId: station.id,
      stationName: station.name,
      inheritsMpesa: false,
    };
  }

  async fetchSettings(req, res) {

    const { token, stationId } = req.body; if (!token) {
      return res.json({
        success: false, message: "Missing credentials required!",
      });
    }
    const auth = await this.auth.AuthenticateRequest(token);
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

      let stationBranding = null;
      let stationMpesa = null;
      if (stationId) {
        const station = await this.db.getStation(stationId);
        if (!station || station.platformID !== platformID) {
          return res.json({ success: false, message: "Station not found." });
        }
        const stationSupportPhone = String(station.supportPhone || "").trim();
        const platformSupportPhone = String(platformSettings.supportPhone || "").trim();
        const effectiveSupportPhone = stationSupportPhone || platformSupportPhone || "0712345678";
        stationBranding = {
          stationId: station.id,
          stationName: station.name,
          supportPhone: stationSupportPhone,
          effectiveSupportPhone,
          brandingImage: normalizeBrandingImage(station.brandingImage || platformSettings.brandingImage),
          inheritsSupportPhone: !stationSupportPhone,
          inheritsBrandingImage: !station.brandingImage,
        };
        stationMpesa = this.buildStationMpesaSettings(station, platformSettings);
      }

      const response = {
        domain,
        success: true,
        message: "Settings fetched",
        name,
        url,
        settings: platformSettings,
        platform_id,
        stationBranding,
        stationMpesa,
      };
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
    const auth = await this.auth.AuthenticateRequest(token);
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
    const { stationId } = data;
    try {
      const existingConfig = await this.db.getPlatformConfig(platformID);
      const validationMessage = this.validateMpesaSettings(data, adminID);
      if (validationMessage) {
        return res.json({
          success: false,
          message: validationMessage,
        });
      }

      const mpesaPayload = this.getMpesaSettingsPayload(data);
      if (stationId) {
        const station = await this.db.getStation(stationId);
        if (!station || station.platformID !== platformID) {
          return res.json({ success: false, message: "Station not found." });
        }
        const updatedStation = await this.db.updateStation(stationId, {
          ...mpesaPayload,
          mpesaConfigEnabled: true,
        });
        this.cache.del(`main:settings:${platformID}`);
        return res.json({
          success: true,
          message: `MPESA Settings updated for ${updatedStation.name}.`,
          stationMpesa: this.buildStationMpesaSettings(updatedStation, existingConfig || mpesaPayload),
        });
      }

      const payload = {
        ...mpesaPayload,
        adminID,
      };
      if (!existingConfig) {
        const add = await this.db.createPlatformConfig(platformID, payload);
        await this.refreshDashboardStats(platformID, { role: auth.admin.role });
        this.cache.del(`main:settings:${platformID}`);
        return res.json({
          success: true,
          message: "Platform Settings created.",
        });
      }

      const updatedConfig = await this.db.updatePlatformConfig(platformID, payload);
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
    const { token, stationId, supportPhone = "", brandingImage = "" } = req.body || {};
    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }
    const auth = await this.auth.AuthenticateRequest(token);
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
      if (!stationId) {
        return res.json({ success: false, message: "Select a station first." });
      }
      const station = await this.db.getStation(stationId);
      if (!station || station.platformID !== platformID) {
        return res.json({ success: false, message: "Station not found." });
      }
      const normalizedSupportPhone = String(supportPhone || "").trim() || null;
      const normalizedBrandingImage = String(brandingImage || "").trim() || null;
      const updatedStation = await this.db.updateStation(stationId, {
        supportPhone: normalizedSupportPhone,
        brandingImage: normalizedBrandingImage,
      });
      const platformSettings = await this.db.getPlatformConfig(platformID);
      const platformSupportPhone = String(platformSettings?.supportPhone || "").trim();
      const savedSupportPhone = String(updatedStation.supportPhone || "").trim();
      const effectiveSupportPhone = savedSupportPhone || platformSupportPhone || "0712345678";
      this.cache.del(`main:settings:${platformID}`);
      return res.json({
        success: true,
        message: `Branding & support updated for ${station.name}.`,
        stationBranding: {
          stationId: updatedStation.id,
          stationName: updatedStation.name,
          supportPhone: savedSupportPhone,
          effectiveSupportPhone,
          brandingImage: updatedStation.brandingImage || platformSettings?.brandingImage || "",
          inheritsSupportPhone: !savedSupportPhone,
          inheritsBrandingImage: !updatedStation.brandingImage,
        },
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
      fupLimit,
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
      const auth = await this.auth.AuthenticateRequest(token);
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
          category,
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
        fupLimit: isRadius ? (fupLimit || "Unlimited") : "Unlimited",
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
      this.refreshDashboardStats(platformID, { role: auth.admin.role }).catch((err) => {
        console.error("Dashboard stats refresh after package update failed:", err?.message || err);
      });
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
      fupLimit,
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
      const auth = await this.auth.AuthenticateRequest(token);
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
        fupLimit: isRadius ? (fupLimit || "Unlimited") : "Unlimited",
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
      this.refreshDashboardStats(platformID, { role: auth.admin.role }).catch((err) => {
        console.error("Dashboard stats refresh after package creation failed:", err?.message || err);
      });
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
      const auth = await this.auth.AuthenticateRequest(token);
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
      this.refreshDashboardStats(platformID, { role: auth.admin.role }).catch((err) => {
        console.error("Dashboard stats refresh after package delete failed:", err?.message || err);
      });
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
      const auth = await this.auth.AuthenticateRequest(token);
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
      const auth = await this.auth.AuthenticateRequest(token);
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
      const auth = await this.auth.AuthenticateRequest(token);
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
      const auth = await this.auth.AuthenticateRequest(token);
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
    const { token, name, domain } = req.body;
    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const auth = await this.auth.AuthenticateRequest(token);
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

      const existingPlatform = await this.db.getPlatform(platformID);
      if (!existingPlatform) {
        return res.status(404).json({
          success: false,
          message: "Platform not found!"
        });
      }

      const hasDomainField = Object.prototype.hasOwnProperty.call(req.body || {}, "domain");
      const normalizedDomain = hasDomainField
        ? String(domain || "").trim().toLowerCase()
        : existingPlatform.domain;
      const data = {
        name,
        domain: normalizedDomain,
      };
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
          name: upd.name,
          url: existingPlatform.url,
          domain: upd.domain
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
      const auth = await this.auth.AuthenticateRequest(token);
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

      const cacheKey = `main:stations:${platformID}:${auth.admin.role || "admin"}`;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return res.json(cached);
      }
      const stations = await this.db.getStations(platformID);
      let allStationsHosts = null;
      const normalizeHost = (value) =>
        typeof value === "string" ? value.trim().split("/")[0] : "";
      const pickNextHost = (hosts) => {
        const used = new Set(
          (hosts || [])
            .map((h) => normalizeHost(h))
            .filter((h) => /^10\.10\.10\.\d+$/.test(h))
        );
        for (let i = 2; i <= 254; i += 1) {
          const candidate = `10.10.10.${i}`;
          if (!used.has(candidate)) return candidate;
        }
        return "";
      };
      let nextAvailableHost = "";
      if (auth.admin.role === "superuser") {
        const allStations = await this.db.getAllStations();
        allStationsHosts = (allStations || [])
          .map((s) => s?.mikrotikHost)
          .filter((host) => typeof host === "string" && host.trim());
        nextAvailableHost = pickNextHost(allStationsHosts);
      } else {
        nextAvailableHost = pickNextHost(
          (stations || []).map((s) => s?.mikrotikHost)
        );
      }
      const response = {
        success: true,
        message: "Stations fetched",
        stations: stations,
        allStationsHosts,
        nextAvailableHost,
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
      const auth = await this.auth.AuthenticateRequest(data.token);
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
      data.mikrotikDDNS = "";
      const normalizedPublicHost = Utils.normalizeMikrotikPublicHost(mikrotikPublicHost || mikrotikDDNS);
      if (!normalizedPublicHost) {
        return res.json({ success: false, message: "Public router host must be a valid DDNS hostname or IP address." });
      }
      data.mikrotikPublicHost = normalizedPublicHost;
      const platformData = await this.db.getPlatform(platformID);
      if (!platformData) {
        return res.json({ success: false, message: "Platform doesn't exist." });
      }

      const platformURL = platformData.url;

      let station;
      if (stationID !== "") {
        station = await this.db.getStation(stationID);
        if (station?.mikrotikHost) {
          // On edit, keep the already-assigned internal IP and ignore any auto-generated host from client.
          data.mikrotikHost = station.mikrotikHost;
        }
      }

      const targetInternalHost = this.normalizeMikrotikInternalHost(data.mikrotikHost || mikrotikHost);
      const webfigTargetUrl = this.buildMikrotikWebfigTarget(targetInternalHost);
      if (!targetInternalHost || !webfigTargetUrl) {
        return res.json({
          success: false,
          message: "MikroTik internal host must be a 10.10.10.x address.",
        });
      }
      data.mikrotikHost = targetInternalHost;

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
        newData.hotspotTemplateMode = "offline";
        newData.hotspotTemplateName = null;
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
          newData.radiusClientSecret = getRadiusClientSecret(newData.radiusClientSecret || crypto.randomBytes(12).toString("hex"));
          const serverIp = getRadiusServerIp();
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
          updData.radiusClientSecret = getRadiusClientSecret(updData.radiusClientSecret || station?.radiusClientSecret || crypto.randomBytes(12).toString("hex"));
          const serverIp = getRadiusServerIp();
          updData.radiusServerIp = serverIp;
        }
        const updatedStation = await this.db.updateStation(stationID, updData);
        stationResult = updatedStation;
        responseMessage = "Station updated";
      }

      const endpointHost = normalizedPublicHost;
      const result = await this.resolveMikrotikHost(endpointHost);
      if (!result.success) {
        return res.json({ success: false, message: result.message });
      }
      const resolvedIp = Array.isArray(result.addresses) && result.addresses.length > 0 ? result.addresses[0] : endpointHost;
      if (systemBasis === "RADIUS") {
        const radiusHost = getRadiusClientIp(stationResult, Utils.isValidIP(normalizedPublicHost)
          ? normalizedPublicHost
          : resolvedIp);
        const sharedRadiusStation = await this.findRadiusStationSharingClientIp(radiusHost, stationResult.id);
        if (sharedRadiusStation?.radiusClientSecret && sharedRadiusStation.radiusClientSecret !== stationResult.radiusClientSecret) {
          stationResult = await this.db.updateStation(stationResult.id, {
            radiusClientSecret: sharedRadiusStation.radiusClientSecret,
          });
        }
        await this.db.updateStation(stationResult.id, {
          radiusClientIp: radiusHost || "",
        });
        const addResult = await ensureRadiusClient({
          name: stationResult.radiusClientName,
          ip: radiusHost || "",
          secret: stationResult.radiusClientSecret,
          shortname: stationResult.name,
          server: stationResult.radiusServerIp || "",
          description: `Nova RADIUS client for ${stationResult.name}`,
        });
        if (!addResult?.success) {
          console.warn("[RADIUS] ensureRadiusClient failed", addResult?.message || addResult);
        }
      }

      const targetPublicKey = String(mikrotikPublicKey || "").trim();
      const peerBlock = [
        "[Peer]",
        `PublicKey = ${targetPublicKey}`,
        `Endpoint = ${endpointHost}:13231`,
        `AllowedIPs = ${targetInternalHost}/32`,
        "PersistentKeepalive = 10",
      ].join("\n");

      const wgConfPath = "/etc/wireguard/wg0.conf";

      exec(`sudo -n cat ${wgConfPath}`, (readErr, fileData) => {
        if (readErr) {
          return res.json({ success: false, message: "WireGuard config read failed." });
        }

        try {
          fs.writeFileSync(`/tmp/wg0.conf.bak-${Date.now()}`, fileData, "utf8");
        } catch (backupErr) {
          console.warn("WireGuard backup skipped:", backupErr?.message || backupErr);
        }

        const blocks = fileData.toString().replace(/\r\n/g, "\n").split(/\n(?=\s*\[Peer\])/);

        const extractInternalHost = (block) => {
          const match = String(block || "").match(/AllowedIPs\s*=\s*(10\.10\.10\.\d{1,3})\/32\b/i);
          return match?.[1] ? String(match[1]).trim() : "";
        };
        const extractPublicKey = (block) => {
          const match = String(block || "").match(/PublicKey\s*=\s*(.+)/i);
          return match?.[1] ? String(match[1]).trim() : "";
        };
        const isPeerBlock = (block) => String(block || "").trimStart().startsWith("[Peer]");
        const normalizeBlock = (block) =>
          String(block || "")
            .replace(/\r\n/g, "\n")
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .join("\n");

        const seenIPs = new Set();
        const seenKeys = new Set();
        const cleaned = [];
        let updatedPeerInserted = false;

        for (const rawBlock of blocks) {
          const block = String(rawBlock || "");
          if (!isPeerBlock(block)) {
            cleaned.push(block.trim());
            continue;
          }

          const internalHost = extractInternalHost(block);
          const publicKey = extractPublicKey(block);
          const isTargetPeer = internalHost && targetInternalHost && internalHost === targetInternalHost;

          if (isTargetPeer) {
            if (!updatedPeerInserted) {
              cleaned.push(peerBlock);
              if (targetInternalHost) seenIPs.add(targetInternalHost);
              if (targetPublicKey) seenKeys.add(targetPublicKey);
              updatedPeerInserted = true;
            }
            continue;
          }

          if (internalHost && seenIPs.has(internalHost)) continue;
          if (publicKey && seenKeys.has(publicKey)) continue;

          if (targetPublicKey && publicKey && publicKey === targetPublicKey) continue;

          if (internalHost) seenIPs.add(internalHost);
          if (publicKey) seenKeys.add(publicKey);
          cleaned.push(normalizeBlock(block));
        }

        if (!updatedPeerInserted) {
          cleaned.push(peerBlock);
        }

        const newConfig = cleaned
          .map(b => normalizeBlock(b))
          .filter(Boolean)
          .join("\n\n")
          .trim() + "\n";

        const wgTmpPath = `/tmp/wg.${Date.now()}.conf`;
        fs.writeFile(wgTmpPath, newConfig, async (writeErr) => {
          if (writeErr) {
            return res.json({ success: false, message: "WireGuard config write failed." });
          }

          exec(`sudo -n /bin/mv ${wgTmpPath} ${wgConfPath}`, () => {
            exec("sudo -n /usr/bin/wg-quick down wg0", () => {
              exec("sudo -n /usr/bin/wg-quick up wg0", async (upErr) => {
                if (upErr) {
                  return res.json({ success: false, message: "WireGuard restart failed." });
                }

                const webfigSite = await this.ensureStationWebfigSite(stationResult);
                if (!webfigSite.success) {
                  if (!station && stationResult?.id) {
                    await this.db.updateStation(stationResult.id, { mikrotikWebfigHost: null }).catch(() => null);
                    stationResult.mikrotikWebfigHost = null;
                  }
                  return res.json({
                    success: false,
                    message: webfigSite.message || "WebFig reverse proxy verification failed.",
                    station: stationResult,
                    webfigSite,
                  });
                }

                let defaultTemplate = null;
                if (String(stationResult.hotspotTemplateMode || "").toLowerCase() === "offline") {
                  defaultTemplate = await this.mikrotik.uploadHotspotLoginTemplate(
                    platformID,
                    stationResult.mikrotikHost,
                    { mode: "offline" }
                  ).catch((error) => ({
                    success: false,
                    message: error?.message || "Failed to upload the default offline template.",
                  }));
                  if (!defaultTemplate?.success) {
                    return res.status(502).json({
                      success: false,
                      message: `Station was saved, but its offline template could not be uploaded: ${defaultTemplate?.message || "unknown error"}`,
                      station: stationResult,
                      webfigSite,
                      defaultTemplate,
                    });
                  }
                }

                const seedScripts = await this.mikrotik.seedStationScriptsOnConnect(platformID, {
                  mikrotikHost: stationResult?.mikrotikHost || mikrotikHost,
                  systemBasis: stationResult?.systemBasis || systemBasis || "API",
                });

                await this.refreshDashboardStats(platformID, { role: auth.admin.role });
                return res.json({
                  success: true,
                  message: `${responseMessage} and WireGuard updated.`,
                  station: stationResult,
                  webfigSite,
                  defaultTemplate,
                  seedScripts,
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
      const auth = await this.auth.AuthenticateRequest(token);
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
      const radiusClientSecret = getRadiusClientSecret(crypto.randomBytes(12).toString("hex"));
      const radiusServerIp = getRadiusServerIp();

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

  formatRouterBytes(value) {
    const bytes = Number(value || 0);
    if (!Number.isFinite(bytes) || bytes <= 0) return "";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const amount = bytes / (1024 ** index);
    return `${amount >= 100 || index === 0 ? amount.toFixed(0) : amount.toFixed(2)}${units[index]}`;
  }

  percentageString(used, total) {
    const usedNumber = Number(used || 0);
    const totalNumber = Number(total || 0);
    if (!Number.isFinite(usedNumber) || !Number.isFinite(totalNumber) || totalNumber <= 0) return "";
    return `${((usedNumber / totalNumber) * 100).toFixed(1)}%`;
  }

  buildMikrotikInfoSnapshot(station, existing = {}, live = {}) {
    const webfigHost = station?.mikrotikWebfigHost || station?.mikrotikPublicHost || "";
    const isRadiusStation = String(station?.systemBasis || "API").toUpperCase() === "RADIUS";
    const totalMemory = live["total-memory"];
    const freeMemory = live["free-memory"];
    const usedMemory = Number(totalMemory || 0) - Number(freeMemory || 0);
    const totalHdd = live["total-hdd-space"];
    const freeHdd = live["free-hdd-space"];
    const usedHdd = Number(totalHdd || 0) - Number(freeHdd || 0);
    const cpuLoad = live["cpu-load"];

    return {
      stationId: station.id,
      platformID: station.platformID,
      managementIp: station.mikrotikHost || existing.managementIp || "",
      username: station.mikrotikUser || existing.username || "",
      password: station.mikrotikPassword || existing.password || "",
      apiPort: existing.apiPort || "8728",
      webfigUrl: webfigHost ? `http://${webfigHost}` : existing.webfigUrl || "",
      radiusAddress: isRadiusStation ? station.radiusServerIp || existing.radiusAddress || "" : "",
      radiusSecret: isRadiusStation ? station.radiusClientSecret || existing.radiusSecret || "" : "",
      radiusAccountingPort: isRadiusStation ? existing.radiusAccountingPort || "1813" : "",
      radiusAuthPort: isRadiusStation ? existing.radiusAuthPort || "1812" : "",
      cpuUsage: cpuLoad !== undefined && cpuLoad !== "" ? `${cpuLoad}%` : existing.cpuUsage || "",
      memoryUsage: totalMemory ? this.percentageString(usedMemory, totalMemory) : existing.memoryUsage || "",
      memoryUsed: totalMemory ? this.formatRouterBytes(usedMemory) : existing.memoryUsed || "",
      memoryTotal: totalMemory ? this.formatRouterBytes(totalMemory) : existing.memoryTotal || "",
      diskUsage: totalHdd ? this.percentageString(usedHdd, totalHdd) : existing.diskUsage || "",
      diskUsed: totalHdd ? this.formatRouterBytes(usedHdd) : existing.diskUsed || "",
      diskTotal: totalHdd ? this.formatRouterBytes(totalHdd) : existing.diskTotal || "",
      availabilityStatus: existing.availabilityStatus || "",
      uptimePercent: existing.uptimePercent || "",
      monitoredPeriod: existing.monitoredPeriod || "",
      totalDowntime: existing.totalDowntime || "",
      currentUptime: live.uptime || existing.currentUptime || "",
      routerOsVersion: live.version || existing.routerOsVersion || "",
      deviceName: live.identity || station.name || existing.deviceName || "",
      hardwareModel: live["board-name"] || existing.hardwareModel || "",
      icmpLoss: existing.icmpLoss || "",
      icmpResponseTime: existing.icmpResponseTime || "",
      snmpAvailability: existing.snmpAvailability || "",
      extra: {
        ...(existing.extra && typeof existing.extra === "object" ? existing.extra : {}),
        architecture: live["architecture-name"] || existing?.extra?.architecture || "",
        platform: live.platform || existing?.extra?.platform || "",
        systemBasis: station.systemBasis || "API",
      },
      lastRefreshedAt: live.lastRefreshedAt || existing.lastRefreshedAt || null,
    };
  }

  async fetchLiveMikrotikInfo(platformID, station) {
    if (!platformID || !station?.mikrotikHost) return {};
    const connection = await this.mikrotik.config.createSingleMikrotikClient(platformID, station.mikrotikHost);
    if (!connection?.channel) return {};
    const { channel } = connection;
    try {
      const [resources, identities] = await Promise.all([
        this.mikrotik.mikrotik.listSystemResource(channel).catch(() => []),
        channel.write("/system/identity/print", []).catch(() => []),
      ]);
      const resource = Array.isArray(resources) ? resources[0] || {} : {};
      const identity = Array.isArray(identities) ? identities[0]?.name || "" : "";
      return { ...resource, identity, lastRefreshedAt: new Date() };
    } finally {
      await this.mikrotik.safeCloseChannel(channel);
    }
  }

  async fetchMikrotikInfo(req, res) {
    const { token, stationId, refresh } = req.body || {};
    if (!token || !stationId) {
      return res.status(400).json({ success: false, message: "Token and stationId are required." });
    }
    try {
      const auth = await this.auth.AuthenticateRequest(token);
      if (!auth.success) return res.status(401).json({ success: false, message: auth.message });
      if (auth.admin.role !== "superuser") return res.status(403).json({ success: false, message: "Unauthorised!" });

      const platformID = auth.admin.platformID;
      const station = await this.db.getStation(stationId);
      if (!station || station.platformID !== platformID) {
        return res.status(404).json({ success: false, message: "Station not found." });
      }

      const existing = await this.db.getMikrotikInfo(platformID, stationId);
      let live = {};
      if (refresh) {
        live = await this.fetchLiveMikrotikInfo(platformID, station).catch((error) => ({
          liveError: error?.message || String(error),
        }));
      }
      const info = this.buildMikrotikInfoSnapshot(station, existing || {}, live || {});
      const saved = await this.db.upsertMikrotikInfo(info);
      return res.json({
        success: true,
        message: refresh ? "MikroTik information refreshed" : "MikroTik information fetched",
        info: saved || info,
        liveError: live?.liveError || "",
      });
    } catch (error) {
      console.error("fetchMikrotikInfo error:", error);
      return res.status(500).json({ success: false, message: "Failed to fetch MikroTik information." });
    }
  }

  async saveMikrotikInfo(req, res) {
    const { token, stationId, info } = req.body || {};
    if (!token || !stationId || !info) {
      return res.status(400).json({ success: false, message: "Token, stationId and info are required." });
    }
    try {
      const auth = await this.auth.AuthenticateRequest(token);
      if (!auth.success) return res.status(401).json({ success: false, message: auth.message });
      if (auth.admin.role !== "superuser") return res.status(403).json({ success: false, message: "Unauthorised!" });

      const platformID = auth.admin.platformID;
      const station = await this.db.getStation(stationId);
      if (!station || station.platformID !== platformID) {
        return res.status(404).json({ success: false, message: "Station not found." });
      }

      const allowed = [
        "managementIp", "username", "password", "apiPort", "webfigUrl",
        "radiusAddress", "radiusSecret", "radiusAccountingPort", "radiusAuthPort",
        "cpuUsage", "memoryUsage", "memoryUsed", "memoryTotal", "diskUsage", "diskUsed", "diskTotal",
        "availabilityStatus", "uptimePercent", "monitoredPeriod", "totalDowntime", "currentUptime",
        "routerOsVersion", "deviceName", "hardwareModel", "icmpLoss", "icmpResponseTime", "snmpAvailability",
        "extra",
      ];
      const clean = { stationId, platformID };
      for (const key of allowed) {
        if (Object.prototype.hasOwnProperty.call(info, key)) clean[key] = info[key];
      }
      const saved = await this.db.upsertMikrotikInfo(clean);
      return res.json({ success: true, message: "MikroTik information saved", info: saved });
    } catch (error) {
      console.error("saveMikrotikInfo error:", error);
      return res.status(500).json({ success: false, message: "Failed to save MikroTik information." });
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
      const auth = await this.auth.AuthenticateRequest(token);
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

            const stationPackages = await this.db.getPackagesByHost(station.platformID, routerHost);
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

  async linkStations(req, res) {
    const { token, stationIds } = req.body || {};
    if (!token || !Array.isArray(stationIds) || stationIds.length < 2) {
      return res.status(400).json({ success: false, message: "token and at least 2 stationIds are required" });
    }
    try {
      const auth = await this.auth.AuthenticateRequest(token);
      if (!auth.success) return res.status(401).json({ success: false, message: auth.message });
      if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });

      const platformID = auth.admin.platformID;
      const stations = (await this.db.getStations(platformID)) || [];
      const selected = stations.filter((s) => stationIds.includes(s.id));
      if (selected.length < 2) {
        return res.status(404).json({ success: false, message: "Stations not found for this platform" });
      }

      const existingGroupIds = Array.from(
        new Set(selected.map((s) => s.linkGroupId).filter(Boolean))
      );
      const linkGroupId = existingGroupIds[0] || crypto.randomUUID();

      const mergeIds =
        existingGroupIds.length > 1
          ? stations
            .filter((s) => s.linkGroupId && existingGroupIds.includes(s.linkGroupId))
            .map((s) => s.id)
          : [];
      const idsToUpdate = Array.from(new Set([...mergeIds, ...selected.map((s) => s.id)]));

      for (const id of idsToUpdate) {
        await this.db.updateStation(id, { linkGroupId });
      }

      this.cache.delPrefix(`main:stations:${platformID}:`);
      this.cache.delPrefix(`main:search:${platformID}:stations`);
      await this.refreshDashboardStats(platformID, { role: auth.admin.role });

      const updated = await this.db.getStations(platformID);
      return res.json({
        success: true,
        message: "Stations linked successfully",
        linkGroupId,
        stations: updated,
      });
    } catch (error) {
      console.error("linkStations error:", error);
      return res.status(500).json({ success: false, message: "Failed to link stations" });
    }
  }

  async unlinkStation(req, res) {
    const { token, stationId } = req.body || {};
    if (!token || !stationId) {
      return res.status(400).json({ success: false, message: "token and stationId are required" });
    }
    try {
      const auth = await this.auth.AuthenticateRequest(token);
      if (!auth.success) return res.status(401).json({ success: false, message: auth.message });
      if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });

      const platformID = auth.admin.platformID;
      const station = await this.db.getStation(stationId);
      if (!station || station.platformID !== platformID) {
        return res.status(404).json({ success: false, message: "Station not found" });
      }
      const groupId = station.linkGroupId;
      if (!groupId) {
        return res.json({ success: true, message: "Station is not linked", stations: await this.db.getStations(platformID) });
      }

      await this.db.updateStation(stationId, { linkGroupId: null });
      const stations = (await this.db.getStations(platformID)) || [];
      const remaining = stations.filter((s) => s.linkGroupId === groupId);
      if (remaining.length <= 1) {
        for (const rem of remaining) {
          await this.db.updateStation(rem.id, { linkGroupId: null });
        }
      }

      this.cache.delPrefix(`main:stations:${platformID}:`);
      this.cache.delPrefix(`main:search:${platformID}:stations`);
      await this.refreshDashboardStats(platformID, { role: auth.admin.role });

      const updated = await this.db.getStations(platformID);
      return res.json({ success: true, message: "Station unlinked successfully", stations: updated });
    } catch (error) {
      console.error("unlinkStation error:", error);
      return res.status(500).json({ success: false, message: "Failed to unlink station" });
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

    const { code, phone, username, password, packageID, platformID: requestedPlatformID } = data;
    const stationId = data?.stationId || data?.stationID;
    const stationHostFromPayload =
      (data?.station && typeof data.station === "object"
        ? data.station.mikrotikHost || data.station.host
        : data?.station) ||
      data?.host ||
      data?.routerHost;
    const resolvedPackageID = packageID || data?.package?.connect?.id || data?.package?.id;

    try {
      const auth = await this.auth.AuthenticateRequest(token);
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
      if (!platformID) {
        return res.json({
          success: false,
          message: "Missing platformID for this account.",
        });
      }
      if (requestedPlatformID && requestedPlatformID !== platformID) {
        return res.json({
          success: false,
          message: "Invalid platform selected.",
        });
      }

      const pkg = await this.db.getPackagesByID(resolvedPackageID);
      if (!pkg) {
        return res.json({
          success: false,
          message: "Failed to add user to MikroTik, Package not found!",
        });
      }
      if (pkg.platformID && pkg.platformID !== platformID) {
        return res.json({
          success: false,
          message: "Selected package does not belong to your platform.",
        });
      }
      const { expiresIn, expiresAtISO } = this.mpesa.computeExpiryFromPackage(pkg);

      const profileName = pkg.name;
      let selectedStation = null;
      if (stationId) {
        selectedStation = await this.db.getStation(stationId);
        if (!selectedStation || selectedStation.platformID !== platformID) {
          return res.json({
            success: false,
            message: "Selected station not found!",
          });
        }
      }

      const requestedHost = selectedStation?.mikrotikHost || stationHostFromPayload || pkg.routerHost;
      if (requestedHost && pkg.routerHost && requestedHost !== pkg.routerHost) {
        return res.json({
          success: false,
          message: "Selected package does not belong to the selected station/router.",
        });
      }

      const hostdata = await this.db.getStations(platformID);
      if (!hostdata) {
        return res.json({
          success: false,
          message: "Failed to add user to MikroTik, Router not found!",
        });
      }

      const stationRecord = selectedStation || hostdata.find((s) => s.mikrotikHost === requestedHost);
      if (!stationRecord) {
        return res.json({
          success: false,
          message: "Failed to add user to MikroTik, Router not found!",
        });
      }
      const linkGroupId = stationRecord?.linkGroupId || null;
      const linkedStations = linkGroupId
        ? hostdata.filter((s) => s.linkGroupId === linkGroupId)
        : [stationRecord];
      const apiStations = linkedStations.filter(
        (s) => String(s?.systemBasis || "API").toUpperCase() !== "RADIUS"
      );
      const radiusStations = linkedStations.filter(
        (s) => String(s?.systemBasis || "API").toUpperCase() === "RADIUS"
      );
      const hasRadius = radiusStations.length > 0;
      const normalizedCode = typeof code === "string" ? code.trim() : "";
      if (normalizedCode) {
        const codeexists = await this.db.getUserByCodeAndPlatform(normalizedCode, platformID);
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

      const host = requestedHost || pkg.routerHost;
      let addUserToMikrotik = { success: true, username: "", password: "" };
      const addedUserHosts = [];
      let finalUsername = "";
      let finalPassword = "";
      const computePackageExpireAt = () => {
        if (!pkg?.period) return null;
        const match = String(pkg.period).trim().toLowerCase().match(/^(\d+)\s*(minute|min|hour|hr|day|month|year)s?$/i);
        if (!match) return null;
        const value = parseInt(match[1], 10);
        const rawUnit = String(match[2]).toLowerCase();
        const unit = rawUnit === "min" ? "minute" : rawUnit === "hr" ? "hour" : rawUnit;
        if (!Number.isFinite(value) || value <= 0) return null;
        return Utils.addPeriod(new Date(), value, unit);
      };
      const calculatedExpireAt = computePackageExpireAt();

      if (normalizedCode) {
        finalUsername = normalizedCode;
        finalPassword = normalizedCode;
      } else if (username && username.trim() && password && password.trim()) {
        finalUsername = username;
        finalPassword = password;
      } else {
        let generated = crypto.randomBytes(3).toString("hex").toUpperCase();
        let exists = await this.db.getUserByUsernameAndPlatform(generated, platformID);
        let attempts = 0;
        while (exists && attempts < 5) {
          generated = crypto.randomBytes(3).toString("hex").toUpperCase();
          exists = await this.db.getUserByUsernameAndPlatform(generated, platformID);
          attempts += 1;
        }
        finalUsername = generated;
        finalPassword = generated;
      }

      if (apiStations.length > 0) {
        for (const s of apiStations) {
          const stationHost = s?.mikrotikHost;
          if (!stationHost) continue;
          const mikrotikData = {
            platformID,
            action: "add",
            profileName,
            host: stationHost,
            code: normalizedCode || finalUsername,
            password: finalPassword,
            username: finalUsername,
            expireAt: calculatedExpireAt,
          };
          const result = await this.mikrotik.manageMikrotikUser(mikrotikData);
          if (!result?.success) {
            for (const addedHost of addedUserHosts) {
              try {
                await this.mikrotik.manageMikrotikUser({
                  platformID,
                  action: "remove",
                  host: addedHost,
                  username: finalUsername,
                });
              } catch { }
            }
            return res.json({
              success: false,
              message: `Failed to add user to linked station (${stationHost}): ${result?.message || "Unknown error"}`,
            });
          }
          addedUserHosts.push(stationHost);
          addUserToMikrotik = result;
          finalUsername = result.username || finalUsername;
          finalPassword = result.password || finalPassword;
        }
      }

      if (hasRadius) {
        const speedVal = String(pkg.speed || "").replace(/[^0-9.]/g, "");
        const rateLimit = speedVal ? `${speedVal}M/${speedVal}M` : "";
        const dataLimitBytes =
          this.parseDataLimitBytes(pkg.fupLimit) ||
          (String(pkg.category || "").toLowerCase() === "data" ? this.parseDataLimitBytes(pkg.usage) : null);
        await this.db.upsertRadiusUser({
          username: finalUsername,
          password: finalPassword,
          groupname: pkg.name,
          rateLimit,
          dataLimitBytes,
          expireAt: calculatedExpireAt,
          period: pkg.period,
          sessionTimeoutSeconds: null,
          devices: pkg.devices,
        });
      }

      if (addUserToMikrotik.success) {
        let expireAt = calculatedExpireAt;

        const tokenPayload = {
          phone: phone ? phone : "null",
          username: finalUsername,
          packageID: pkg.id,
          platformID: platformID,
        };
        const jwtToken = await this.mpesa.createHotspotToken(tokenPayload, expiresIn);

        let createdUser = null;
        try {
          createdUser = await this.db.createUser({
            status: "active",
            platformID: platformID,
            phone: phone ? phone : "null",
            code: normalizedCode || finalUsername,
            username: finalUsername,
            password: finalPassword,
            expireAt: expireAt,
            packageID: resolvedPackageID,
            token: jwtToken
          });
        } catch (err) {
          try {
            if (hasRadius) {
              await this.db.deleteRadiusUser(finalUsername);
            }
            for (const addedHost of addedUserHosts.length ? addedUserHosts : (apiStations || []).map((s) => s?.mikrotikHost).filter(Boolean)) {
              try {
                await this.mikrotik.manageMikrotikUser({
                  platformID,
                  action: "remove",
                  host: addedHost,
                  username: finalUsername,
                });
              } catch { }
            }
          } catch { }
          throw err;
        }

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

        this.refreshDashboardStats(platformID, { role: auth.admin.role }).catch((err) => {
          console.error("Dashboard stats refresh after addCode failed:", err?.message || err);
        });
        const mappedUser = {
          ...createdUser,
          station: pkg.routerHost,
          package: pkg.name,
          active: "Offline",
          systemBasis: hasRadius ? "RADIUS" : "API",
          bandwidthUsage: hasRadius
            ? { uploadBytes: 0, downloadBytes: 0, totalBytes: 0, online: false }
            : null,
        };
        return res.json({
          success: true,
          message: "Code added successfully",
          code: mappedUser,
          user: mappedUser,
        });
      } else {
        return res.json({
          success: false,
          message: `Failed to add user to MikroTik, ${addUserToMikrotik.message}`,
        });
      }

    } catch (error) {
      console.error("Add code failed:", {
        message: error?.message,
        stack: error?.stack,
        name: error?.name,
        code: error?.code,
        details: error,
      });
      return res.json({
        success: false,
        message: "An error occurred while adding the user",
        error: error?.message || error?.toString?.() || error,
      });
    }

  }

  async fetchDashboardStats(req, res) {

    const { token, stationId } = req.body;
    if (!token) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }

    try {
      const auth = await this.auth.AuthenticateRequest(token);
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
          let onlineHotspotUsers;
          let onlinePPPoEUsers;
          let stationOnlineUsers;
          try {
            const counts = await this.mikrotik.fetchActiveConnectionsForStation(platformID, stationId);
            onlineHotspotUsers = counts?.hotspot || 0;
            onlinePPPoEUsers = counts?.pppoe || 0;
            stationOnlineUsers = { [stationId]: { hotspot: onlineHotspotUsers, pppoe: onlinePPPoEUsers } };
          } catch (error) {
            onlineHotspotUsers = undefined;
            onlinePPPoEUsers = undefined;
            stationOnlineUsers = {};
          }
          const response = await this.db.rebuildStationDashboardStats(platformID, stationId, {
            role: auth.admin.role,
            onlineHotspotUsers,
            onlinePPPoEUsers,
            stationOnlineUsers,
          });
          if (!response) {
            return res.status(500).json({ success: false, message: "Failed to build station dashboard stats." });
          }
          return res.status(200).json(this.buildDashboardResponse(response, auth.admin.role));
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
      const settings = await this.db.getSettings();
      const managerPaybillBalance = Number(settings?.managerShortCodeBalance || 0);

      const stats = {
        totalAdmins: adminstotalTally,
        totalPlatforms: platformstotalTally,
        revenue: revenue.totalRevenue,
        smsBalace,
        remainingSMS,
        managerPaybillBalance,
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

  async managerAuthHealth(req, res) {
    const { token } = req.body || {};
    if (!token) {
      return res.status(400).json({ success: false, message: "Missing credentials required!" });
    }

    const session = await this.authManagerSession(token);
    if (!session.success) {
      return res.status(401).json({ success: false, message: session.message || "Unauthorised!" });
    }

    const checkedAt = new Date().toISOString();
    const tests = {
      registration: { ok: false, message: "" },
      login: { ok: false, message: "" },
    };

    try {
      // "Registration" readiness: DB reachable + billing service configured.
      await this.db.getSettings();
      const billingService = await this.db.getSystemServiceByKey("billing");
      if (!billingService) {
        tests.registration.ok = false;
        tests.registration.message = "Billing service not configured";
      } else {
        tests.registration.ok = true;
        tests.registration.message = "OK";
      }
    } catch (error) {
      tests.registration.ok = false;
      tests.registration.message = error?.message || "Registration health check failed";
    }

    try {
      // "Login" readiness: DB reachable for Admin table queries (common login dependency).
      await this.db.getAdminByEmail("healthcheck@novawifi.invalid");
      tests.login.ok = true;
      tests.login.message = "OK";
    } catch (error) {
      tests.login.ok = false;
      tests.login.message = error?.message || "Login health check failed";
    }

    const up = tests.registration.ok && tests.login.ok;

    let smsAlert = null;
    if (!up) {
      let phone = "";
      try {
        const settings = await this.db.getSettings();
        phone = settings?.phone || "";
      } catch (error) {
        phone = "";
      }
      const alertKey = "manager:auth-health:alert-sent";
      const recentlyAlerted = this.cache.get(alertKey);

      if (phone && !recentlyAlerted) {
        const details = [
          `registration=${tests.registration.ok ? "OK" : "FAIL"}`,
          `login=${tests.login.ok ? "OK" : "FAIL"}`,
        ].join(", ");
        const message = `NOVAWIFI ALERT: Signup/Login health check DOWN at ${checkedAt}. ${details}.`;
        smsAlert = await this.sms.sendInternalSMS(phone, message);
        this.cache.set(alertKey, { checkedAt, details }, 30 * 60 * 1000);
      } else if (!phone) {
        smsAlert = { success: false, message: "No manager settings phone configured for SMS alerts." };
      } else {
        smsAlert = { success: false, message: "SMS alert suppressed (recently sent)." };
      }
    }

    return res.json({
      success: true,
      up,
      checkedAt,
      tests,
      smsAlert,
    });
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
      const auth = await this.auth.AuthenticateRequest(token);
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
      const auth = await this.auth.AuthenticateRequest(token);
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
      const auth = await this.auth.AuthenticateRequest(token);
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
      const auth = await this.auth.AuthenticateRequest(token);
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
      const user = await this.db.getUserByUsernameAndPlatform(username, platformID);
      const pkg = user?.packageID ? await this.db.getPackagesByID(user.packageID) : null;
      await this.db.deleteUser(id);
      this.cache.delPrefix(`main:search:${platformID}:users:`);

      void (async () => {
        try {
          if (pkg) {
            const stations = await this.db.getStations(platformID);
            const stationRecord = stations.find((s) => s.mikrotikHost === pkg?.routerHost);
            const isRadius = stationRecord?.systemBasis === "RADIUS";

            if (isRadius) {
              await this.db.deleteRadiusUser(username);
            } else {
              const userdata = {
                platformID: platformID,
                action: "remove",
                profileName: "none",
                host: pkg.routerHost,
                username: username
              };
              const removeuserfrommikrotik = await this.mikrotik.manageMikrotikUser(userdata);
              if (!removeuserfrommikrotik.success) {
                console.warn("User deleted from database but not removed from MikroTik:", {
                  username,
                  platformID,
                  message: removeuserfrommikrotik.message,
                });
              }
            }
          }
          await this.refreshDashboardStats(platformID, { role: auth.admin.role });
        } catch (cleanupError) {
          console.error("User delete cleanup failed:", cleanupError);
        }
      })();

      return res.json({
        success: true,
        message: pkg
          ? "User deleted. Router cleanup is running in the background."
          : "User deleted.",
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
      const auth = await this.auth.AuthenticateRequest(token);
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
      const auth = await this.auth.AuthenticateRequest(token);
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
      const [plans, stations] = await Promise.all([
        this.db.getPPPoEPlans(platformID),
        this.db.getStations(platformID),
      ]);
      const stationOrder = new Map(
        (Array.isArray(stations) ? stations : [])
          .map((item, index) => [item.mikrotikHost, index])
          .filter(([host]) => Boolean(host))
      );
      const planById = new Map((plans || []).map((plan) => [plan.id, plan]));
      const radiusHosts = new Set(
        (Array.isArray(stations) ? stations : [])
          .filter((item) => String(item?.systemBasis || "API").toUpperCase() === "RADIUS")
          .map((item) => item.mikrotikHost)
          .filter(Boolean)
      );

      const updatedPppoes = scopedPppoes
        .map((pppoe) => ({
          ...pppoe,
          planName: planById.get(pppoe.planId)?.name || (pppoe.planId ? "Unknown plan" : pppoe.name || "-"),
          link: `https://${platform.url}/pppoe?info=${pppoe.paymentLink}`,
        }))
        .sort((a, b) => {
          const stationA = stationOrder.has(a.station) ? stationOrder.get(a.station) : Number.MAX_SAFE_INTEGER;
          const stationB = stationOrder.has(b.station) ? stationOrder.get(b.station) : Number.MAX_SAFE_INTEGER;
          if (stationA !== stationB) return stationA - stationB;
          const nameA = String(a.clientname || a.name || "").toLowerCase();
          const nameB = String(b.clientname || b.name || "").toLowerCase();
          const nameCompare = nameA.localeCompare(nameB);
          if (nameCompare !== 0) return nameCompare;
          return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
        });

      if (updatedPppoes.length === 0) {
        const response = {
          success: true,
          message: "PPPoE fetched successfully!",
          pppoe: [],
          total: 0,
          limit,
          offset,
        };
        this.cache.set(cacheKey, response, 3000);
        return res.json(response);
      }

      const stationHosts = Array.from(
        new Set(updatedPppoes.map((pppoe) => pppoe.station).filter(Boolean))
      );
      const apiStationHosts = stationHosts.filter((host) => !radiusHosts.has(host));
      const radiusStationHosts = stationHosts.filter((host) => radiusHosts.has(host));
      const radiusUsernames = updatedPppoes
        .filter((pppoe) => radiusHosts.has(pppoe.station))
        .map((pppoe) => pppoe.clientname)
        .filter(Boolean);

      const [statusResults, radiusStatusResults, radiusUsage] = await Promise.all([
        Promise.all(
          apiStationHosts.map((host) =>
            this.mikrotik.checkPPPUserStatus(platformID, host)
          )
        ),
        Promise.all(
          radiusStationHosts.map((host) =>
            this.mikrotik.checkPPPUserStatus(platformID, host)
          )
        ),
        this.db.getRadiusUsageDetailsByUsernames(radiusUsernames, {
          requireRecentActivity: false,
        }),
      ]);

      const activeUsernames = new Set();
      const radiusActiveUsernames = new Set();
      let mikrotikFailed = apiStationHosts.length > 0;

      for (const result of statusResults) {
        if (result?.success) {
          mikrotikFailed = false;
          for (const user of result.users || []) {
            if (user?.name) activeUsernames.add(user.name);
          }
        }
      }
      for (const result of radiusStatusResults) {
        if (result?.success) {
          for (const user of result.users || []) {
            if (user?.name) radiusActiveUsernames.add(user.name);
          }
        }
      }

      const newPPPoEs = [];
      for (const pppoe of updatedPppoes) {
        if (pppoe.status !== "active") {
          newPPPoEs.push({
            ...pppoe,
            active: "Offline",
            bandwidthUsage: radiusHosts.has(pppoe.station)
              ? radiusUsage[pppoe.clientname] || { uploadBytes: 0, downloadBytes: 0, totalBytes: 0, online: false }
              : null,
          });
          continue;
        }

        const isRadius = radiusHosts.has(pppoe.station);
        const userRadiusUsage = isRadius
          ? radiusUsage[pppoe.clientname] || { uploadBytes: 0, downloadBytes: 0, totalBytes: 0, online: false }
          : null;
        const isActive = isRadius
          ? Boolean(userRadiusUsage?.online) || radiusActiveUsernames.has(pppoe.clientname)
          : !mikrotikFailed && activeUsernames.has(pppoe.clientname);
        newPPPoEs.push({
          ...pppoe,
          active: isActive ? "Online" : "Offline",
          bandwidthUsage: userRadiusUsage,
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
      this.cache.set(cacheKey, response, 3000);
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

    const { token, stationId, host, station: stationHost } = req.body;

    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const auth = await this.auth.AuthenticateRequest(token);
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
      const selectedRouter = await this.resolveTemplateUploadStation(platformID, stationId, host || stationHost);
      if (!selectedRouter.success) {
        return res.status(selectedRouter.status || 400).json({
          success: false,
          message: selectedRouter.message,
        });
      }
      const station = selectedRouter.station;
      const cacheKey = `main:templates:${platformID}:${station.id}`;
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
      const templates = this.withOfflineBoxOnlineTemplate(await this.db.getTemplates());
      const { offlineTemplateName, templateMode, defaulttemplate } =
        this.getStationTemplateSelection(config, station);

      const response = {
        success: true,
        message: "Templates fetched succesfully!",
        templates: templates,
        default: templateMode === "offline" ? "" : defaulttemplate,
        templateMode,
        offlineTemplate: offlineTemplateName,
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

  getStationTemplateSelection(config, station) {
    const offlineTemplateName = "OfflineBox";
    const legacyTemplate = config?.template;
    const storedMode = String(station?.hotspotTemplateMode || "").toLowerCase();
    const templateMode = storedMode === "offline" || storedMode === "online"
      ? storedMode
      : String(legacyTemplate || "").toLowerCase() === offlineTemplateName.toLowerCase()
        ? "offline"
        : "online";
    return {
      templateMode,
      defaulttemplate: station?.hotspotTemplateName || (templateMode === "online" ? legacyTemplate : ""),
      offlineTemplateName,
    };
  }

  withOfflineBoxOnlineTemplate(templates) {
    const list = Array.isArray(templates) ? [...templates] : [];
    const exists = list.some((template) => String(template?.name || "").toLowerCase() === "offlinebox");
    if (!exists) {
      list.push({
        id: "offlinebox-online-template",
        name: "OfflineBox",
        url: "/login?template=OfflineBox",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    return list;
  }

  async resolveTemplateUploadStation(platformID, stationId, host) {
    const normalizedHost = String(host || "").trim();
    const invalidHostSelections = new Set(["all", "all routers", "*"]);

    if (!stationId && (!normalizedHost || invalidHostSelections.has(normalizedHost.toLowerCase()))) {
      return { success: false, status: 400, message: "Please select one MikroTik router before saving a template." };
    }

    let station = null;
    if (stationId) {
      station = await this.db.getStation(stationId);
      if (!station || station.platformID !== platformID) {
        return { success: false, status: 404, message: "Selected MikroTik router was not found." };
      }
      if (normalizedHost && station.mikrotikHost !== normalizedHost) {
        return { success: false, status: 400, message: "Selected router does not match the submitted host." };
      }
    } else {
      const stations = await this.db.getStations(platformID);
      station = (Array.isArray(stations) ? stations : []).find((item) => item.mikrotikHost === normalizedHost);
      if (!station) {
        return { success: false, status: 404, message: "Selected MikroTik router was not found." };
      }
    }

    if (!station?.mikrotikHost) {
      return { success: false, status: 400, message: "Selected MikroTik router is missing its host address." };
    }
    if (!["API", "RADIUS", ""].includes(String(station?.systemBasis || "API").toUpperCase())) {
      return { success: false, status: 400, message: "Selected router does not support hotspot template uploads." };
    }

    return { success: true, station };
  }

  withTimeout(promise, timeoutMs, message) {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
  }

  async syncHotspotLoginTemplates(platformID, mode, options = {}) {
    if (options.station) {
      const station = options.station;
      const host = station.mikrotikHost;
      const results = [];
      try {
        const upload = await this.withTimeout(
          this.mikrotik.uploadHotspotLoginTemplate(platformID, host, {
            mode,
            templateName: options.templateName,
          }),
          45000,
          "login.html upload timed out on selected router"
        );
        results.push({
          stationId: station.id,
          host,
          success: Boolean(upload?.success),
          message: upload?.message || "login.html uploaded",
        });
      } catch (error) {
        results.push({
          stationId: station.id,
          host,
          success: false,
          message: error?.message || "Failed to upload login.html",
        });
      }

      return {
        mode,
        total: results.length,
        success: results.filter((result) => result.success).length,
        failed: results.filter((result) => !result.success).length,
        results,
      };
    }

    const stations = await this.db.getMikrotikPlatformConfig(platformID);
    const targets = (Array.isArray(stations) ? stations : [])
      .filter((station) => station?.mikrotikHost)
      .filter((station) => ["API", "RADIUS", ""].includes(String(station?.systemBasis || "API").toUpperCase()));

    const results = [];
    for (const station of targets) {
      const host = station.mikrotikHost;
      try {
        const upload = await this.withTimeout(
          this.mikrotik.uploadHotspotLoginTemplate(platformID, host, {
            mode,
            templateName: options.templateName,
          }),
          45000,
          "login.html upload timed out on router"
        );
        results.push({
          stationId: station.id,
          host,
          success: Boolean(upload?.success),
          message: upload?.message || "login.html uploaded",
        });
      } catch (error) {
        results.push({
          stationId: station.id,
          host,
          success: false,
          message: error?.message || "Failed to upload login.html",
        });
      }
    }

    return {
      mode,
      total: results.length,
      success: results.filter((result) => result.success).length,
      failed: results.filter((result) => !result.success).length,
      results,
    };
  }

  async updateTemplate(req, res) {

    const { token, name, mode, stationId, host, station } = req.body;
    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }
    try {
      const auth = await this.auth.AuthenticateRequest(token);
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
      const templateMode = String(mode || "online").trim().toLowerCase();
      const offlineTemplateName = "OfflineBox";
      const nextTemplate = templateMode === "offline" ? offlineTemplateName : name;

      if (!platformID || !nextTemplate) {
        return res.status(400).json({
          success: false,
          message: "Missing required credentials!",
        });
      }

      const selectedRouter = await this.resolveTemplateUploadStation(platformID, stationId, host || station);
      if (!selectedRouter.success) {
        return res.status(selectedRouter.status || 400).json({
          success: false,
          message: selectedRouter.message,
        });
      }

      const existingPlatform = await this.db.getPlatformConfig(platformID);
      if (!existingPlatform) {
        return res.status(404).json({
          success: false,
          message: "Platform not found!"
        });
      }

      const uploadMode = templateMode === "offline" ? "offline" : "online";
      const uploadStation = selectedRouter.station;
      const uploadSummary = await this.syncHotspotLoginTemplates(platformID, uploadMode, {
        station: uploadStation,
        templateName: uploadMode === "online" ? nextTemplate : "",
      });
      const failed = Number(uploadSummary?.failed || 0);
      const firstResult = Array.isArray(uploadSummary?.results) ? uploadSummary.results[0] : null;

      this.logPlatform(
        platformID,
        failed > 0
          ? `login.html upload failed on ${failed}/${uploadSummary?.total || 1} router(s) after template update`
          : `login.html uploaded to ${uploadStation?.name || uploadStation?.mikrotikHost || "selected router"} after template update`,
        { context: "templates", level: failed > 0 ? "warn" : "info", uploadSummary }
      );

      if (failed > 0) {
        return res.status(502).json({
          success: false,
          message: firstResult?.message || "login.html failed to upload to the selected MikroTik. Template was not changed.",
          template: nextTemplate,
          templateMode: templateMode === "offline" ? "offline" : "online",
          uploadSummary,
        });
      }

      const updatedStation = await this.db.updateStation(uploadStation.id, {
        hotspotTemplateMode: uploadMode,
        hotspotTemplateName: uploadMode === "online" ? nextTemplate : null,
      });
      if (!updatedStation?.id) {
        return res.status(500).json({
          success: false,
          message: "Template reached the MikroTik, but its station setting could not be saved. Please retry.",
          uploadSummary,
        });
      }
      this.cache.del(`main:templates:${platformID}:${uploadStation.id}`);

      return res.status(200).json({
        success: true,
        message: templateMode === "offline"
          ? firstResult?.message || "Offline template selected and login.html uploaded to the selected router."
          : firstResult?.message || "Template updated and login.html uploaded to the selected router.",
        template: nextTemplate,
        templateMode: templateMode === "offline" ? "offline" : "online",
        uploadSummary,
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
      const submittedCode = String(code).trim();
      let existingcode = await this.db.getUniqueCode(submittedCode, platformID);
      if (!existingcode) {
        existingcode = await this.db.getUniqueCodeCaseInsensitive(submittedCode, platformID);
      }
      if (!existingcode) {
        if (hash) {
          const host = Utils.decodeHashedIP(hash);
          const routercode = await this.mikrotik.verifyMikrotikUser({ platformID, code: submittedCode, host })
          if (!routercode.success) {
            return res.json({
              success: false,
              message: "Code does not exist!"
            })
          }
          return res.status(200).json({
            success: true,
            message: "Code verified!",
            code: submittedCode,
            password: submittedCode,
          });
        }
        const payment = await this.db.getMpesaCode(submittedCode);
        if (payment) {
          const pkg = await this.db.getPackagesByAmount(payment?.platformID, `${parseInt(payment.amount)}`, payment.reason);

          if (pkg) {
            const data = {
              phone: payment.phone,
              packageID: pkg.id,
              platformID: payment.platformID,
              package: pkg,
              routerHost: pkg.routerHost,
              code: submittedCode,
              mac: "null",
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
              code: submittedCode,
              password: submittedCode,
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
      const auth = await this.auth.AuthenticateRequest(token);
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
      const auth = await this.auth.AuthenticateRequest(token);
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
      const auth = await this.auth.AuthenticateRequest(token);
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
      const auth = await this.auth.AuthenticateRequest(token);
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

      this.refreshDashboardStats(platformID, { role: auth.admin.role }).catch((err) => {
        console.error("Dashboard stats refresh after payment update failed:", err?.message || err);
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
      const auth = await this.auth.AuthenticateRequest(token);
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
      const auth = await this.auth.AuthenticateRequest(token);
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
      const auth = await this.auth.AuthenticateRequest(token);
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

  getManagerOpsPackageRoots() {
    const serverRoot = fs.existsSync(path.join(appRoot, "package.json")) &&
      fs.existsSync(path.join(appRoot, "controllers"))
      ? appRoot
      : path.resolve(appRoot, "server");
    const workspaceRoot = path.dirname(serverRoot);
    return [
      { id: "server", label: "Server", cwd: serverRoot },
      { id: "client", label: "Client", cwd: path.resolve(workspaceRoot, "client") },
      { id: "landing", label: "Landing", cwd: path.resolve(workspaceRoot, "landing") },
      { id: "dedicated-client", label: "Dedicated Client", cwd: path.resolve(workspaceRoot, "dedicated-client") },
    ];
  }

  getManagerOpsRoot(rootId) {
    return this.getManagerOpsPackageRoots().find((root) => root.id === rootId && fs.existsSync(root.cwd));
  }

  readPackageScripts(root) {
    try {
      const packagePath = path.join(root.cwd, "package.json");
      const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
      return Object.keys(pkg.scripts || {}).map((name) => ({
        id: `${root.id}:${name}`,
        root: root.id,
        rootLabel: root.label,
        name,
        command: `npm run ${name}`,
        script: pkg.scripts[name],
      }));
    } catch (_error) {
      return [];
    }
  }

  getManagerOpsDefinitions() {
    return [
      {
        id: "provision-mikrotik-rescue",
        label: "Provision MikroTik SSTP Rescue",
        description: "Queue/upload the SSTP rescue installer to all routers or one station, then step aside.",
        command: "node ops/provision-mikrotik-rescue.js --apply --direct",
        fields: [
          { name: "station", label: "Station", type: "station", placeholder: "All routers" },
        ],
      },
      {
        id: "seed-webfig-nginx-sites",
        label: "Seed WebFig Nginx Sites",
        description: "Regenerate WebFig nginx mappings for stations that have or need WebFig hosts.",
        command: "npm run seed:webfig-nginx-sites",
      },
      {
        id: "seed-update-station-ddns",
        label: "Update Station DDNS",
        description: "Refresh stored station DDNS/WebFig data from known station records.",
        command: "npm run seed:update-station-ddns",
      },
      {
        id: "seed-provision-nginx-sites",
        label: "Provision Platform Nginx Sites",
        description: "Repair/provision platform portal nginx sites from stored platform URLs.",
        command: "npm run seed:provision-nginx-sites",
      },
      {
        id: "seed-router-walled-garden",
        label: "Seed Router Walled Garden",
        description: "Push portal/walled-garden allow rules to routers.",
        command: "npm run seed:router-walled-garden",
      },
      {
        id: "seed-auto-backup-script",
        label: "Seed Auto Backup Script",
        description: "Install or refresh MikroTik auto-backup scheduler scripts.",
        command: "npm run seed:auto-backup-script",
      },
    ];
  }

  runManagedCommand(command, args = [], options = {}) {
    const cwd = options.cwd || path.resolve(appRoot, "server");
    const timeout = Number(options.timeout || 5 * 60 * 1000);
    return new Promise((resolve) => {
      const startedAt = Date.now();
      execFile(command, args, {
        cwd,
        timeout,
        maxBuffer: 1024 * 1024 * 4,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        resolve({
          success: !error,
          exitCode: typeof error?.code === "number" ? error.code : 0,
          signal: error?.signal || null,
          command: [command, ...args].join(" "),
          cwd,
          durationMs: Date.now() - startedAt,
          stdout: String(stdout || "").slice(-12000),
          stderr: String(stderr || error?.message || "").slice(-12000),
        });
      });
    });
  }

  async resolveManagerOpsStation(station) {
    const value = String(station || "").trim();
    if (!value) return null;
    const stations = (await this.db.getAdminStations().catch(() => [])) || [];
    return stations.find((item) =>
      String(item?.id || "") === value ||
      String(item?.mikrotikHost || "") === value ||
      String(item?.name || "") === value
    ) || null;
  }

  buildManagerOpsScriptArgs(scriptName, station = null) {
    const script = String(scriptName || "").trim();
    const platformID = String(station?.platformID || "").trim();
    const stationId = String(station?.id || "").trim();
    const host = String(station?.mikrotikHost || "").trim();

    if (script === "seed:cleanup-expired-hotspot" || script === "seed:auto-backup-script") {
      if (!station) return ["--all-platforms"];
      const args = [];
      if (platformID) args.push(`--platformID=${platformID}`);
      if (stationId) args.push(`--stationId=${stationId}`);
      if (host) args.push(`--host=${host}`);
      return args;
    }

    const platformScopedScripts = new Set([
      "seed:dashboard",
      "seed:webfig-nginx-sites",
      "seed:provision-nginx-sites",
      "seed:redirect-online-to-co-ke",
      "seed:router-walled-garden",
      "seed:notify-upgrade-complete",
    ]);

    if (station && platformScopedScripts.has(script) && platformID) {
      return [`--platforms=${platformID}`];
    }

    return [];
  }

  async managerOpsList(req, res) {
    const { token } = req.body || {};
    const session = await this.authManagerSession(token);
    if (!session.success) return res.status(401).json(session);

    const packageRoots = this.getManagerOpsPackageRoots()
      .filter((root) => fs.existsSync(path.join(root.cwd, "package.json")))
      .map((root) => ({
        id: root.id,
        label: root.label,
        scripts: this.readPackageScripts(root),
      }));
    const stations = (await this.db.getAdminStations().catch(() => [])) || [];

    return res.json({
      success: true,
      packageRoots,
      ops: this.getManagerOpsDefinitions(),
      stations: stations.map((station) => ({
        id: station.id,
        name: station.name,
        platformID: station.platformID,
        mikrotikHost: station.mikrotikHost,
        mikrotikWebfigHost: station.mikrotikWebfigHost,
        systemBasis: station.systemBasis,
      })),
    });
  }

  async managerOpsRun(req, res) {
    const { token, type, root, script, op, station } = req.body || {};
    const session = await this.authManagerSession(token);
    if (!session.success) return res.status(401).json(session);

    try {
      const selectedStation = await this.resolveManagerOpsStation(station);
      if (station && !selectedStation) {
        return res.status(400).json({ success: false, message: "Selected station was not found." });
      }

      if (type === "package") {
        const selectedRoot = this.getManagerOpsRoot(root);
        if (!selectedRoot) return res.status(400).json({ success: false, message: "Unknown package root." });
        const scripts = this.readPackageScripts(selectedRoot);
        if (!scripts.some((item) => item.name === script)) {
          return res.status(400).json({ success: false, message: "Unknown package script." });
        }
        const scriptArgs = selectedRoot.id === "server" ? this.buildManagerOpsScriptArgs(script, selectedStation) : [];
        const npmArgs = ["run", script];
        if (scriptArgs.length) npmArgs.push("--", ...scriptArgs);
        const result = await this.runManagedCommand("npm", npmArgs, {
          cwd: selectedRoot.cwd,
          timeout: 10 * 60 * 1000,
        });
        return res.json({ ...result, title: `${selectedRoot.label}: npm run ${script}` });
      }

      if (type === "op") {
        const opDef = this.getManagerOpsDefinitions().find((item) => item.id === op);
        if (!opDef) return res.status(400).json({ success: false, message: "Unknown operation." });
        let result;
        if (op === "provision-mikrotik-rescue") {
          const args = ["ops/provision-mikrotik-rescue.js", "--apply", "--direct"];
          if (selectedStation?.mikrotikHost) args.push("--station", selectedStation.mikrotikHost);
          if (selectedStation?.id) args.push("--stationId", selectedStation.id);
          result = await this.runManagedCommand("node", args, {
            cwd: this.getManagerOpsRoot("server")?.cwd || appRoot,
            timeout: 10 * 60 * 1000,
          });
        } else {
          const scriptMap = {
            "seed-webfig-nginx-sites": "seed:webfig-nginx-sites",
            "seed-update-station-ddns": "seed:update-station-ddns",
            "seed-provision-nginx-sites": "seed:provision-nginx-sites",
            "seed-router-walled-garden": "seed:router-walled-garden",
            "seed-auto-backup-script": "seed:auto-backup-script",
          };
          const mappedScript = scriptMap[op];
          const scriptArgs = this.buildManagerOpsScriptArgs(mappedScript, selectedStation);
          const npmArgs = ["run", mappedScript];
          if (scriptArgs.length) npmArgs.push("--", ...scriptArgs);
          result = await this.runManagedCommand("npm", npmArgs, {
            cwd: this.getManagerOpsRoot("server")?.cwd || appRoot,
            timeout: 10 * 60 * 1000,
          });
        }
        return res.json({ ...result, title: opDef.label });
      }

      return res.status(400).json({ success: false, message: "Unknown operation type." });
    } catch (error) {
      return res.status(500).json({ success: false, message: error?.message || "Operation failed." });
    }
  }

  async managerRepairSite(req, res) {
    const { token, url, targetUrl } = req.body || {};
    const session = await this.authManagerSession(token);
    if (!session.success) return res.status(401).json(session);

    const domain = this.sanitizeDomain(url);
    if (!domain) return res.status(400).json({ success: false, message: "Invalid URL/domain." });

    try {
      const station = await this.db.getStationByWebfigHost(domain);
      if (station) {
        const repair = await this.ensureStationWebfigSite(station);
        return res.json({ ...repair, kind: "webfig", station });
      }

      const platform = await this.db.getPlatformByURLData(domain).catch(() => null);
      let target = this.normalizeProxyTargetUrl(targetUrl);
      let verifyOptions = {};
      if (platform) {
        target = this.getSharedPortalTarget();
        verifyOptions = { path: "/admin/login", rejectStatusCodes: ["404"] };
      }
      if (!target) {
        return res.status(400).json({
          success: false,
          message: "Target URL is required when the domain is not a known platform or WebFig host.",
        });
      }

      const provision = await this.addReverseProxySite(domain, target);
      if (!provision.success) return res.json(provision);
      const verification = await this.verifyNginxSite(domain, target, verifyOptions);
      return res.json({
        success: verification.success,
        kind: platform ? "platform" : "custom",
        domain,
        target,
        provision,
        verification,
        message: verification.success ? `Nginx site repaired for ${domain}` : verification.message,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: error?.message || "Site repair failed." });
    }
  }

  buildManagedSubdomain(value) {
    const baseDomain = process.env.DOMAIN || "novawifi.co.ke";
    const raw = String(value || "").trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
    if (!raw) return null;
    const domain = raw.endsWith(`.${baseDomain}`) ? raw : `${raw}.${baseDomain}`;
    const safeDomain = this.sanitizeDomain(domain);
    if (!safeDomain || safeDomain === baseDomain || !safeDomain.endsWith(`.${baseDomain}`)) return null;
    const prefix = safeDomain.slice(0, -(`.${baseDomain}`).length);
    const labels = prefix.split(".");
    const validLabels = labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
    return validLabels ? safeDomain : null;
  }

  normalizeManagedProxyTarget({ targetHost, targetPort, targetProtocol }) {
    const protocol = String(targetProtocol || "http").trim().toLowerCase() === "https" ? "https" : "http";
    const port = Number(targetPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

    let host = String(targetHost || "").trim();
    if (!host) return null;
    try {
      if (/^https?:\/\//i.test(host)) {
        const parsed = new URL(host);
        host = parsed.hostname;
      } else {
        host = host.split("/")[0].split(":")[0];
      }
    } catch (_error) {
      return null;
    }

    const safeHost = this.sanitizeDomain(host);
    const isIp = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host);
    if (!safeHost && !isIp) return null;
    if (isIp && !host.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255)) return null;
    return `${protocol}://${host}:${port}`;
  }

  async nginxSiteExists(domain) {
    const safeDomain = this.sanitizeDomain(domain);
    if (!safeDomain) return true;
    const paths = [
      `/etc/nginx/sites-available/${safeDomain}`,
      `/etc/nginx/sites-enabled/${safeDomain}`,
    ];
    for (const sitePath of paths) {
      try {
        await fsp.lstat(sitePath);
        return true;
      } catch (error) {
        if (error?.code !== "ENOENT") return true;
      }
    }
    return false;
  }

  async managerCreateSubdomainSite(req, res) {
    const { token, subdomain, targetHost, targetPort, targetProtocol } = req.body || {};
    const session = await this.authManagerSession(token);
    if (!session.success) return res.status(401).json(session);

    const domain = this.buildManagedSubdomain(subdomain);
    if (!domain) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid novawifi.co.ke subdomain.",
      });
    }

    const target = this.normalizeManagedProxyTarget({ targetHost, targetPort, targetProtocol });
    if (!target) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid target domain/IP and port.",
      });
    }

    try {
      const taken = await this.nginxSiteExists(domain);
      if (taken) {
        return res.status(409).json({
          success: false,
          message: `${domain} already has an nginx site configured.`,
          domain,
        });
      }

      const wildcard = this.getWildcardCertificatePaths(domain);
      const provision = await this.addReverseProxySite(domain, target);
      return res.json({
        ...provision,
        title: `Create ${domain}`,
        domain,
        target,
        ssl: provision.ssl || {
          success: Boolean(wildcard.hasWildcardCert),
          message: "Using wildcard SSL certificate.",
        },
        message: provision.success
          ? `Subdomain ${domain} now proxies to ${target}.`
          : provision.message,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: error?.message || "Subdomain site creation failed.",
      });
    }
  }

  resolveHotspotTemplateHost({ hash, station, config } = {}) {
    const stationHost = String(station || "").trim();
    if (Utils.isValidIP(stationHost) && stationHost.startsWith("10.10.10.")) {
      return stationHost;
    }

    if (hash) {
      try {
        const decoded = Utils.decodeHashedIP(hash);
        if (Utils.isValidIP(decoded) && decoded.startsWith("10.10.10.")) {
          return decoded;
        }
      } catch (error) { }
    }

    const configHost = String(config?.mikrotikHost || "").trim();
    if (Utils.isValidIP(configHost) && configHost.startsWith("10.10.10.")) {
      return configHost;
    }

    return "";
  }

  async buildOfflineBoxLoginHtml(platformID, options = {}) {
    const platform = await this.db.getPlatform(platformID);
    const config = await this.db.getPlatformConfig(platformID);
    if (!platform || !config) {
      throw new Error("Platform data not found");
    }

    const host = this.resolveHotspotTemplateHost({
      hash: options.hash,
      station: options.station || options.host,
      config,
    });
    let packages = [];
    if (host) {
      packages = await this.db.getPackagesByHost(platformID, host);
    } else {
      packages = await this.db.getPackages(platformID);
    }

    return renderOfflineBoxLoginTemplate({
      req: options.req,
      platform,
      config,
      packages,
      platformID,
      host,
      hash: options.hash || getHotspotHash(host),
      preview: Boolean(options.preview),
    });
  }

  async hotspotLoginTemplate(req, res) {
    const token = req.body?.token || req.query?.token;
    let platformID = req.body?.platformID || req.params?.platformID || req.query?.platformID;
    let station = req.body?.station || req.query?.station || req.body?.host || req.query?.host;
    const stationId = req.body?.stationId || req.query?.stationId;
    const hash = req.body?.hash || req.query?.hash;
    const preview = req.body?.preview === true || req.body?.preview === "true" || req.query?.preview === "true";

    if (token) {
      const auth = await this.auth.AuthenticateRequest(token);
      if (!auth.success) {
        return res.status(401).json({ success: false, message: auth.message });
      }
      platformID = platformID || auth.admin?.platformID;
    }

    if (!platformID) {
      return res.status(400).json({ success: false, message: "Platform ID is required." });
    }

    try {
      if (!station && stationId) {
        const stationRecord = await this.db.getStation(stationId);
        if (stationRecord?.platformID === platformID) {
          station = stationRecord.mikrotikHost;
        }
      }
      const html = await this.buildOfflineBoxLoginHtml(platformID, { station, hash, req, preview });
      return res
        .status(200)
        .set("Content-Type", "text/html; charset=utf-8")
        .send(html);
    } catch (error) {
      console.error("Error rendering hotspot login template:", error);
      return res.status(500).json({ success: false, message: "Failed to render hotspot login template." });
    }
  }

  async Packages(req, res) {
    const { platformID, hash } = req.body;
    let station = req.body?.station || req.query?.station || req.body?.host || req.query?.host || req.body?.routerHost || req.query?.routerHost;
    const stationId = req.body?.stationId || req.query?.stationId;

    if (!platformID) {
      return res.status(400).json({ type: "error", message: "Platform ID is required." });
    }

    try {
      let packages;
      const config = await this.db.getPlatformConfig(platformID);
      if (!station && stationId) {
        const stationRecord = await this.db.getStation(stationId);
        if (stationRecord?.platformID === platformID) {
          station = stationRecord.mikrotikHost;
        }
      }
      const host = this.resolveHotspotTemplateHost({ hash, station, config });
      if (host) {
        packages = await this.db.getPackagesByHost(platformID, host);
      } else {
        packages = await this.db.getPackages(platformID);
      }
      packages = Array.isArray(packages) ? packages : [];

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

    const auth = await this.auth.AuthenticateRequest(token);
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

    const auth = await this.auth.AuthenticateRequest(token);
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

    const auth = await this.auth.AuthenticateRequest(token);
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
    const { phone, platformID, host, packageID } = req.body;
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
        const formattedPhone = Utils.formatPhoneNumber(cleanphone);
        const localPhone = formattedPhone ? `0${formattedPhone.slice(3)}` : "";
        const phoneCandidates = [cleanphone, formattedPhone, localPhone].filter(Boolean);
        const mpesaPayments = await this.db.getCompletedHotspotPaymentsByLookup(
          platformID,
          cleanphone.toUpperCase(),
          phoneCandidates,
          host || null,
          packageID || null
        );
        if (mpesaPayments?.length > 0) {
          for (const payment of mpesaPayments) {
            const paidCode = String(payment?.mpesaReceiptNumber || payment?.code || "").trim();
            if (!paidCode || /^ws_CO_/i.test(paidCode) || !payment?.reason) continue;
            const existing = await this.db.getUserByCodeAndPlatform(paidCode, platformID);
            if (existing && existing.status === "active" && (!existing.expireAt || moment(existing.expireAt).isAfter(moment()))) {
              foundcodes.push(existing);
              continue;
            }
            const pkg = await this.db.getPackagesByID(payment.reason);
            if (!pkg) continue;
            const data = {
              phone: payment.phone,
              packageID: pkg.id,
              platformID: payment.platformID,
              package: pkg,
              routerHost: pkg.routerHost,
              code: paidCode,
              mac: "null",
              token: "null",
            };
            const addcodetorouter = await this.mikrotik.addManualCode(data);
            if (addcodetorouter?.success && addcodetorouter.code) {
              foundcodes.push(addcodetorouter.code);
            }
          }
        }
      }

      if (foundcodes.length === 0) {
        return res.json({ type: "error", message: "No completed hotspot payment or active session found." });
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
    const { token, name, url, platformID, adminID, email, password, role, phone, adminName, subscriptionPlan, trialDays, trialEndsAt, trialMode } = req.body;
    if (!token || !name || !url || !platformID || !adminID || !email || !password || !role) {
      return res.json({
        success: false,
        message: "Missing credentials are required!",
      });
    }
    const plan = this.normalizePlatformPlan(subscriptionPlan);
    const createdAt = new Date();
    const trial = this.parseFlexibleTrial({ plan, baseDate: createdAt, trialDays, trialEndsAt, trialMode });
    if (trial.error) {
      return res.status(400).json({
        success: false,
        message: trial.error,
      });
    }
    const resolvedTrialEndsAt = trial.value;
    const data = {
      name: name,
      url: url,
      platformID: platformID,
      adminID: adminID,
      subscriptionPlan: plan,
      trialEndsAt: resolvedTrialEndsAt,
    };
    try {
      const session = await this.authManagerSession(token);
      if (!session.success) {
        return res.json({
          success: false,
          message: session.message,
        });
      }
      const sanitizedUrl = this.sanitizeDomain(url);
      if (!sanitizedUrl) {
        return res.json({
          success: false,
          message: "Invalid platform URL. Use letters, numbers, dots, and hyphens only.",
        });
      }

      const check = await this.db.getPlatformByURLData(sanitizedUrl);
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

      const portalTarget = this.getSharedPortalTarget();
      const addProxy = await this.addReverseProxySite(sanitizedUrl, portalTarget);
      if (!addProxy.success) {
        return res.json({
          success: false,
          message: "Reverse proxy creation failed, try again.",
          error: addProxy.error
        });
      }

      const siteCheck = await this.verifyNginxSite(sanitizedUrl, portalTarget, {
        path: "/admin/login",
        rejectStatusCodes: ["404"],
      });
      if (!siteCheck.success) {
        return res.json({
          success: false,
          message: siteCheck.message || "Platform site did not become available.",
          error: siteCheck.error,
        });
      }

      const newSettings = await this.db.createPlatformConfig(platformID, {
        template: "Default",
        adminID: adminID
      })
      await this.db.createPlatformEmailTemplate({
        platformID: platformID,
        hotspotTemplate: "Default",
      });
      await this.db.createPlatformSMS({
        platformID: platformID,
        hotspotTemplate: "Default",
      })

      let dueDate = null;
      let totalAmount = this.getAccountPlan(plan).price;
      const serviceKey = "billing";
      const service = await this.db.getSystemServiceByKey(serviceKey);
      if (!service) {
        return res.status(500).json({
          success: false,
          message: "System service 'billing' is not configured.",
        });
      }
      const planPrice = this.getAccountPlan(plan).price;
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
          totalAmount = periodsPast * planPrice;
        }
      }
      if (this.isTrialLimitedPlan(plan)) {
        dueDate = resolvedTrialEndsAt;
        totalAmount = planPrice;
      }

      const subdata = {
        name: service?.name,
        platformID,
        amount: totalAmount.toString(),
        price: planPrice.toString(),
        currency: service?.currency,
        dueDate,
        status: "Unpaid",
        description: service?.description,
        meta: { serviceKey: "billing", plan },
      };

      await this.db.createPlatformBilling(subdata);

      data.url = sanitizedUrl;
      const add = await this.db.createPlatform(data);
      await this.db.upsertPlatformNotification(platformID, "Trial payment due", {
        message: `Your ${plan} plan includes trial access. Pay KES ${totalAmount} before ${resolvedTrialEndsAt ? resolvedTrialEndsAt.toLocaleDateString() : "the due date"} to keep your platform active.`,
        status: "info",
        actionLabel: "Pay Bill",
        actionUrl: "/admin/bills",
      });
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
      this.notifyNewPlatformCreatedSilently(
        { name, url: sanitizedUrl, platformID },
        { phone, name: adminName || name, email }
      );
      this.cache.del("main:platforms:all");

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
    const { token, platformID, name, status, subscriptionPlan, trialMode, trialDays, trialEndsAt } = req.body;
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
      if (subscriptionPlan !== undefined) {
        data.subscriptionPlan = this.normalizePlatformPlan(subscriptionPlan);
      }
      const plan = data.subscriptionPlan || this.normalizePlatformPlan(existing.subscriptionPlan);
      const trial = this.parseFlexibleTrial({
        plan,
        baseDate: new Date(),
        trialMode,
        trialDays,
        trialEndsAt,
        currentTrialEndsAt: existing.trialEndsAt,
      });
      if (trial.error) {
        return res.status(400).json({
          success: false,
          message: trial.error,
        });
      }
      if (trial.hasValue) {
        data.trialEndsAt = trial.value;
      }
      const upd = await this.db.updatePlatform(platformID, data);
      await this.ensurePlatformBillingService(platformID);
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

  async updateAccountPlan(req, res) {
    const { token, subscriptionPlan } = req.body;
    if (!token || !subscriptionPlan) {
      return res.json({
        success: false,
        message: "Missing credentials are required!",
      });
    }

    try {
      const auth = await this.auth.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({ success: false, message: auth.message });
      }
      if (auth.admin.role !== "superuser") {
        return res.json({ success: false, message: "Unauthorised!" });
      }

      const platformID = auth.admin.platformID;
      const existing = await this.db.getPlatformByplatformID(platformID);
      if (!existing) {
        return res.status(404).json({
          success: false,
          message: "Platform not found!",
        });
      }

      const plan = this.normalizePlatformPlan(subscriptionPlan);
      const requestedPlan = String(subscriptionPlan || "").trim().toLowerCase();
      if (requestedPlan !== "stater" && requestedPlan !== plan) {
        return res.json({ success: false, message: "Invalid account plan!" });
      }
      const data = { subscriptionPlan: plan };
      if (this.isTrialLimitedPlan(plan) && !existing.trialEndsAt) {
        data.trialEndsAt = this.addDays(existing.createdAt, 3);
      }

      await this.db.updatePlatform(platformID, data);
      const bill = await this.ensurePlatformBillingService(platformID);
      const migration = await this.queuePlanMigration(existing, plan, {
        requestedPlan,
        token,
      });
      await this.db.upsertPlatformNotification(platformID, "Account plan updated", {
        message: `Your account is now on the ${this.getAccountPlan(plan).name} plan.`,
        status: "success",
        actionLabel: "View Bill",
        actionUrl: "/admin/bills",
      });
      await this.enforcePlatformSubscription(platformID);
      const platform = await this.db.getPlatformByplatformID(platformID);

      return res.json({
        success: true,
        message: "Account plan updated successfully",
        platform,
        bill,
        migration,
      });
    } catch (error) {
      console.log("An error occured", error);
      return res.json({ success: false, message: "An error occured" });
    }
  };

  async registerPlatform(req, res) {
    const { name, email, password, phone, url, platformID, adminID, subscriptionPlan } = req.body;
    if (!name || !url || !email || !password || !platformID || !adminID) {
      return res.status(400).json({
        success: false,
        message: "All credentials are required!",
      });
    }

    const sanitizedUrl = this.sanitizeDomain(url);
    if (!sanitizedUrl) {
      return res.status(400).json({
        success: false,
        message: "Invalid platform URL. Use letters, numbers, dots, and hyphens only.",
      });
    }

    try {
      const checkplatform = await this.db.getPlatformByURLData(sanitizedUrl);
      if (checkplatform) {
        return res.status(409).json({
          success: false,
          message: "Platform name or URL already exists. Please choose another name.",
        });
      }
      const existingWebfigHost = await this.db.getStationByWebfigHost(sanitizedUrl);
      if (existingWebfigHost) {
        return res.status(409).json({
          success: false,
          message: "Platform URL conflicts with an existing Mikrotik Webfig host.",
        });
      }

      const user = await this.db.getAdminByEmail(email);
      if (user) {
        return res.status(409).json({
          success: false,
          message: "User with this email already exists!",
        });
      }

      const portalTarget = this.getSharedPortalTarget();
      const provision = await this.addReverseProxySite(sanitizedUrl, portalTarget);
      if (!provision.success) {
        return res.json({
          success: false,
          message: provision.message || "Reverse proxy provisioning failed, try again.",
          error: provision.error,
        });
      }

      const siteCheck = await this.verifyNginxSite(sanitizedUrl, portalTarget, {
        path: "/admin/login",
        rejectStatusCodes: ["404"],
      });
      if (!siteCheck.success) {
        return res.json({
          success: false,
          message: siteCheck.message || "Platform site did not become available.",
          error: siteCheck.error,
        });
      }

      const saltRounds = 10;
      const hashedPassword = await bcrypt.hash(password, saltRounds);
      const token = this.generateToken(adminID, platformID);
      await this.db.createAdmin({
        platformID,
        adminID,
        role: "superuser",
        email,
        phone,
        password: hashedPassword,
        name: name,
        token,
      });

      await this.db.createPlatformConfig(platformID, {
        template: "Default",
        adminID: adminID
      })
      await this.db.createPlatformEmailTemplate({
        platformID: platformID,
        hotspotTemplate: "Default",
      });
      await this.db.createPlatformSMS({
        platformID: platformID,
        hotspotTemplate: "Default",
      })

      const plan = this.normalizePlatformPlan(subscriptionPlan);
      const createdAt = new Date();
      const trialEndsAt = this.isTrialLimitedPlan(plan) ? this.addDays(createdAt, 3) : null;
      let dueDate = null;
      let totalAmount = this.getAccountPlan(plan).price;
      const serviceKey = "billing";
      const service = await this.db.getSystemServiceByKey(serviceKey);
      if (!service) {
        return res.status(500).json({
          success: false,
          message: "System service 'billing' is not configured.",
        });
      }
      const planPrice = this.getAccountPlan(plan).price;
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
          totalAmount = periodsPast * planPrice;
        }
      }
      if (this.isTrialLimitedPlan(plan)) {
        dueDate = trialEndsAt;
        totalAmount = planPrice;
      }

      const billingdata = {
        name: service?.name,
        platformID,
        amount: totalAmount.toString(),
        price: planPrice.toString(),
        currency: service?.currency,
        dueDate,
        status: "Unpaid",
        description: service?.description,
        meta: { serviceKey: "billing", plan },
      };

      await this.db.createPlatformBilling(billingdata);
      const newPlatform = await this.db.createPlatform({
        name,
        url: sanitizedUrl,
        platformID,
        adminID,
        subscriptionPlan: plan,
        trialEndsAt,
      });
      this.notifyNewPlatformCreatedSilently(
        { name, url: sanitizedUrl, platformID },
        { phone, name, email }
      );
      await this.db.upsertPlatformNotification(platformID, "Trial payment due", {
        message: `Your ${plan} plan includes 3 trial days. Pay KES ${totalAmount} before ${trialEndsAt ? trialEndsAt.toLocaleDateString() : "the due date"} to keep your platform active.`,
        status: "info",
        actionLabel: "Pay Bill",
        actionUrl: "/admin/bills",
      });
      await this.refreshDashboardStats(platformID);

      const subject = `Account created!`
      const message = `Your platform ${name} has been created. Login to your Admin dashboard at https://${sanitizedUrl}/admin/login.`;
      const data = {
        name: name,
        type: "accounts",
        email: email,
        subject: subject,
        message: message
      }
      const sendwithdrawalemail = await this.mailer.EmailTemplate(data);
      let emailWarning = null;
      if (!sendwithdrawalemail.success) {
        emailWarning = sendwithdrawalemail.message || "Welcome email could not be sent.";
        console.warn(`[Register] Platform ${platformID} created but welcome email failed:`, emailWarning);
      }
      const loginUrl = `https://${sanitizedUrl}/admin/login?tutorial=true`;

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
        platform: newPlatform,
        loginUrl,
        emailWarning,
      });

    } catch (error) {
      console.error("Registration error:", error);

      let errorMessage = "An error occurred during registration";
      let statusCode = 500;

      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === "P2002") {
          statusCode = 409;
          errorMessage = "A record with this value already exists.";
        } else {
          errorMessage = error.message;
        }
      } else if (error instanceof Prisma.PrismaClientValidationError) {
        statusCode = 400;
        errorMessage = error.message;
      } else if (error && error.response) {
        errorMessage = error.response.data?.errors?.map(err => err.message).join(", ") || errorMessage;
      } else if (error instanceof Error) {
        errorMessage = error.message;
      }

      return res.status(statusCode).json({
        success: false,
        message: errorMessage,
        error: errorMessage,
      });
    }
  };

  sanitizeDomain(domain) {
    const normalized = String(domain || "").trim().toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(normalized)) return null;
    if (normalized.includes("..") || normalized.includes("/") || normalized.startsWith(".") || normalized.endsWith(".")) return null;
    return normalized;
  }

  normalizeProxyTargetUrl(targetUrl) {
    const text = String(targetUrl || "").trim();
    if (!text) return null;
    try {
      const url = new URL(text);
      if (!["http:", "https:"].includes(url.protocol)) return null;
      url.hash = "";
      return url.toString().replace(/\/$/, "");
    } catch (_error) {
      return null;
    }
  }

  normalizeMikrotikInternalHost(host) {
    const normalized = String(host || "").trim().split("/")[0];
    if (!/^10\.10\.10\.(?:[1-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-4])$/.test(normalized)) return "";
    return normalized;
  }

  buildMikrotikWebfigTarget(host) {
    const internalHost = this.normalizeMikrotikInternalHost(host);
    return internalHost ? `http://${internalHost}` : null;
  }

  buildMikrotikWebfigTargets(host) {
    const primaryHost = this.normalizeMikrotikInternalHost(host);
    if (!primaryHost) return null;
    const targets = { primary: `http://${primaryHost}`, rescue: null };
    const rescueConfig = getMikrotikRescueConfig(primaryHost);
    if (rescueConfig?.enabled && rescueConfig.rescueAddress) {
      targets.rescue = `http://${rescueConfig.rescueAddress}`;
    }
    return targets;
  }

  getReverseProxyUpstreamName(domain) {
    const safe = String(domain || "proxy").replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 80) || "proxy";
    return `nova_${safe}`;
  }

  getProxyTargetServer(targetUrl) {
    try {
      const url = new URL(targetUrl);
      const port = url.port || (url.protocol === "https:" ? "443" : "80");
      return `${url.hostname}:${port}`;
    } catch (_error) {
      return "";
    }
  }

  generateMikrotikWebfigHost(name) {
    const prefix = String(name || "router")
      .toLowerCase()
      .replace(/[^a-z]/g, "")
      .slice(0, 12) || "router";
    const suffix = crypto.randomBytes(3).toString("hex");
    const baseDomain = process.env.DOMAIN || "novawifi.co.ke";
    return `${prefix}${suffix}.${baseDomain}`;
  }

  async verifyNginxSite(domain, targetUrl, options = {}) {
    const safeDomain = this.sanitizeDomain(domain);
    const target = this.normalizeProxyTargetUrl(targetUrl);
    if (!safeDomain || !target) {
      return { success: false, message: "Invalid nginx site verification input." };
    }
    const verifyPath = String(options.path || "/").startsWith("/")
      ? String(options.path || "/")
      : `/${String(options.path || "/")}`;
    const rejectStatusCodes = new Set(options.rejectStatusCodes || []);

    const availablePath = `/etc/nginx/sites-available/${safeDomain}`;
    const enabledPath = `/etc/nginx/sites-enabled/${safeDomain}`;
    const run = (cmd, args = []) => new Promise((resolve, reject) => {
      execFile(cmd, args, (error, stdout, stderr) => {
        if (error) return reject(new Error(String(stderr || error.message).trim()));
        resolve(String(stdout || "").trim());
      });
    });

    try {
      const [config, enabledTarget] = await Promise.all([
        fsp.readFile(availablePath, "utf8"),
        fsp.readlink(enabledPath),
      ]);
      const backupTargets = Array.isArray(options.backupTargets)
        ? options.backupTargets.map(item => this.normalizeProxyTargetUrl(item)).filter(Boolean).filter(item => item !== target)
        : [];
      const upstreamName = backupTargets.length ? this.getReverseProxyUpstreamName(safeDomain) : "";
      const proxyPassTarget = upstreamName ? `http://${upstreamName}` : target;

      if (!config.includes(`server_name ${safeDomain};`) || !config.includes(`proxy_pass ${proxyPassTarget};`)) {
        return { success: false, message: `Nginx mapping for ${safeDomain} does not match ${target}.` };
      }
      for (const backupTarget of backupTargets) {
        const backupServer = this.getProxyTargetServer(backupTarget);
        if (backupServer && !config.includes(`server ${backupServer} backup`)) {
          return { success: false, message: `Nginx backup mapping for ${safeDomain} does not include ${backupTarget}.` };
        }
      }
      if (path.resolve(path.dirname(enabledPath), enabledTarget) !== availablePath) {
        return { success: false, message: `Nginx enabled link for ${safeDomain} is incorrect.` };
      }

      await run("sudo", ["-n", "/usr/sbin/nginx", "-t"]);
      const serviceState = await run("sudo", ["-n", "/usr/bin/systemctl", "is-active", "nginx"]);
      if (serviceState !== "active") return { success: false, message: "Nginx is not active." };

      const { hasWildcardCert } = this.getWildcardCertificatePaths(safeDomain);
      const verifyScheme = hasWildcardCert ? "https" : "http";
      const verifyPort = hasWildcardCert ? "443" : "80";
      const responseBody = await run("/usr/bin/curl", [
        "-k", "-sS",
        "--max-time", "8",
        "--resolve", `${safeDomain}:${verifyPort}:127.0.0.1`,
        `${verifyScheme}://${safeDomain}${verifyPath}`,
      ]);
      const defaultNginxPage = /Welcome to nginx!/i.test(responseBody) && /Further configuration is required/i.test(responseBody);
      if (defaultNginxPage) {
        return { success: false, message: `Nginx site ${safeDomain} is still serving the default nginx page.` };
      }

      const httpCode = await run("/usr/bin/curl", [
        "-k", "-sS", "-o", "/dev/null", "-w", "%{http_code}",
        "--max-time", "8",
        "--resolve", `${safeDomain}:${verifyPort}:127.0.0.1`,
        `${verifyScheme}://${safeDomain}${verifyPath}`,
      ]);
      if (!/^\d{3}$/.test(httpCode) || httpCode === "000") {
        return { success: false, message: `Nginx site ${safeDomain} did not answer locally.` };
      }
      if (rejectStatusCodes.has(httpCode)) {
        return { success: false, message: `Nginx site ${safeDomain}${verifyPath} returned ${httpCode}.` };
      }
      return { success: true, domain: safeDomain, target, httpCode };
    } catch (error) {
      return {
        success: false,
        message: `Failed to verify nginx site ${safeDomain}.`,
        error: error?.message || String(error),
      };
    }
  }

  async ensureStationWebfigSite(station) {
    if (!station?.id) return { success: false, message: "Station is missing." };
    const targets = this.buildMikrotikWebfigTargets(station.mikrotikHost);
    const target = targets?.primary;
    if (!target) {
      return { success: false, message: "Station requires a valid 10.10.10.x internal host." };
    }

    let domain = this.sanitizeDomain(station.mikrotikWebfigHost);
    if (!domain) {
      domain = this.generateMikrotikWebfigHost(station.name);
      await this.db.updateStation(station.id, { mikrotikWebfigHost: domain });
      station.mikrotikWebfigHost = domain;
    }

    const proxyOptions = targets.rescue ? { backupTargets: [targets.rescue] } : {};
    const provision = await this.addReverseProxySite(domain, target, proxyOptions);
    if (!provision?.success) return provision;
    const verification = await this.verifyNginxSite(domain, target, proxyOptions);
    if (!verification.success) return verification;
    return {
      success: true,
      message: `WebFig nginx site verified for ${domain}`,
      domain,
      target,
      backupTarget: targets.rescue,
      httpCode: verification.httpCode,
    };
  }

  getWildcardCertificatePaths(domain) {
    const baseDomain = process.env.DOMAIN || "novawifi.co.ke";
    const certDir = process.env.WILDCARD_CERT_DIR || `/etc/letsencrypt/live/${baseDomain}`;
    const certPath = process.env.WILDCARD_CERT_PATH || `${certDir}/fullchain.pem`;
    const keyPath = process.env.WILDCARD_KEY_PATH || `${certDir}/privkey.pem`;
    const isBaseDomainSubdomain = domain.endsWith(`.${baseDomain}`) || domain === baseDomain;
    const hasConfiguredCertificate = Boolean(certPath && keyPath);
    return {
      baseDomain,
      certPath,
      keyPath,
      hasWildcardCert: isBaseDomainSubdomain && hasConfiguredCertificate,
    };
  }

  buildNginxConfig(domain, targetUrl, options = {}) {
    const target = this.normalizeProxyTargetUrl(targetUrl);
    if (!target) return null;
    const { certPath, keyPath, hasWildcardCert } = this.getWildcardCertificatePaths(domain);
    const optionsSslPath = "/etc/letsencrypt/options-ssl-nginx.conf";
    const dhParamPath = "/etc/letsencrypt/ssl-dhparams.pem";
    const backupTargets = Array.isArray(options.backupTargets)
      ? options.backupTargets.map(item => this.normalizeProxyTargetUrl(item)).filter(Boolean).filter(item => item !== target)
      : [];
    const upstreamName = backupTargets.length ? this.getReverseProxyUpstreamName(domain) : "";
    const proxyPassTarget = upstreamName ? `http://${upstreamName}` : target;
    const upstreamLines = upstreamName
      ? [
        `upstream ${upstreamName} {`,
        `    server ${this.getProxyTargetServer(target)} max_fails=1 fail_timeout=3s;`,
        ...backupTargets
          .map(item => this.getProxyTargetServer(item))
          .filter(Boolean)
          .map(server => `    server ${server} backup max_fails=1 fail_timeout=3s;`),
        "}",
        "",
      ]
      : [];

    const proxyLines = [
      "    location / {",
      `        proxy_pass ${proxyPassTarget};`,
      "        proxy_http_version 1.1;",
      ...(upstreamName ? [
        "        proxy_next_upstream error timeout http_502 http_503 http_504;",
        "        proxy_connect_timeout 3s;",
        "        proxy_send_timeout 30s;",
        "        proxy_read_timeout 30s;",
      ] : []),
      "",
      "        proxy_set_header Host $host;",
      "        proxy_set_header X-Real-IP $remote_addr;",
      "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
      "        proxy_set_header X-Forwarded-Proto $scheme;",
      "",
      "        proxy_set_header Upgrade $http_upgrade;",
      "        proxy_set_header Connection \"upgrade\";",
      "    }",
      "",
    ];

    if (!hasWildcardCert) {
      return [
        ...upstreamLines,
        "server {",
        "    listen 80;",
        `    server_name ${domain};`,
        "",
        ...proxyLines,
        "}",
        "",
      ].join("\n");
    }

    return [
      ...upstreamLines,
      "server {",
      "    listen 80;",
      `    server_name ${domain};`,
      "    return 301 https://$host$request_uri;",
      "}",
      "",
      "server {",
      "    listen 443 ssl;",
      `    server_name ${domain};`,
      "",
      `    ssl_certificate ${certPath};`,
      `    ssl_certificate_key ${keyPath};`,
      ...(fs.existsSync(optionsSslPath) ? [`    include ${optionsSslPath};`] : []),
      ...(fs.existsSync(dhParamPath) ? [`    ssl_dhparam ${dhParamPath};`] : []),
      "",
      ...proxyLines,
      "}",
      "",
    ].join("\n");
  }

  async addReverseProxySite(domain, targetUrl, options = {}) {
    const safeDomain = this.sanitizeDomain(domain);
    if (!safeDomain) {
      return { success: false, message: "Invalid domain provided." };
    }

    const target = this.normalizeProxyTargetUrl(targetUrl);
    if (!target) {
      return { success: false, message: "Invalid reverse proxy target URL." };
    }

    const config = this.buildNginxConfig(safeDomain, target, options);
    if (!config) {
      return {
        success: false,
        message: "Failed to build nginx config.",
      };
    }
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

      let ssl = { success: true, message: "Using wildcard SSL certificate." };
      const { hasWildcardCert } = this.getWildcardCertificatePaths(safeDomain);
      if (!hasWildcardCert && process.env.SKIP_LETSENCRYPT !== "true") {
        ssl = await this.installLetsEncryptCert(safeDomain);
        if (!ssl.success) {
          return {
            success: false,
            message: `Nginx configured for ${safeDomain}, but Let's Encrypt SSL failed.`,
            error: ssl.error || ssl.message,
          };
        }
      }

      return {
        success: true,
        message: `Nginx reverse proxy configured for ${safeDomain}`,
        ssl,
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
    const auth = await this.auth.AuthenticateRequest(token);
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
      const auth = await this.auth.AuthenticateRequest(token);
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

      const platform = await this.db.getPlatform(platformID);
      if (!platform) {
        return res.json({
          success: false,
          message: "Platform not found!",
        });
      }
      await this.enforcePlatformSubscription(platformID);
      const bills = await this.db.getPlatformBilling(platformID);
      const response = {
        success: true,
        message: `Bills fetched successfully!`,
        bills,
      };
      return res.json(response);
    } catch (error) {
      console.error("Billing error:", error);
      return res.json({
        success: false,
        message: "An error occurred when creating bills!",
      });
    }
  };

  runHealthCommand(command) {
    return new Promise((resolve) => {
      exec(command, { timeout: 2500 }, (error, stdout) => {
        if (error) return resolve("unknown");
        resolve(String(stdout || "").trim() || "unknown");
      });
    });
  }

  async runFirstHealthCommand(commands) {
    for (const command of commands) {
      const status = await this.runHealthCommand(command);
      if (status !== "unknown") return status;
    }
    return "unknown";
  }

  getRestartableServerServices() {
    return {
      nginx: {
        label: "Nginx",
        candidates: [process.env.NGINX_SERVICE_NAME || "nginx"],
      },
      radius: {
        label: "Radius",
        candidates: [process.env.RADIUS_SERVICE_NAME || "freeradius", "radiusd"],
      },
      postgres: {
        label: "Postgres",
        candidates: [process.env.POSTGRES_SERVICE_NAME || "postgresql", "postgres"],
      },
    };
  }

  runSystemctl(action, service) {
    return new Promise((resolve) => {
      if (!/^[a-zA-Z0-9@_.-]+$/.test(service)) {
        resolve({ success: false, message: "Invalid service name" });
        return;
      }
      execFile("systemctl", [action, service], { timeout: 15000 }, (error, stdout, stderr) => {
        if (error) {
          resolve({
            success: false,
            message: String(stderr || stdout || error.message || "Command failed").trim(),
          });
          return;
        }
        resolve({ success: true, message: String(stdout || "").trim() });
      });
    });
  }

  async buildPortalHealth() {
    const [nginxStatus, radiusStatus, postgresStatus] = await Promise.all([
      this.runFirstHealthCommand(["systemctl is-active nginx"]),
      this.runFirstHealthCommand(["systemctl is-active freeradius", "systemctl is-active radiusd"]),
      this.runFirstHealthCommand(["systemctl is-active postgresql", "systemctl is-active postgres"]),
    ]);
    const load = os.loadavg();
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;
    return {
      portal: "online",
      api: "online",
      database: this.db ? "online" : "unknown",
      nginx: nginxStatus,
      radius: radiusStatus,
      postgres: postgresStatus,
      uptimeSeconds: Math.floor(process.uptime()),
      serverUptimeSeconds: Math.floor(os.uptime()),
      cpuLoad: load.map((value) => Number(value.toFixed(2))),
      memory: {
        total: totalMemory,
        used: usedMemory,
        free: freeMemory,
        usedPercent: totalMemory ? Number(((usedMemory / totalMemory) * 100).toFixed(1)) : 0,
      },
      node: process.version,
      checkedAt: new Date().toISOString(),
    };
  }

  sanitizeServerDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  async getDedicatedServerAuth(token) {
    const auth = await this.auth.AuthenticateRequest(token);
    if (!auth.success || !auth.admin) return { success: false, message: auth.message || "Unauthorised!" };
    if (auth.admin.role !== "superuser") return { success: false, message: "Unauthorised!" };
    const platformID = auth.admin.platformID;
    const platform = await this.db.getPlatformByplatformID(platformID);
    if (!platform) return { success: false, message: "Platform not found!" };
    return { success: true, auth, platform, platformID };
  }

  async createDedicatedServerForPlatform(platformID, options = {}) {
    const platform = await this.db.getPlatformByplatformID(platformID);
    if (!platform) return { success: false, message: "Platform not found!" };
    if (this.normalizePlatformPlan(platform.subscriptionPlan) !== "professional") {
      return { success: false, message: "Professional plan required" };
    }

    const existing = await this.db.getPlatformServer(platformID);
    if (existing?.webdockSlug && !["deleted", "delete_failed"].includes(String(existing.webdockStatus || "").toLowerCase())) {
      return { success: true, message: "Server already exists", server: existing };
    }

    const resources = {
      platform: process.env.WEBDOCK_PLATFORM || this.webdock.defaultPlatform,
      cpuThreads: Number(options.cpuThreads || this.webdock.defaultCpuThreads),
      ramGb: Number(options.ramGb || this.webdock.defaultRamGb),
      diskGb: Number(options.diskGb || this.webdock.defaultDiskGb),
      networkBandwidth: Number(options.networkBandwidth || this.webdock.defaultNetworkBandwidth),
    };

    const profile = await this.webdock.createCustomProfile(resources);
    const profileSlug = profile?.data?.slug;
    if (!profileSlug) throw new Error("Webdock did not return a profile slug");

    const suggestedSlug = this.webdock.makeSlug(platformID);
    const userScriptId = process.env.WEBDOCK_PROVISION_SCRIPT_ID || undefined;
    const provision = await this.webdock.provisionServer({
      name: `${platform.name || "Nova"} Dedicated`,
      slug: suggestedSlug,
      profileSlug,
      imageSlug: process.env.WEBDOCK_IMAGE_SLUG || this.webdock.defaultImageSlug,
      locationId: process.env.WEBDOCK_LOCATION_ID || this.webdock.defaultLocationId,
      userScriptId,
    });

    const normalized = this.webdock.normalizeServer(provision.data);
    const server = await this.db.upsertPlatformServer(platformID, {
      provider: "webdock",
      ...resources,
      ...this.webdock.defaultServerDetails(platformID, platform),
      ...normalized,
      webdockSlug: normalized.webdockSlug || suggestedSlug,
      webdockStatus: normalized.webdockStatus || "provisioning",
      locationId: process.env.WEBDOCK_LOCATION_ID || this.webdock.defaultLocationId,
      imageSlug: process.env.WEBDOCK_IMAGE_SLUG || this.webdock.defaultImageSlug,
      profileSlug,
      customProfileSlug: profileSlug,
      providerData: provision.data,
      renewsAt: this.addDays(new Date(), 30),
      expiresAt: this.addDays(new Date(), 30),
    });

    await this.db.createDedicatedServerAction({
      platformID,
      serverSlug: server.webdockSlug,
      type: "provision",
      status: provision.callbackId ? "pending" : "processing",
      callbackId: provision.callbackId,
      request: { resources, profileSlug, userScriptId },
      response: { server: provision.data, callbackSequence: provision.callbackSequence },
    });

    await this.db.upsertPlatformNotification(platformID, "Dedicated server provisioning", {
      message: "Your dedicated server provisioning has started.",
      status: "info",
      actionLabel: "View Server",
      actionUrl: "/admin/server",
    });

    return { success: true, message: "Provisioning started", server };
  }

  getSharedPortalTarget() {
    return process.env.SHARED_PORTAL_TARGET || "http://127.0.0.1:3001";
  }

  getDedicatedPortalTarget(server) {
    const port = process.env.DEDICATED_PORTAL_PORT || "3001";
    const ipAddress = server?.ipAddress || server?.providerData?.ip || server?.providerData?.ipv4 || "";
    if (!ipAddress) return "";
    return `http://${ipAddress}:${port}`;
  }

  isDedicatedPlan(plan) {
    return this.normalizePlatformPlan(plan) === "professional";
  }

  getMigrationDirection(sourcePlan, targetPlan) {
    const fromDedicated = this.isDedicatedPlan(sourcePlan);
    const toDedicated = this.isDedicatedPlan(targetPlan);
    if (fromDedicated && !toDedicated) return "dedicated_to_shared";
    if (!fromDedicated && toDedicated) return "shared_to_dedicated";
    return null;
  }

  async queuePlanMigration(platform, targetPlan, meta = {}) {
    const sourcePlan = this.normalizePlatformPlan(platform?.subscriptionPlan);
    const normalizedTarget = this.normalizePlatformPlan(targetPlan);
    const direction = this.getMigrationDirection(sourcePlan, normalizedTarget);
    if (!direction) return null;

    const existing = await this.db.getLatestPlatformMigration(platform.platformID, ["pending", "running"]);
    if (existing) return existing;

    const server = await this.db.getPlatformServer(platform.platformID);
    const domain = this.sanitizeDomain(platform.domain || platform.url);
    const sourceTarget = direction === "dedicated_to_shared"
      ? this.getDedicatedPortalTarget(server)
      : this.getSharedPortalTarget();
    const destinationTarget = direction === "dedicated_to_shared"
      ? this.getSharedPortalTarget()
      : this.getDedicatedPortalTarget(server);

    const migration = await this.db.createPlatformMigration({
      platformID: platform.platformID,
      direction,
      status: destinationTarget ? "pending" : "blocked",
      domain,
      requestedPlan: meta.requestedPlan || normalizedTarget,
      sourcePlan,
      targetPlan: normalizedTarget,
      sourceServerSlug: direction === "dedicated_to_shared" ? server?.webdockSlug || null : null,
      destinationServerSlug: direction === "shared_to_dedicated" ? server?.webdockSlug || null : null,
      sourceTarget,
      destinationTarget,
      request: {
        reason: "plan_change",
        webdockApi: this.webdock.baseURL,
      },
      error: destinationTarget ? null : "Dedicated server IP is not ready yet.",
    });

    await this.db.upsertPlatformNotification(platform.platformID, "Platform migration queued", {
      message: direction === "dedicated_to_shared"
        ? "Downgrade queued. Platform records will remain on shared hosting and the portal domain will point back to the main API."
        : "Dedicated migration queued. Provision the dedicated server, then complete migration after the server IP is ready.",
      status: destinationTarget ? "info" : "warning",
      actionLabel: "View Server",
      actionUrl: "/admin/server",
    });

    return migration;
  }

  async runPlatformMigration(platformID, migrationId) {
    const migration = await this.db.getPlatformMigration(migrationId, platformID);
    if (!migration) return { success: false, message: "Migration not found" };
    if (["completed", "running"].includes(String(migration.status || "").toLowerCase())) {
      return { success: true, message: "Migration already handled", migration };
    }

    const platform = await this.db.getPlatformByplatformID(platformID);
    if (!platform) return { success: false, message: "Platform not found" };

    const server = await this.db.getPlatformServer(platformID);
    const destinationTarget = migration.direction === "dedicated_to_shared"
      ? this.getSharedPortalTarget()
      : this.getDedicatedPortalTarget(server);
    if (!destinationTarget) {
      const updated = await this.db.updatePlatformMigration(migration.id, {
        status: "blocked",
        error: "Dedicated server IP is not ready yet.",
      });
      return { success: false, message: "Dedicated server IP is not ready yet.", migration: updated };
    }

    await this.db.updatePlatformMigration(migration.id, {
      status: "running",
      startedAt: migration.startedAt || new Date(),
      destinationTarget,
      destinationServerSlug: migration.direction === "shared_to_dedicated" ? server?.webdockSlug || null : migration.destinationServerSlug,
    });

    try {
      const records = await this.db.getPlatformRecordCounts(platformID);
      const domain = this.sanitizeDomain(migration.domain || platform.domain || platform.url);
      let proxy = null;
      if (domain) {
        proxy = await this.addReverseProxySite(domain, destinationTarget);
        if (!proxy.success) throw new Error(proxy.message || "Reverse proxy update failed");
      }

      const completed = await this.db.updatePlatformMigration(migration.id, {
        status: "completed",
        completedAt: new Date(),
        records,
        response: {
          proxy,
          destinationTarget,
          webdockApi: this.webdock.baseURL,
        },
        error: null,
      });

      await this.db.upsertPlatformNotification(platformID, "Platform migration completed", {
        message: migration.direction === "dedicated_to_shared"
          ? "Portal domain now points to shared hosting."
          : "Portal domain now points to the dedicated server.",
        status: "success",
        actionLabel: "View Server",
        actionUrl: "/admin/server",
      });

      return { success: true, message: "Migration completed", migration: completed };
    } catch (error) {
      const failed = await this.db.updatePlatformMigration(migration.id, {
        status: "failed",
        error: error?.message || "Migration failed",
      });
      await this.db.upsertPlatformNotification(platformID, "Platform migration failed", {
        message: error?.message || "Migration failed.",
        status: "error",
        actionLabel: "View Server",
        actionUrl: "/admin/server",
      });
      return { success: false, message: error?.message || "Migration failed", migration: failed };
    }
  }

  async migratePlatformHosting(req, res) {
    const { token, migrationId } = req.body;
    if (!token) return res.json({ success: false, message: "Missing credentials required!" });
    try {
      const access = await this.getDedicatedServerAuth(token);
      if (!access.success) return res.json({ success: false, message: access.message });
      const migration = migrationId
        ? await this.db.getPlatformMigration(migrationId, access.platformID)
        : await this.db.getLatestPlatformMigration(access.platformID, ["pending", "blocked", "failed"]);
      if (!migration) return res.json({ success: false, message: "No migration is queued" });
      const result = await this.runPlatformMigration(access.platformID, migration.id);
      return res.json(result);
    } catch (error) {
      console.error("Platform migration error:", error);
      return res.json({ success: false, message: error?.message || "Migration failed" });
    }
  }

  async fetchPlatformMigrations(req, res) {
    const { token } = req.body;
    if (!token) return res.json({ success: false, message: "Missing credentials required!" });
    try {
      const access = await this.getDedicatedServerAuth(token);
      if (!access.success) return res.json({ success: false, message: access.message });
      const migrations = await this.db.getPlatformMigrations(access.platformID);
      return res.json({ success: true, migrations });
    } catch (error) {
      console.error("Fetch platform migrations error:", error);
      return res.json({ success: false, message: "Failed to fetch migrations" });
    }
  }

  async provisionDedicatedServer(req, res) {
    const { token } = req.body;
    if (!token) return res.json({ success: false, message: "Missing credentials required!" });
    try {
      const access = await this.getDedicatedServerAuth(token);
      if (!access.success) return res.json({ success: false, message: access.message });
      if (this.normalizePlatformPlan(access.platform.subscriptionPlan) !== "professional") {
        return res.json({ success: false, message: "Professional plan required" });
      }
      const unpaid = await this.getUnpaidPlatformBilling(access.platformID);
      const hasOverdue = unpaid.some((bill) => Number(bill.amount || 0) > 0 && bill.dueDate && new Date(bill.dueDate).getTime() < Date.now());
      if (hasOverdue && !this.isPremiumPlatform(access.platform)) {
        return res.json({ success: false, message: "Settle overdue bills before provisioning." });
      }
      const result = await this.createDedicatedServerForPlatform(access.platformID);
      return res.json(result);
    } catch (error) {
      console.error("Dedicated server provision error:", error);
      return res.json({ success: false, message: error?.message || "Failed to provision server" });
    }
  }

  async rebootDedicatedServer(req, res) {
    const { token } = req.body;
    if (!token) return res.json({ success: false, message: "Missing credentials required!" });
    try {
      const access = await this.getDedicatedServerAuth(token);
      if (!access.success) return res.json({ success: false, message: access.message });
      const server = await this.db.getPlatformServer(access.platformID);
      if (!server?.webdockSlug) return res.json({ success: false, message: "Server is not provisioned yet" });
      const response = await this.webdock.rebootServer(server.webdockSlug);
      await this.db.createDedicatedServerAction({
        platformID: access.platformID,
        serverSlug: server.webdockSlug,
        type: "reboot",
        status: response.callbackId ? "pending" : "processing",
        callbackId: response.callbackId,
        response: { callbackSequence: response.callbackSequence },
      });
      await this.db.upsertPlatformNotification(access.platformID, "Dedicated server reboot", {
        message: "Server reboot has been queued.",
        status: "info",
        actionLabel: "View Server",
        actionUrl: "/admin/server",
      });
      return res.json({ success: true, message: "Server reboot queued" });
    } catch (error) {
      console.error("Dedicated server reboot error:", error);
      return res.json({ success: false, message: "Failed to reboot server" });
    }
  }

  async deleteDedicatedServer(req, res) {
    const { token } = req.body;
    if (!token) return res.json({ success: false, message: "Missing credentials required!" });
    try {
      const access = await this.getDedicatedServerAuth(token);
      if (!access.success) return res.json({ success: false, message: access.message });
      const server = await this.db.getPlatformServer(access.platformID);
      if (!server?.webdockSlug) return res.json({ success: false, message: "Server is not provisioned yet" });
      const response = await this.webdock.deleteServer(server.webdockSlug);
      await this.db.upsertPlatformServer(access.platformID, {
        webdockStatus: "deleting",
        pendingDeletionAt: new Date(),
      });
      await this.db.createDedicatedServerAction({
        platformID: access.platformID,
        serverSlug: server.webdockSlug,
        type: "delete",
        status: response.callbackId ? "pending" : "processing",
        callbackId: response.callbackId,
        response: { callbackSequence: response.callbackSequence },
      });
      await this.db.upsertPlatformNotification(access.platformID, "Dedicated server deletion", {
        message: "Server deletion has been queued.",
        status: "warning",
        actionLabel: "View Server",
        actionUrl: "/admin/server",
      });
      return res.json({ success: true, message: "Server deletion queued" });
    } catch (error) {
      console.error("Dedicated server delete error:", error);
      return res.json({ success: false, message: "Failed to delete server" });
    }
  }

  async previewDedicatedServerResize(req, res) {
    const { token, resources } = req.body;
    if (!token || !resources) return res.json({ success: false, message: "Missing credentials required!" });
    try {
      const access = await this.getDedicatedServerAuth(token);
      if (!access.success) return res.json({ success: false, message: access.message });
      const server = await this.db.getPlatformServer(access.platformID);
      if (!server?.webdockSlug) return res.json({ success: false, message: "Server is not provisioned yet" });
      const price = this.calculateDedicatedServerPrice(server, resources);
      return res.json({ success: true, resources: price.resources, price });
    } catch (error) {
      console.error("Dedicated server resize preview error:", error);
      return res.json({ success: false, message: "Failed to preview resize" });
    }
  }

  async resizeDedicatedServer(req, res) {
    const { token, resources } = req.body;
    if (!token || !resources) return res.json({ success: false, message: "Missing credentials required!" });
    try {
      const access = await this.getDedicatedServerAuth(token);
      if (!access.success) return res.json({ success: false, message: access.message });
      const server = await this.db.getPlatformServer(access.platformID);
      if (!server?.webdockSlug) return res.json({ success: false, message: "Server is not provisioned yet" });

      const price = this.calculateDedicatedServerPrice(server, resources);
      if (price.additionalMonthlyKes <= 0) {
        return res.json({ success: false, message: "Choose resources above your current allocation." });
      }

      const bill = await this.db.createPlatformBilling({
        name: "Dedicated server resources",
        platformID: access.platformID,
        amount: String(price.additionalMonthlyKes),
        price: String(price.additionalMonthlyKes),
        currency: "KES",
        status: "Unpaid",
        dueDate: new Date(),
        description: `Dedicated server resource upgrade to ${price.resources.cpuThreads} CPU threads, ${price.resources.ramGb}GB RAM, ${price.resources.diskGb}GB disk.`,
        meta: {
          serviceKey: "dedicated-server-resize",
          resources: price.resources,
          serverSlug: server.webdockSlug,
        },
      });

      await this.db.createDedicatedServerAction({
        platformID: access.platformID,
        serverSlug: server.webdockSlug,
        type: "resize",
        status: "awaiting_payment",
        billID: bill.id,
        request: { resources: price.resources, price },
      });

      await this.db.upsertPlatformNotification(access.platformID, "Dedicated resource upgrade payment", {
        message: `Pay KES ${price.additionalMonthlyKes} to apply the dedicated server resource upgrade.`,
        status: "info",
        actionLabel: "Pay Bill",
        actionUrl: "/admin/bills",
      });

      return res.json({ success: true, message: "Resource upgrade bill created", bill, price });
    } catch (error) {
      console.error("Dedicated server resize error:", error);
      return res.json({ success: false, message: "Failed to create resource upgrade" });
    }
  }

  async fetchDedicatedServer(req, res) {
    const { token } = req.body;
    if (!token) return res.json({ success: false, message: "Missing credentials required!" });
    try {
      const auth = await this.auth.AuthenticateRequest(token);
      if (!auth.success || !auth.admin) return res.json({ success: false, message: auth.message });
      if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });

      const platformID = auth.admin.platformID;
      const [platform, server, health, migrations] = await Promise.all([
        this.db.getPlatformByplatformID(platformID),
        this.db.getPlatformServer(platformID),
        this.buildPortalHealth(),
        this.db.getPlatformMigrations(platformID),
      ]);

      let liveServer = server;
      let providerHealth = null;
      if (server?.webdockSlug && this.webdock.token) {
        try {
          const [webdockServer, instantMetrics, metrics] = await Promise.all([
            this.webdock.getServer(server.webdockSlug),
            this.webdock.getInstantMetrics(server.webdockSlug),
            this.webdock.getMetrics(server.webdockSlug),
          ]);
          const normalized = this.webdock.normalizeServer(webdockServer.data);
          providerHealth = this.webdock.normalizeInstantMetrics(instantMetrics.data, webdockServer.data);
          liveServer = await this.db.upsertPlatformServer(platformID, {
            ...normalized,
            instantMetrics: providerHealth,
            metrics: metrics.data,
            lastSyncedAt: new Date(),
          });
        } catch (err) {
          console.error("Webdock server sync failed:", err?.message || err);
        }
      }

      return res.json({
        success: true,
        platform,
        server: liveServer,
        health: {
          dedicated: {
            status: liveServer?.webdockStatus || "not provisioned",
            ssh: liveServer?.sshStatus || "not ready",
            nginx: liveServer?.nginxStatus || "unknown",
            database: liveServer?.databaseName ? "configured" : "not configured",
            checkedAt: new Date().toISOString(),
          },
          webdock: providerHealth,
          sharedPortal: health,
        },
        pricing: this.getDedicatedServerPricing(),
        webdockConfigured: this.webdock.isConfigured(),
        migrations,
      });
    } catch (error) {
      console.error("Dedicated server fetch error:", error);
      return res.json({ success: false, message: "Failed to fetch server details" });
    }
  }

  async updateDedicatedServer(req, res) {
    const { token, data } = req.body;
    if (!token || !data) return res.json({ success: false, message: "Missing credentials required!" });
    try {
      const auth = await this.auth.AuthenticateRequest(token);
      if (!auth.success || !auth.admin) return res.json({ success: false, message: auth.message });
      if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });

      const payload = {
        notes: String(data.notes || ""),
      };

      const server = await this.db.upsertPlatformServer(auth.admin.platformID, payload);
      return res.json({ success: true, message: "Server details saved", server });
    } catch (error) {
      console.error("Dedicated server update error:", error);
      return res.json({ success: false, message: "Failed to save server details" });
    }
  }

  async restartDedicatedServerService(req, res) {
    const { token, service } = req.body;
    if (!token || !service) return res.json({ success: false, message: "Missing credentials required!" });
    try {
      const auth = await this.auth.AuthenticateRequest(token);
      if (!auth.success || !auth.admin) return res.json({ success: false, message: auth.message });
      if (auth.admin.role !== "superuser") return res.json({ success: false, message: "Unauthorised!" });

      const platform = await this.db.getPlatformByplatformID(auth.admin.platformID);
      if (String(platform?.subscriptionPlan || "").toLowerCase() !== "professional") {
        return res.json({ success: false, message: "Dedicated server plan not active" });
      }
      return res.json({
        success: false,
        message: "Dedicated server remote service restart is not configured yet.",
      });
    } catch (error) {
      console.error("Dedicated server service restart error:", error);
      return res.json({ success: false, message: "Failed to restart service" });
    }
  }

  async fetchFunds(req, res) {
    const { token } = req.body;

    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const auth = await this.auth.AuthenticateRequest(token);
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

  async managerUpsertPlatformFunds(req, res) {
    const { token, platformID, funds } = req.body || {};
    if (!token || !platformID) {
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

      const platform = await this.db.getPlatform(platformID);
      if (!platform) {
        return res.status(404).json({
          success: false,
          message: "Platform not found!",
        });
      }

      const normalized = this.normalizeFundsPayload(funds || req.body);
      if (normalized.error) {
        return res.status(400).json({
          success: false,
          message: normalized.error,
        });
      }

      const update = await this.db.upsertFunds(platformID, normalized.data);
      if (!update) {
        return res.status(500).json({
          success: false,
          message: "Unable to update funds.",
        });
      }

      this.cache.del(`main:funds:${platformID}`);
      this.cache.del("main:platforms:all");

      return res.json({
        success: true,
        message: "Platform funds updated successfully.",
        funds: update,
      });
    } catch (err) {
      console.error("An error occured", err);
      return res.json({
        success: false,
        message: "An internal error occured, try again.",
      });
    }
  }

  async managerDeletePlatformFunds(req, res) {
    const { token, platformID } = req.body || {};
    if (!token || !platformID) {
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

      const platform = await this.db.getPlatform(platformID);
      if (!platform) {
        return res.status(404).json({
          success: false,
          message: "Platform not found!",
        });
      }

      await this.db.deleteFunds(platformID);
      this.cache.del(`main:funds:${platformID}`);
      this.cache.del("main:platforms:all");

      return res.json({
        success: true,
        message: "Platform funds deleted successfully.",
      });
    } catch (err) {
      console.error("An error occured", err);
      return res.json({
        success: false,
        message: "An internal error occured, try again.",
      });
    }
  }

  async fetchSessions(req, res) {
    const { token, adminID } = req.body;

    if (!token) {
      return res.json({
        success: false,
        message: "Missing credentials required!",
      });
    }

    try {
      const auth = await this.auth.AuthenticateRequest(token);
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
      const auth = await this.auth.AuthenticateRequest(token);
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

      const auth = await this.auth.AuthenticateRequest(token);
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

      const auth = await this.auth.AuthenticateRequest(token);
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

      const auth = await this.auth.AuthenticateRequest(token);
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

      const auth = await this.auth.AuthenticateRequest(token);
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

      const auth = await this.auth.AuthenticateRequest(token);
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
      const auth = await this.auth.AuthenticateRequest(token);
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

      const auth = await this.auth.AuthenticateRequest(token);
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

    const auth = await this.auth.AuthenticateRequest(token);
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
      const auth = await this.auth.AuthenticateRequest(token);
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
      const auth = await this.auth.AuthenticateRequest(token);
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
    const { token, stationId, file, filename } = req.body || {};
    if (!token || !stationId || !file) {
      return res.json({ success: false, message: "Missing credentials required!" });
    }

    try {
      const auth = await this.auth.AuthenticateRequest(token);
      if (!auth.success) {
        return res.json({ success: false, message: auth.message });
      }
      if (auth.admin?.role !== "superuser") {
        return res.json({ success: false, message: "Unauthorised!" });
      }

      const platformID = auth.admin.platformID;
      if (!platformID) {
        return res.json({ success: false, message: "Missing platform ID" });
      }
      const station = await this.db.getStation(stationId);
      if (!station || station.platformID !== platformID) {
        return res.json({ success: false, message: "Station not found." });
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
      const finalName = `${safeNameBase}-${platformID}-${stationId}-${Date.now()}.${ext}`;
      const finalPath = path.join(folderPath, finalName);
      fs.writeFileSync(finalPath, Buffer.from(base64Data, "base64"));

      const imageUrl = `/branding-logos/${finalName}`;
      const proto = (req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
      const host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
      const absoluteUrl = host ? `${proto}://${host}${imageUrl}` : imageUrl;
      await this.db.updateStation(stationId, { brandingImage: imageUrl });
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
      const auth = await this.auth.AuthenticateRequest(token);
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
      const auth = await this.auth.AuthenticateRequest(token);
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
      const auth = await this.auth.AuthenticateRequest(token);
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
      const auth = await this.auth.AuthenticateRequest(token);
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
      const auth = await this.auth.AuthenticateRequest(token);
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
      const auth = await this.auth.AuthenticateRequest(token);
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
      const auth = await this.auth.AuthenticateRequest(token);
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
      const auth = await this.auth.AuthenticateRequest(token);
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
      const auth = await this.auth.AuthenticateRequest(token);
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
      const auth = await this.auth.AuthenticateRequest(token);
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

    const auth = await this.auth.AuthenticateRequest(token);
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

    const auth = await this.auth.AuthenticateRequest(token);
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

    const auth = await this.auth.AuthenticateRequest(token);
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

    const htmlContent = await this.buildOfflineBoxLoginHtml(platformID, {
      host: config.mikrotikHost,
      req,
    });

    const basePath = path.join(appRoot, "backups", `login-${platformID}.html`);
    const safePath = path.normalize(basePath);

    fs.mkdirSync(path.dirname(safePath), { recursive: true });
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
      const auth = await this.auth.AuthenticateRequest(token);
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
        const matches = (Array.isArray(entries) ? entries : [])
          .filter((r) => String(r.address || "") === radiusServerIp);
        const existing = matches[0] || null;
        for (const extra of matches.slice(1)) {
          if (extra?.[".id"]) {
            await channel.write("/radius/remove", [`=.id=${extra[".id"]}`]).catch(() => null);
          }
        }
        if (existing && existing[".id"]) {
          await channel.write("/radius/set", [
            `=.id=${existing[".id"]}`,
            `=secret=${secret}`,
            "=service=ppp,hotspot",
            "=timeout=3s",
            "=require-message-auth=no",
          ]);
        } else {
          await channel.write("/radius/add", [
            `=address=${radiusServerIp}`,
            `=secret=${secret}`,
            "=service=ppp,hotspot",
            "=timeout=3s",
            "=require-message-auth=no",
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
    let migrationRecord = null;
    if (!token || !target || !stationId) {
      return res.status(400).json({ success: false, message: "Missing token, target, or stationId" });
    }
    try {
      const auth = await this.auth.AuthenticateRequest(token);
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
      const sourceBasis = String(station.systemBasis || "API").toUpperCase();
      migrationRecord = await this.db.createPlatformMigration({
        platformID,
        direction: "system_basis",
        status: "running",
        domain: station.name || station.mikrotikHost,
        sourceTarget: sourceBasis,
        destinationTarget: normalizedTarget,
        startedAt: new Date(),
        request: {
          stationId: station.id,
          stationName: station.name || station.mikrotikHost,
          from: sourceBasis,
          to: normalizedTarget,
          requestedBy: {
            id: auth.admin.id || auth.admin.adminID || null,
            name: auth.admin.name || null,
            email: auth.admin.email || null,
          },
        },
      });
      const packages = (await this.db.getPackagesByPlatformID(platformID)) || [];
      const stationPackages = packages.filter((pkg) => pkg.routerHost === station.mikrotikHost);
      const users = (await this.db.getUsersByCodes(platformID)) || [];
      const activeUsers = users.filter((u) => String(u.status || "").toLowerCase() === "active");
      const pppoe = (await this.db.getPPPoE(platformID)) || [];
      const stationPppoe = pppoe.filter((entry) => entry.station === station.mikrotikHost);
      const plans = (await this.db.getPPPoEPlans(platformID)) || [];
      const planMap = new Map(plans.map((p) => [p.id, p]));
      const packageMap = new Map(stationPackages.map((p) => [p.id, p]));
      const radiusServerIp = getRadiusServerIp();

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
        const existingNames = new Set(
          stations
            .filter((s) => String(s.id || "") !== String(station.id || ""))
            .map((s) => s.radiusClientName)
            .filter(Boolean)
        );
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
        const publicIp = await this.resolveStationPublicIp(station);
        const radiusClientIp = getRadiusClientIp(station, publicIp || station.radiusClientIp || "");
        const sharedRadiusStation = await this.findRadiusStationSharingClientIp(radiusClientIp, station.id);
        const clientSecret = getRadiusClientSecret(
          sharedRadiusStation?.radiusClientSecret ||
          station.radiusClientSecret ||
          crypto.randomBytes(12).toString("hex")
        );
        if (!radiusClientIp) {
          summary.warnings.push(`Station ${station.name || station.mikrotikHost}: missing Radius client IP`);
        }

        await this.db.updateStation(station.id, {
          systemBasis: "RADIUS",
          radiusClientName: clientName,
          radiusClientSecret: clientSecret,
          radiusClientIp: radiusClientIp,
          radiusServerIp: radiusServerIp || station.radiusServerIp || "",
        });
        summary.stationUpdated = true;

        if (radiusClientIp && radiusServerIp) {
          const addResult = await ensureRadiusClient({
            name: clientName,
            ip: radiusClientIp,
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
          const dataLimitBytes =
            this.parseDataLimitBytes(pkg.fupLimit) ||
            (String(pkg.category || "").toLowerCase() === "data" ? this.parseDataLimitBytes(pkg.usage) : null);
          await this.db.upsertRadiusUser({
            username,
            password,
            groupname: pkg.name,
            rateLimit,
            dataLimitBytes,
            expireAt: user.expireAt || null,
            period: pkg.period,
            sessionTimeoutSeconds: null,
            devices: pkg.devices,
          });
          summary.usersMigrated += 1;
        }

        for (const entry of stationPppoe) {
          const plan = entry.planId ? planMap.get(entry.planId) : null;
          const speedSource = plan?.profile || entry.profile || plan?.name || entry.name || "";
          const speedVal = String(speedSource).replace(/[^0-9.]/g, "");
          const rateLimit = speedVal ? `${speedVal}M/${speedVal}M` : "";
          const pppoeLimitBytes = this.parseDataLimitBytes(entry.fupLimit || plan?.fupLimit);
          await this.db.upsertRadiusUser({
            username: entry.clientname,
            password: entry.clientpassword,
            groupname: plan?.name || entry.name,
            rateLimit,
            dataLimitBytes: pppoeLimitBytes,
            expireAt: entry.expiresAt || null,
            period: plan?.period || entry.period || null,
            sessionTimeoutSeconds: null,
            maxSessions: entry.maxsessions || entry.devices,
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
      const message = `Migration to ${normalizedTarget} completed`;
      const completedMigration = migrationRecord
        ? await this.db.updatePlatformMigration(migrationRecord.id, {
            status: "completed",
            completedAt: new Date(),
            records: summary,
            response: { success: true, message, summary },
            error: null,
          })
        : null;
      return res.json({ success: true, message, summary, migration: completedMigration });
    } catch (error) {
      const message = error?.message || "Migration failed";
      if (migrationRecord?.id) {
        await this.db.updatePlatformMigration(migrationRecord.id, {
          status: "failed",
          completedAt: new Date(),
          error: message,
          response: { success: false, message },
        }).catch(() => null);
      }
      return res.status(500).json({ success: false, message: "Migration failed", error: message });
    }
  }

  async fetchSystemBasisMigrations(req, res) {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ success: false, message: "Missing token" });
    try {
      const auth = await this.auth.AuthenticateRequest(token);
      if (!auth.success || !auth.admin) {
        return res.status(401).json({ success: false, message: auth.message });
      }
      if (auth.admin.role !== "superuser") {
        return res.status(403).json({ success: false, message: "Unauthorised!" });
      }
      const migrations = await this.db.getPlatformMigrations(auth.admin.platformID, 100);
      return res.json({
        success: true,
        migrations: migrations.filter((migration) => migration.direction === "system_basis"),
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to fetch migration history" });
    }
  }
}


module.exports = { Controller };
