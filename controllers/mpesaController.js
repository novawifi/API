// @ts-check

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require('axios');
const moment = require('moment');
const IntaSend = require('intasend-node');
const jwt = require("jsonwebtoken");

const { Utils } = require("../utils/Functions");
const { DataBase } = require("../helpers/databaseOperation");
const { Auth } = require("./authController");
const { socketManager } = require("./socketController");
const { MpesaConfig } = require("../configs/mpesaConfig");
const { Mikrotikcontroller } = require("./mikrotikController");
const { Mailer } = require("./mailerController");
const { SMS } = require("./smsController");


class MpesaController {
    constructor() {
        this.ENVIRONMENT = process.env.ENVIRONMENT;
        this.intasend = new IntaSend(
            process.env.INTASEND_PUBLISHABLE_KEY,
            process.env.INTASEND_SECRET_KEY,
            this.ENVIRONMENT === "production" ? false : true,
        );
        this.PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

        this.db = new DataBase();
        this.auth = new Auth();
        this.mpesa = new MpesaConfig();
        this.mikrotik = new Mikrotikcontroller();
        this.mailer = new Mailer();
        this.sms = new SMS();
        this.darajaRequests = new Map();
        this.darajaRequestTTL = 10 * 60 * 1000;
    }

    getUserFriendlyMessage(message) {
        if (!message) return "An error occurred. Please try again.";
        const text = String(message);
        const lower = text.toLowerCase();

        if (lower.includes("request canceled by user") || lower.includes("request cancelled by user")) {
            return "You cancelled the payment request!";
        }
        if (lower.includes("ds timeout") || lower.includes("user unreachable")) {
            return "The phone number trying to pay is switched off.";
        }
        if (lower.includes("issue with push request") || lower.includes("general push request error")) {
            return "There was an issue requesting payment, try again.";
        }
        if (lower.includes("insufficient balance")) {
            return "You have insufficient funds in your M-PESA balance.";
        }
        if (lower.includes("initiator") && lower.includes("invalid")) {
            return "You entered the wrong M-PESA PIN.";
        }
        if (lower.includes("security credential") && lower.includes("invalid")) {
            return "You entered the wrong M-PESA PIN.";
        }
        if (lower.includes("timeout") || lower.includes("timed out")) {
            return "The M-PESA prompt timed out, retry the payment.";
        }
        if (lower.includes("insufficient funds")) {
            return "The user does not have enough funds to complete the payment.";
        }
        if (lower.includes("unable to lock subscriber") || lower.includes("transaction in process")) {
            return "Another transaction is in progress for this number. Please wait and try again.";
        }
        if (lower.includes("system busy") || lower.includes("system error")) {
            return "M-PESA is busy at the moment. Please try again shortly.";
        }
        if (lower.includes("invalid msisdn") || lower.includes("invalid phone")) {
            return "The phone number is invalid. Confirm the number and try again.";
        }
        if (lower.includes("access token")) {
            return "M-PESA authentication failed. Check the consumer key/secret and try again.";
        }
        if (lower.includes("shortcode") || lower.includes("short code")) {
            return "The M-PESA shortcode is invalid. Check the shortcode in settings.";
        }
        if (lower.includes("passkey")) {
            return "The M-PESA passkey is invalid. Update it and try again.";
        }
        if (lower.includes("callbackurl") || lower.includes("callback url")) {
            return "The callback URL is invalid or unreachable. Update it and try again.";
        }
        if (lower.includes("invalid amount")) {
            return "The amount is invalid. Enter a valid amount and try again.";
        }
        if (lower.includes("insufficient funds")) {
            return "There are not enough funds to complete this transaction.";
        }
        if (lower.includes("duplicate") && lower.includes("request")) {
            return "This request is already being processed. Please wait and check again.";
        }
        return text;
    }

    diagnoseMpesaCredentialError(error) {
        const data = error?.response?.data || {};
        const message = String(
            data?.errorMessage ||
            data?.message ||
            data?.error ||
            error?.message ||
            ""
        );
        const lower = message.toLowerCase();
        const status = error?.response?.status;

        if (status === 401 || lower.includes("invalid credentials") || lower.includes("invalid consumer")) {
            return "M-PESA consumer key or secret is invalid. Update them in Settings.";
        }
        if (lower.includes("invalid security credential") || lower.includes("initiator information is invalid")) {
            return "M-PESA initiator PIN is wrong or expired. Update it in Settings.";
        }
        if (lower.includes("invalid passkey")) {
            return "M-PESA passkey is invalid. Update it in Settings.";
        }
        return null;
    }

    emitMpesaCredentialError(platformID, error) {
        if (!platformID || !error) return;
        const diagnosis = this.diagnoseMpesaCredentialError(error);
        if (!diagnosis) return;
        socketManager.emitToRoom(`platform-${platformID}`, "payments:credential-error", {
            message: diagnosis,
            at: new Date().toISOString(),
        });
        socketManager.log(platformID, diagnosis, { context: "payments", level: "error" });
    }

    emitRecentPayment(platformID, payload) {
        if (!platformID || !payload) return;
        socketManager.emitToRoom(`platform-${platformID}`, "payments:recent", payload);
    }

    normalizePullTransactions(payload) {
        if (!payload) return [];
        const direct = payload.Transaction || payload.Transactions || payload.transactions || payload.transaction;
        if (Array.isArray(direct)) {
            return direct.flat().filter(Boolean);
        }
        if (Array.isArray(payload)) return payload;
        return [];
    }

    async registerPullShortCode({ accessToken, shortCode, nominatedNumber }) {
        if (!this.mpesa.MPESA_PULL_REGISTER_URL) {
            throw new Error("MPESA_PULL_REGISTER_URL not set.");
        }
        const response = await axios.post(
            this.mpesa.MPESA_PULL_REGISTER_URL,
            {
                ShortCode: String(shortCode),
                RequestType: "Pull",
                NominatedNumber: Utils.formatPhoneNumber(nominatedNumber),
                CallBackURL: `${process.env.BASE_URL}/mpesa/pull-callback`,
            },
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                },
            }
        );
        return response?.data || {};
    }

    async queryPullTransactions({ accessToken, shortCode, startDate, endDate, offset }) {
        if (!this.mpesa.MPESA_PULL_QUERY_URL) {
            throw new Error("MPESA_PULL_QUERY_URL not set.");
        }
        const response = await axios.post(
            this.mpesa.MPESA_PULL_QUERY_URL,
            {
                ShortCode: String(shortCode),
                StartDate: startDate,
                EndDate: endDate,
                OffSetValue: String(offset || "0"),
            },
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                },
            }
        );
        return response?.data || {};
    }

    async pushDashboardStats(platformID) {
        if (!platformID) return;
        try {
            const payload = await this.db.rebuildDashboardStats(platformID);
            if (!payload) return;
            socketManager.emitToRoom(`platform-${platformID}`, "stats", {
                success: true,
                message: "Dashboard stats fetched",
                stats: payload.stats,
                funds: payload.funds,
                networkusage: payload.networkusage,
                IsB2B: payload.IsB2B,
            });
        } catch (error) {
            // ignore dashboard refresh errors
        }
    }

    storeDarajaRequest(originatorId, platformID, type) {
        if (!originatorId || !platformID) return;
        this.darajaRequests.set(originatorId, {
            platformID,
            type,
            createdAt: Date.now(),
        });
    }

    resolveDarajaRequest(originatorId) {
        if (!originatorId) return null;
        const entry = this.darajaRequests.get(originatorId);
        if (!entry) return null;
        if (Date.now() - entry.createdAt > this.darajaRequestTTL) {
            this.darajaRequests.delete(originatorId);
            return null;
        }
        this.darajaRequests.delete(originatorId);
        return entry;
    }

    async getAccessToken(platform) {
        try {
            const response = await axios.get(
                this.mpesa.MPESA_AUTH_URL || "",
                {
                    auth: {
                        username: platform.mpesaConsumerKey,
                        password: platform.mpesaConsumerSecret,
                    },
                }
            );
            return response.data.access_token;
        } catch (error) {
            console.error('Error getting access token:', error.response?.data || error.message);
            const platformID = platform?.platformID || platform?.id;
            this.emitMpesaCredentialError(platformID, error);
            throw error;
        }
    };

    getC2BEnvConfig() {
        return {
            consumerKey: process.env.MPESA_C2B_CONSUMER_KEY,
            consumerSecret: process.env.MPESA_C2B_CONSUMER_SECRET,
            shortCode: process.env.MPESA_C2B_SHORT_CODE,
            shortCodeType: process.env.MPESA_C2B_SHORT_CODE_TYPE || "Paybill",
            passKey: process.env.MPESA_C2B_PASS_KEY,
            initiatorName: process.env.MPESA_C2B_INITIATOR_NAME,
            initiatorPassword: process.env.MPESA_C2B_INITIATOR_PASSWORD,
        };
    }

    async getC2BAccessToken(platformID = "") {
        const { consumerKey, consumerSecret } = this.getC2BEnvConfig();
        if (!consumerKey || !consumerSecret) {
            throw new Error("Missing MPESA C2B env consumer credentials.");
        }
        try {
            const response = await axios.get(
                this.mpesa.MPESA_AUTH_URL || "",
                {
                    auth: {
                        username: consumerKey,
                        password: consumerSecret,
                    },
                }
            );
            return response.data.access_token;
        } catch (error) {
            console.error('Error getting C2B access token:', error.response?.data || error.message);
            this.emitMpesaCredentialError(platformID, error);
            throw error;
        }
    }

    async isMaintenanceHappening() {
        const settings = await this.db.getSettings();
        let ismaintenance = false;
        let reason = null;
        if (settings) {
            ismaintenance = settings.underMaintenance;
            reason = settings.maintenanceReason
        }
        return {
            ismaintenance,
            reason
        }
    };

    async isBlocked(phone, platformID) {
        if (!phone) return null;
        try {
            const user = await this.db.getBlockedUserByPhone(phone, platformID);
            if (user && user.status === "blocked") {
                return user;
            }
            return null;
        } catch (error) {
            console.error("Error checking if user is blocked:", error);
            return null;
        }
    };

    computeExpiryFromPackage(pkg) {
        const fallbackMinutes = 24 * 60;
        let minutes = fallbackMinutes;

        if (pkg && pkg.period) {
            const v = parseInt(pkg.period, 10);
            if (!isNaN(v) && v > 0) minutes = v;
        }

        const expiresAt = new Date(Date.now() + minutes * 60 * 1000);
        return {
            expiresIn: `${minutes}m`,
            expiresAtISO: expiresAt.toISOString(),
        };
    };

    async createHotspotToken(payload, expiresIn) {
        const secret = process.env.JWT_SECRET;
        if (!secret) throw new Error("JWT_SECRET not set in env");

        return jwt.sign(payload, secret, { algorithm: "HS256", expiresIn });
    };

    logPayment(platformID, message, level = "info") {
        if (!platformID) return;
        socketManager.log(platformID, message, { context: "payments", level });
    }

    async initiateC2BStkPush({ platformID, phone, amount, accountReference, transactionDesc }) {
        const c2bEnv = this.getC2BEnvConfig();
        if (!this.mpesa.MPESA_STK_URL) {
            throw new Error("MPESA_STK_URL not set.");
        }
        if (!c2bEnv.shortCode || !c2bEnv.passKey) {
            throw new Error("Missing MPESA C2B shortcode or passkey.");
        }

        const accessToken = await this.getC2BAccessToken(platformID);
        const timestamp = moment().format('YYYYMMDDHHmmss');
        const password = Buffer.from(`${c2bEnv.shortCode}${c2bEnv.passKey}${timestamp}`).toString('base64');
        const cleanphone = Utils.formatPhoneNumber(phone);
        const txType = String(c2bEnv.shortCodeType || "").toLowerCase() === "paybill"
            ? 'CustomerPayBillOnline'
            : 'CustomerBuyGoodsOnline';

        const response = await axios.post(
            this.mpesa.MPESA_STK_URL,
            {
                BusinessShortCode: c2bEnv.shortCode,
                Password: password,
                Timestamp: timestamp,
                TransactionType: txType,
                Amount: amount,
                PartyA: cleanphone,
                PartyB: c2bEnv.shortCode,
                PhoneNumber: cleanphone,
                CallBackURL: this.mpesa.MPESA_CALLBACK_URL,
                AccountReference: accountReference || platformID || "Nova C2B",
                TransactionDesc: transactionDesc || 'WiFi Subscription Payment',
            },
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                },
            }
        );

        const checkoutRequestId = response?.data?.CheckoutRequestID;
        if (!checkoutRequestId) {
            throw new Error("MPESA C2B STK push failed: missing CheckoutRequestID.");
        }
        return checkoutRequestId;
    }

    async initiateC2BB2BTransfer({ platformID, amount, mpesaCode, reference }) {
        const config = await this.db.getPlatformConfig(platformID);
        if (!config) {
            throw new Error("Platform config not found.");
        }

        const destShortCode = config.mpesaC2BShortCode;
        const destType = config.mpesaC2BShortCodeType;
        const destAccount = config.mpesaC2BAccountNumber || "";
        if (!destShortCode || !destType) {
            throw new Error("Destination MPESA C2B shortcode or type not configured.");
        }
        if (String(destType).toLowerCase() === "paybill" && !destAccount) {
            throw new Error("Destination Paybill account number missing.");
        }

        if (!this.mpesa.MPESA_B2B_URL) {
            throw new Error("MPESA_B2B_URL not set.");
        }

        const c2bEnv = this.getC2BEnvConfig();
        if (!c2bEnv.initiatorName || !c2bEnv.initiatorPassword) {
            throw new Error("Missing MPESA C2B initiator credentials.");
        }
        if (!c2bEnv.shortCode) {
            throw new Error("Missing MPESA C2B shortcode.");
        }

        const accessToken = await this.getC2BAccessToken(platformID);
        const securityCredential = this.generateSecurityCredential(c2bEnv.initiatorPassword);
        const isPaybill = String(destType).toLowerCase() === "paybill";
        const commandId = isPaybill ? "BusinessPayBill" : "BusinessBuyGoods";
        const receiverIdentifierType = isPaybill ? "4" : "2";
        const senderIdentifierType = "4";
        const referenceText = reference || mpesaCode?.code || mpesaCode?.reqcode || "C2B Payout";

        const payload = {
            Initiator: c2bEnv.initiatorName,
            SecurityCredential: securityCredential,
            CommandID: commandId,
            SenderIdentifierType: senderIdentifierType,
            RecieverIdentifierType: receiverIdentifierType,
            Amount: Number(amount),
            PartyA: c2bEnv.shortCode,
            PartyB: destShortCode,
            AccountReference: isPaybill ? destAccount : "",
            Remarks: `C2B Payout ${referenceText}`,
            QueueTimeOutURL: `${process.env.BASE_URL}/mpesa/timeout`,
            ResultURL: `${process.env.BASE_URL}/mpesa/result`,
        };

        const response = await axios.post(
            this.mpesa.MPESA_B2B_URL,
            payload,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                },
            }
        );

        const result = response?.data || {};
        const conversationId =
            result.OriginatorConversationID ||
            result.ConversationID ||
            result.TransID ||
            `${referenceText}-${Date.now()}`;

        await this.db.addMpesaCode({
            platformID,
            amount: String(amount),
            code: conversationId,
            phone: mpesaCode?.phone || "null",
            status: "PENDING",
            reqcode: conversationId,
            type: "mpesa b2b",
            service: "Mpesa B2B",
            till: !isPaybill ? String(destShortCode) : "null",
            paybill: isPaybill ? String(destShortCode) : "null",
            account: isPaybill ? String(destAccount) : "null",
            paymentMethod: "Mpesa C2B",
        });

        return result;
    }

    async initiateC2BB2PochiTransfer({ platformID, amount, phone, reference, remarks = "" }) {
        const config = await this.db.getPlatformConfig(platformID);
        if (!config) {
            throw new Error("Platform config not found.");
        }

        if (!this.mpesa.MPESA_B2POCHI_URL) {
            throw new Error("MPESA_B2POCHI_URL not set.");
        }

        const c2bEnv = this.getC2BEnvConfig();
        if (!c2bEnv.initiatorName || !c2bEnv.initiatorPassword) {
            throw new Error("Missing MPESA C2B initiator credentials.");
        }
        if (!c2bEnv.shortCode) {
            throw new Error("Missing MPESA C2B shortcode.");
        }

        const accessToken = await this.getC2BAccessToken(platformID);
        const securityCredential = this.generateSecurityCredential(c2bEnv.initiatorPassword);
        const referenceText = reference || `${platformID}-${Date.now()}`;
        const payload = {
            OriginatorConversationID: referenceText,
            InitiatorName: c2bEnv.initiatorName,
            SecurityCredential: securityCredential,
            CommandID: "BusinessPayToPochi",
            Amount: String(amount),
            PartyA: c2bEnv.shortCode,
            PartyB: Utils.formatPhoneNumber(phone),
            Remarks: remarks || `C2B Pochi ${referenceText}`,
            QueueTimeOutURL: `${process.env.BASE_URL}/mpesa/timeout`,
            ResultURL: `${process.env.BASE_URL}/mpesa/result`,
            Occassion: "C2B Pochi",
        };

        const response = await axios.post(
            this.mpesa.MPESA_B2POCHI_URL,
            payload,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                },
            }
        );

        return response?.data || {};
    }

    async addToC2BTransferPool({ platformID, amount, destinationType, destinationShortCode, destinationAccount }) {
        const existing = await this.db.getC2BTransferPool(platformID);
        const currentAmount = existing ? Number(existing.amount || 0) : 0;
        const nextAmount = currentAmount + Number(amount || 0);
        return this.db.upsertC2BTransferPool(platformID, {
            destinationType,
            destinationShortCode,
            destinationAccount: destinationAccount || "null",
            amount: nextAmount.toFixed(2),
        });
    }

    async flushC2BTransferPool({ platformID, destinationType, destinationShortCode, destinationAccount }) {
        const pool = await this.db.getC2BTransferPool(platformID);
        if (!pool) return { attempted: false, success: false, amount: 0 };
        const amountValue = Number(pool.amount || 0);
        if (amountValue < 10) return { attempted: false, success: false, amount: amountValue };

        try {
            if (String(destinationType).toLowerCase() === "pochi") {
                const response = await this.initiateC2BB2PochiTransfer({
                    platformID,
                    amount: amountValue,
                    phone: destinationShortCode,
                    reference: `C2BPO-${Date.now()}`,
                });
                const originatorId = response?.OriginatorConversationID || response?.originatorConversationID;
                if (originatorId) {
                    this.storeDarajaRequest(originatorId, platformID, "c2b-pochi");
                }
            } else {
                await this.initiateC2BB2BTransfer({
                    platformID,
                    amount: amountValue,
                    mpesaCode: { code: `C2BPOOL-${Date.now()}` },
                    reference: `C2BPOOL-${Date.now()}`,
                });
            }

            await this.db.upsertC2BTransferPool(platformID, {
                destinationType,
                destinationShortCode,
                destinationAccount: destinationAccount || "null",
                amount: "0",
            });
            return { attempted: true, success: true, amount: amountValue };
        } catch (error) {
            return { attempted: true, success: false, amount: amountValue };
        }
    }

    async registerURL() {
        try {
            const platforms = await this.db.getAllPlatforms();
            for (const platform of platforms) {
                try {
                    const platformID = platform.platformID;
                    const config = await this.db.getPlatformConfig(platformID);
                    if (!config) continue;

                    if (config.offlinePayments === true || config.registeredURL === false || config.IsAPI === true || config.IsC2B === true) {
                        const isC2B = config.IsC2B === true && config.mpesaC2BShortCode;
                        const shortCode = isC2B ? config.mpesaC2BShortCode : config.mpesaShortCode;
                        if (!shortCode) continue;
                        const accessToken = isC2B ? await this.getC2BAccessToken(platformID) : await this.getAccessToken(platform);

                        const response = await axios.post(
                            this.mpesa.MPESA_REGISTER_URL || "",
                            {
                                ShortCode: shortCode,
                                ResponseType: "Completed",
                                ConfirmationURL: `${process.env.BASE_URL}/mpesa/confirmation`,
                                ValidationURL: `${process.env.BASE_URL}/mpesa/validation`
                            },
                            {
                                headers: {
                                    Authorization: `Bearer ${accessToken}`,
                                    'Content-Type': 'application/json',
                                },
                            }
                        );
                        const data = response.data
                        if (data.ResponseCode === "0") {
                            await this.db.updatePlatformConfig(platformID, {
                                registeredURL: true
                            })
                        }
                    }
                } catch (err) {
                    console.error(`Error registering URL for platform ${platform.platformID}:`, err);
                }
            }
        } catch (error) {
            console.error("Error initiating register url:", error);
        }
    };

    async stkPush(req, res) {
        const system = await this.isMaintenanceHappening();
        if (system?.ismaintenance === true) {
            return res.status(200).json({
                success: false,
                message: system?.reason
            });
        }

        const { phone, amount, mac, platformID } = req.body;
        const pkg = req.body.pkg || req.body.package;
        if (!phone || !amount) {
            return res.status(400).json({
                success: false,
                message: "Phone number and amount are required."
            });
        }

        const Blocked = await this.isBlocked(phone, platformID);
        if (Blocked !== null && Blocked.phone === phone) {
            return res.status(200).json({
                success: false,
                message: `Your phone number has been blocked by ${Blocked.blockedBy} due to violation of terms. Please contact customer care for assistance.`
            });
        }

        if (!pkg) {
            return res.status(400).json({
                success: false,
                message: "Missing credentials required!"
            });
        }

        try {
            const platform = await this.db.getPlatformConfig(platformID);
            const client = await this.db.getPlatform(platformID);
            if (!platform) {
                return res.status(400).json({
                    success: false,
                    message: "Configure Platform payments to continue!"
                });
            }
            const maskedPhone = phone?.toString().slice(-4) || "unknown";
            const pkgLabel = pkg?.name || pkg?.id || "package";
            socketManager.log(platformID, `Payment request started (${pkgLabel}, KES ${amount}, phone ****${maskedPhone})`, {
                context: "payments",
                level: "info",
            });

            const C2B = platform.IsC2B;
            const API = platform.IsAPI;
            const B2B = platform.IsB2B;
            const shortCode = platform.mpesaShortCode;
            const shortCodetype = platform.mpesaShortCodeType;

            let response;
            let checkoutRequestId;

            if (C2B) {
                if (!platform.mpesaC2BShortCode || !platform.mpesaC2BShortCodeType) {
                    return res.status(400).json({
                        success: false,
                        message: "Configure MPESA C2B destination details in Settings.",
                    });
                }
                checkoutRequestId = await this.initiateC2BStkPush({
                    platformID,
                    phone,
                    amount,
                    accountReference: client?.name || platformID,
                    transactionDesc: 'WiFi Subscription Payment',
                });
                const c2bType = String(platform.mpesaC2BShortCodeType || "").toLowerCase();
                const isPaybill = c2bType === "paybill";
                const isPochi = c2bType === "pochi";
                const mpesaCode = {
                    platformID: platformID,
                    amount: amount,
                    code: checkoutRequestId,
                    phone: phone,
                    status: "PENDING",
                    reqcode: checkoutRequestId,
                    service: "hotspot",
                    type: "deposit",
                    reason: pkg.id,
                    paymentMethod: "Mpesa C2B",
                    till: !isPaybill && !isPochi ? String(platform.mpesaC2BShortCode) : "null",
                    paybill: isPaybill ? String(platform.mpesaC2BShortCode) : "null",
                    account: isPaybill ? String(platform.mpesaC2BAccountNumber || "") : "null",
                };
                const addMpesaCodeTodb = await this.db.addMpesaCode(mpesaCode);
                if (addMpesaCodeTodb) {
                    socketManager.log(platformID, `C2B STK push initiated (ref ${checkoutRequestId})`, {
                        context: "payments",
                        level: "success",
                    });
                    return res.status(200).json({
                        success: true,
                        message: "STK Push initiated successfully",
                        data: {
                            checkoutRequestId: checkoutRequestId,
                        }
                    });
                }
            } else if (API) {
                const accessToken = await this.getAccessToken(platform);
                const timestamp = moment().format('YYYYMMDDHHmmss');
                const password = Buffer.from(`${platform.mpesaShortCode}${platform.mpesaPassKey}${timestamp}`).toString('base64');
                const cleanphone = Utils.formatPhoneNumber(phone)

                response = await axios.post(
                    this.mpesa.MPESA_STK_URL || "",
                    {
                        BusinessShortCode: platform.mpesaShortCode,
                        Password: password,
                        Timestamp: timestamp,
                        TransactionType: platform.mpesaShortCodeType.toLowerCase() === "paybill"
                            ? 'CustomerPayBillOnline'
                            : 'CustomerBuyGoodsOnline',
                        Amount: amount,
                        PartyA: cleanphone,
                        PartyB: platform.mpesaAccountNumber,
                        PhoneNumber: cleanphone,
                        CallBackURL: this.mpesa.MPESA_CALLBACK_URL,
                        AccountReference: platform.mpesaShortCodeType.toLowerCase() === "paybill" ? 'PayBill' : 'BuyGoods',
                        TransactionDesc: 'WiFi Subscription Payment',
                    },
                    {
                        headers: {
                            Authorization: `Bearer ${accessToken}`,
                            'Content-Type': 'application/json',
                        },
                    }
                );
                checkoutRequestId = response.data?.CheckoutRequestID;
            } else if (B2B) {
                const collection = this.intasend.collection();
                response = await collection.mpesaStkPush({
                    first_name: 'Joe',
                    last_name: 'Doe',
                    email: 'joe@doe.com',
                    host: 'https://novawifi.online/',
                    amount: amount,
                    phone_number: Utils.formatPhoneNumber(phone),
                    api_ref: 'Nova WiFi',
                });
                checkoutRequestId = response?.invoice?.invoice_id;
            }

            if (checkoutRequestId) {
                const mpesaCode = {
                    platformID: platformID,
                    amount: amount,
                    code: checkoutRequestId,
                    phone: phone,
                    status: "PENDING",
                    reqcode: checkoutRequestId,
                    service: "hotspot",
                    type: "deposit",
                    reason: pkg.id,
                    mac: mac
                };
                const addMpesaCodeTodb = await this.db.addMpesaCode(mpesaCode);
                if (addMpesaCodeTodb) {
                    socketManager.log(platformID, `STK push initiated (ref ${checkoutRequestId})`, {
                        context: "payments",
                        level: "success",
                    });
                    return res.status(200).json({
                        success: true,
                        message: "STK Push initiated successfully",
                        data: {
                            checkoutRequestId: checkoutRequestId,
                        }
                    });
                }
            }
            socketManager.log(platformID, "Failed to initiate STK push", {
                context: "payments",
                level: "error",
            });
            return res.status(400).json({
                success: false,
                message: "Failed to initiate STK Push"
            });
        } catch (error) {
            console.error('Error initiating STK Push:', this.decodeBuffer(error));
            socketManager.log(platformID, `STK push error: ${error.message || "unknown error"}`, {
                context: "payments",
                level: "error",
            });
            return res.status(500).json({
                success: false,
                message: "Failed to initiate STK Push",
                error: error.message
            });
        }
    };

    async payPPPoE(req, res) {
        const system = await this.isMaintenanceHappening();
        if (system?.ismaintenance === true) {
            return res.status(200).json({
                success: false,
                message: system?.reason
            });
        }

        const { phone, paymentLink } = req.body;
        if (!phone || !paymentLink) {
            return res.status(400).json({
                success: false,
                message: "Missing credentials are required."
            });
        }

        const pkg = await this.db.getPPPoEByPaymentLink(paymentLink);
        if (!pkg) {
            return res.status(400).json({
                success: false,
                message: "PPPoE Package does not exists!"
            });
        }
        let amount = 0;
        amount = Number(pkg.amount) > 0 ? pkg.amount : pkg.price;
        const platformID = pkg.platformID;

        try {
            const platform = await this.db.getPlatformConfig(platformID);
            if (!platform) {
                return res.status(400).json({
                    success: false,
                    message: "Configure Platform payments to continue!"
                });
            }
            const maskedPhone = phone?.toString().slice(-4) || "unknown";
            socketManager.log(platformID, `PPPoE payment request started (KES ${amount}, phone ****${maskedPhone})`, {
                context: "payments",
                level: "info",
            });

            const C2B = platform.IsC2B;
            const API = platform.IsAPI;
            const B2B = platform.IsB2B;
            const shortCode = platform.mpesaShortCode;
            const shortCodetype = platform.mpesaShortCodeType;

            let response;
            let checkoutRequestId;

            if (C2B) {
                if (!platform.mpesaC2BShortCode || !platform.mpesaC2BShortCodeType) {
                    return res.status(400).json({
                        success: false,
                        message: "Configure MPESA C2B destination details in Settings.",
                    });
                }
                checkoutRequestId = await this.initiateC2BStkPush({
                    platformID,
                    phone,
                    amount,
                    accountReference: platformID,
                    transactionDesc: 'PPPoE Subscription Payment',
                });
                const c2bType = String(platform.mpesaC2BShortCodeType || "").toLowerCase();
                const isPaybill = c2bType === "paybill";
                const isPochi = c2bType === "pochi";
                const mpesaCode = {
                    platformID: platformID,
                    amount: amount,
                    code: checkoutRequestId,
                    phone: phone,
                    status: "PENDING",
                    reqcode: checkoutRequestId,
                    service: "pppoe",
                    reason: null,
                    referenceID: paymentLink,
                    type: "deposit",
                    paymentMethod: "Mpesa C2B",
                    till: !isPaybill && !isPochi ? String(platform.mpesaC2BShortCode) : "null",
                    paybill: isPaybill ? String(platform.mpesaC2BShortCode) : "null",
                    account: isPaybill ? String(platform.mpesaC2BAccountNumber || "") : "null",
                };
                const addMpesaCodeTodb = await this.db.addMpesaCode(mpesaCode);
                if (addMpesaCodeTodb) {
                    socketManager.log(platformID, `PPPoE C2B STK push initiated (ref ${checkoutRequestId})`, {
                        context: "payments",
                        level: "success",
                    });
                    return res.status(200).json({
                        success: true,
                        message: "STK Push initiated successfully",
                        data: {
                            checkoutRequestId: checkoutRequestId,
                        }
                    });
                }
            } else if (API) {
                const accessToken = await this.getAccessToken(platform);
                const timestamp = moment().format('YYYYMMDDHHmmss');
                const password = Buffer.from(`${platform.mpesaShortCode}${platform.mpesaPassKey}${timestamp}`).toString('base64');

                response = await axios.post(
                    this.mpesa.MPESA_STK_URL || "",
                    {
                        BusinessShortCode: platform.mpesaShortCode,
                        Password: password,
                        Timestamp: timestamp,
                        TransactionType: platform.mpesaShortCodeType.toLowerCase() === "paybill"
                            ? 'CustomerPayBillOnline'
                            : 'CustomerBuyGoodsOnline',
                        Amount: amount,
                        PartyA: Utils.formatPhoneNumber(phone),
                        PartyB: platform.mpesaAccountNumber,
                        PhoneNumber: Utils.formatPhoneNumber(phone),
                        CallBackURL: this.mpesa.MPESA_CALLBACK_URL,
                        AccountReference: platform.mpesaShortCodeType.toLowerCase() === "paybill" ? 'PayBill' : 'BuyGoods',
                        TransactionDesc: 'PPPoE Subscription Payment',
                    },
                    {
                        headers: {
                            Authorization: `Bearer ${accessToken}`,
                            'Content-Type': 'application/json',
                        },
                    }
                );
                checkoutRequestId = response.data?.CheckoutRequestID;
            } else if (B2B) {
                const collection = this.intasend.collection();
                response = await collection.mpesaStkPush({
                    first_name: 'Joe',
                    last_name: 'Doe',
                    email: 'joe@doe.com',
                    host: 'https://novawifi.online/',
                    amount: amount,
                    phone_number: Utils.formatPhoneNumber(phone),
                    api_ref: 'PPPoE Subscription Payment',
                });
                checkoutRequestId = response?.invoice?.invoice_id;
            }

            if (checkoutRequestId) {
                const mpesaCode = {
                    platformID: platformID,
                    amount: amount,
                    code: checkoutRequestId,
                    phone: phone,
                    status: "PENDING",
                    reqcode: checkoutRequestId,
                    service: "pppoe",
                    reason: null,
                    referenceID: paymentLink,
                    type: "deposit"
                };
                const addMpesaCodeTodb = await this.db.addMpesaCode(mpesaCode);
                if (addMpesaCodeTodb) {
                    socketManager.log(platformID, `PPPoE STK push initiated (ref ${checkoutRequestId})`, {
                        context: "payments",
                        level: "success",
                    });
                    return res.status(200).json({
                        success: true,
                        message: "STK Push initiated successfully",
                        data: {
                            checkoutRequestId: checkoutRequestId,
                        }
                    });
                }
            }

            socketManager.log(platformID, "Failed to initiate PPPoE STK push", {
                context: "payments",
                level: "error",
            });
            return res.status(400).json({
                success: false,
                message: "Failed to initiate STK Push"
            });
        } catch (error) {
            console.error('Error initiating STK Push:', error.response?.data || error.message);
            socketManager.log(platformID, `PPPoE STK push error: ${error.message || "unknown error"}`, {
                context: "payments",
                level: "error",
            });
            return res.status(500).json({
                success: false,
                message: "Failed to initiate STK Push",
                error: error.message
            });
        }
    };

    async payBill(req, res) {
        const system = await this.isMaintenanceHappening();
        if (system?.ismaintenance === true) {
            return res.status(200).json({
                success: false,
                message: system?.reason
            });
        }

        const { token, phone, months, service } = req.body;
        if (!phone || !service) {
            return res.status(400).json({
                success: false,
                message: "Missing credentials are required."
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
        const bill = await this.db.getPlatformBillingByID(service);
        if (!bill) {
            return res.status(400).json({
                success: false,
                message: "Bill does not exist!"
            });
        }
        const payingmonths = Number(months) || 0;
        const amount = Number(bill.amount) + (Number(bill.price * Number(payingmonths)));
        const maskedPhone = phone?.toString().slice(-4) || "unknown";
        socketManager.log(platformID, `Bill payment request started (KES ${amount}, phone ****${maskedPhone})`, {
            context: "payments",
            level: "info",
        });

        try {
            let response;
            let checkoutRequestId;

            const collection = this.intasend.collection();
            response = await collection.mpesaStkPush({
                first_name: 'Joe',
                last_name: 'Doe',
                email: 'joe@doe.com',
                host: 'https://novawifi.online/',
                amount: amount,
                phone_number: Utils.formatPhoneNumber(phone),
                api_ref: 'Bill Subscription Payment',
            });
            checkoutRequestId = response?.invoice?.invoice_id;

            if (checkoutRequestId) {
                const mpesaCode = {
                    platformID: platformID,
                    amount: amount.toString(),
                    code: checkoutRequestId,
                    phone: phone,
                    status: "PENDING",
                    reqcode: checkoutRequestId,
                    service: "bill",
                    reason: null,
                    referenceID: bill.id,
                    type: "deposit"
                };
                const addMpesaCodeTodb = await this.db.addMpesaCode(mpesaCode);
                if (addMpesaCodeTodb) {
                    socketManager.log(platformID, `Bill STK push initiated (ref ${checkoutRequestId})`, {
                        context: "payments",
                        level: "success",
                    });
                    return res.status(200).json({
                        success: true,
                        message: "STK Push initiated successfully",
                        data: {
                            checkoutRequestId: checkoutRequestId,
                        }
                    });
                }

            }
            socketManager.log(platformID, "Failed to initiate bill STK push", {
                context: "payments",
                level: "error",
            });
            return res.status(400).json({
                success: false,
                message: "Failed to initiate STK Push"
            });
        } catch (error) {
            console.error('Error initiating STK Push:', error.response?.data || error.message);
            socketManager.log(platformID, `Bill STK push error: ${error.message || "unknown error"}`, {
                context: "payments",
                level: "error",
            });
            return res.status(500).json({
                success: false,
                message: "Failed to initiate STK Push",
                error: error.message
            });
        }
    };

    async callBack(req, res) {
        let callbackData = req.body;
        console.log("Mpesa Callback", callbackData)

        if (callbackData.Body.stkCallback) {
            let stkCallback = callbackData.Body.stkCallback;
            let resultCode = stkCallback.ResultCode;
            let message = stkCallback.ResultDesc;
            let CheckoutRequestID = stkCallback.CheckoutRequestID;

            const mpesaCode = await this.db.getMpesaByCode(CheckoutRequestID);
            if (!mpesaCode) {
                return res.status(404).json({
                    success: false,
                    message: "MPesa code not found for the given invoice ID.",
                });
            }
            this.logPayment(
                mpesaCode.platformID,
                `STK callback received (${resultCode === 0 ? "SUCCESS" : "FAILED"}) ref ${CheckoutRequestID}`,
                resultCode === 0 ? "success" : "warn"
            );

            if (resultCode === 0) {
                if (mpesaCode.status === "COMPLETE") {
                    this.logPayment(mpesaCode.platformID, `STK callback already processed (ref ${CheckoutRequestID})`, "info");
                    return res.status(200).json({ success: true, message: "Already processed." });
                }
                let transactionDetails = {
                    merchantRequestId: stkCallback.MerchantRequestID,
                    checkoutRequestId: stkCallback.CheckoutRequestID,
                    amount: stkCallback.CallbackMetadata.Item.find(item => item.Name === "Amount").Value,
                    mpesaReceiptNumber: stkCallback.CallbackMetadata.Item.find(item => item.Name === "MpesaReceiptNumber").Value,
                    phoneNumber: stkCallback.CallbackMetadata.Item.find(item => item.Name === "PhoneNumber").Value,
                    transactionDate: stkCallback.CallbackMetadata.Item.find(item => item.Name === "TransactionDate").Value
                };

                console.log("Updating Mpesa code with data:", {
                    checkoutRequestId: transactionDetails.checkoutRequestId,
                    code: transactionDetails.mpesaReceiptNumber,
                    status: "COMPLETE",
                    amount: (transactionDetails.amount).toString(),
                    platformID: mpesaCode.platformID,
                    type: 'deposit',
                });

                await this.db.updateMpesaCodeByID(mpesaCode.id, {
                    code: transactionDetails.mpesaReceiptNumber,
                    status: "COMPLETE",
                    amount: (transactionDetails.amount).toString(),
                    platformID: mpesaCode.platformID,
                    type: 'deposit',
                });
                this.logPayment(mpesaCode.platformID, `STK payment marked COMPLETE (ref ${CheckoutRequestID})`, "success");

                if (String(mpesaCode.paymentMethod || "").toLowerCase() === "mpesa c2b") {
                    const platform = await this.db.getPlatformConfig(mpesaCode.platformID);
                    const destType = platform?.mpesaC2BShortCodeType || "";
                    const destShortCode = platform?.mpesaC2BShortCode || "";
                    const destAccount = platform?.mpesaC2BAccountNumber || "";
                    const amountValue = Number(transactionDetails.amount || 0);
                    const shouldPool = amountValue < 10;

                    if (platform && destShortCode && destType) {
                        if (shouldPool) {
                            await this.addToC2BTransferPool({
                                platformID: mpesaCode.platformID,
                                amount: amountValue,
                                destinationType: destType,
                                destinationShortCode: destShortCode,
                                destinationAccount: destAccount,
                            });
                            await this.flushC2BTransferPool({
                                platformID: mpesaCode.platformID,
                                destinationType: destType,
                                destinationShortCode: destShortCode,
                                destinationAccount: destAccount,
                            });
                            this.logPayment(mpesaCode.platformID, `C2B transfer pooled (amount ${amountValue})`, "info");
                        } else {
                            try {
                                if (String(destType).toLowerCase() === "pochi") {
                                    const response = await this.initiateC2BB2PochiTransfer({
                                        platformID: mpesaCode.platformID,
                                        amount: amountValue,
                                        phone: destShortCode,
                                        reference: transactionDetails.mpesaReceiptNumber,
                                    });
                                    const originatorId = response?.OriginatorConversationID || response?.originatorConversationID;
                                    if (originatorId) {
                                        this.storeDarajaRequest(originatorId, mpesaCode.platformID, "c2b-pochi");
                                    }
                                    this.logPayment(mpesaCode.platformID, `C2B Pochi transfer queued (ref ${transactionDetails.mpesaReceiptNumber})`, "success");
                                } else {
                                    await this.initiateC2BB2BTransfer({
                                        platformID: mpesaCode.platformID,
                                        amount: amountValue,
                                        mpesaCode,
                                        reference: transactionDetails.mpesaReceiptNumber,
                                    });
                                    this.logPayment(mpesaCode.platformID, `C2B B2B transfer queued (ref ${transactionDetails.mpesaReceiptNumber})`, "success");
                                }
                            } catch (err) {
                                await this.addToC2BTransferPool({
                                    platformID: mpesaCode.platformID,
                                    amount: amountValue,
                                    destinationType: destType,
                                    destinationShortCode: destShortCode,
                                    destinationAccount: destAccount,
                                });
                                this.logPayment(mpesaCode.platformID, `C2B transfer failed, pooled for retry (ref ${transactionDetails.mpesaReceiptNumber})`, "warn");
                            }
                        }
                    }
                }

                if (mpesaCode.service === "hotspot") {
                    const pkg = await this.db.getPackagesByAmount(mpesaCode.platformID, `${parseInt(transactionDetails.amount)}`, mpesaCode.reason);
                    if (!pkg) {
                        return res.status(400).json({
                            success: false,
                            message: `Invalid package`,
                        });
                    }

                    this.emitRecentPayment(mpesaCode.platformID, {
                        id: mpesaCode.id,
                        code: transactionDetails.mpesaReceiptNumber,
                        phone: mpesaCode.phone,
                        amount: String(transactionDetails.amount),
                        status: "COMPLETE",
                        service: mpesaCode.service || "hotspot",
                        packageName: pkg?.name || null,
                        createdAt: new Date().toISOString(),
                    });

                    const { expiresIn, expiresAtISO } = this.computeExpiryFromPackage(pkg);

                    const isMoreThanOneDevice = Number(pkg.devices) > 1;
                    const isData = pkg.category === "Data";

                    const baseCode = transactionDetails.mpesaReceiptNumber || transactionDetails.checkoutRequestId;

                    const loginIdentifier = baseCode;

                    const tokenPayload = {
                        phone: mpesaCode.phone,
                        username: loginIdentifier,
                        packageID: pkg.id,
                        platformID: mpesaCode.platformID,
                    };

                    const jwtToken = await this.createHotspotToken(tokenPayload, expiresIn);

                    const data = {
                        token: jwtToken,
                        phone: mpesaCode.phone,
                        packageID: pkg.id,
                        platformID: mpesaCode.platformID,
                        package: pkg,
                        code: baseCode,
                        mac: baseCode,
                    };

                    const code_data = {
                        phone: mpesaCode.phone,
                        packageID: pkg.id,
                        platformID: mpesaCode.platformID,
                        code: baseCode,
                        mac: baseCode,
                        token: "null",
                    }

                    let addcodetorouter = await this.mikrotik.addManualCode(data);

                    if (!addcodetorouter.success) {
                        socketManager.emitEvent("deposit-status", {
                            status: "COMPLETE_INACTIVE",
                            checkoutRequestId: transactionDetails.checkoutRequestId,
                            message: "Payment received, please wait connecting you shortly...",
                            loginCode: loginIdentifier,
                        }, transactionDetails.checkoutRequestId);

                        const startTime = Date.now();
                        const timeout = 10000;

                        while (Date.now() - startTime < timeout) {
                            addcodetorouter = await this.mikrotik.addManualCode(code_data);
                            if (addcodetorouter.success === true) break;
                            await new Promise((resolve) => setTimeout(resolve, 1000));
                        }

                        if (!addcodetorouter?.success) {
                            this.logPayment(mpesaCode.platformID, `STK activation failed after retries (ref ${CheckoutRequestID})`, "warn");
                            socketManager.emitEvent("deposit-status", {
                                status: "INACTIVE",
                                checkoutRequestId: transactionDetails.checkoutRequestId,
                                message: "Payment received but failed to automatically connect to WIFI. Please connect manually using M-PESA Message.",
                                error: addcodetorouter?.message,
                                loginCode: loginIdentifier,
                            }, transactionDetails.checkoutRequestId);

                            return {
                                success: false,
                                message: "Payment received but failed to automatically connect to WIFI. Please connect manually using M-PESA Message.",
                            };
                        }
                    }

                    socketManager.emitEvent("deposit-success", {
                        status: "COMPLETE",
                        checkoutRequestId: transactionDetails.checkoutRequestId,
                        message: "Payment successful!",
                        loginCode: loginIdentifier,
                        token: jwtToken,
                        expiresAt: expiresAtISO,
                    }, transactionDetails.checkoutRequestId);
                    this.logPayment(mpesaCode.platformID, `STK activation completed (ref ${CheckoutRequestID})`, "success");

                    const platformConfig = await this.db.getPlatformConfig(mpesaCode.platformID);
                    if (platformConfig?.sms === true) {
                        const sms = await this.db.getPlatformSMS(mpesaCode.platformID);
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

                        const platform = await this.db.getPlatform(mpesaCode.platformID);
                        if (!platform) {
                            return res.status(200).json({
                                success: false,
                                message: "Platform not found!",
                            });
                        }

                        const sms_message = Utils.formatMessage(sms.hotspotTemplate, {
                            company: platform.name,
                            username: addcodetorouter.code.username,
                            period: pkg.period,
                            expiry: addcodetorouter.code.expireAt,
                            package: pkg.name,
                        });

                        const is_send = await this.sms.sendSMS(mpesaCode.phone, sms_message, sms);
                        if (is_send.success && sms?.default === true) {
                            const newSMSBalance = Number(sms.balance) - Number(sms.costPerSMS);
                            const newSMS = Math.floor(Number(sms.remainingSMS)) - 1;

                            await this.db.updatePlatformSMS(mpesaCode.platformID, {
                                balance: newSMSBalance.toString(),
                                remainingSMS: newSMS.toString()
                            });
                        }
                    }
                } else if (mpesaCode.service === "pppoe") {
                    const paymentLink = mpesaCode.reason;
                    const client = await this.db.getPPPoEByPaymentLink(paymentLink);
                    if (!client) {
                        return {
                            success: false,
                            message: `Invalid paymentLink`,
                        };
                    }

                    this.emitRecentPayment(mpesaCode.platformID, {
                        id: mpesaCode.id,
                        code: transactionDetails.mpesaReceiptNumber,
                        phone: mpesaCode.phone,
                        amount: String(transactionDetails.amount),
                        status: "COMPLETE",
                        service: mpesaCode.service || "pppoe",
                        packageName: client?.name || client?.servicename || null,
                        createdAt: new Date().toISOString(),
                    });
                    const data = {
                        platformID: client.platformID,
                        service: client.servicename,
                        user: client.clientname,
                        host: client.station
                    };
                    const enableserver = await this.mikrotik.manageMikrotikPPPoE(data)
                    if (enableserver.success) {
                        let expireAt = null;
                        if (client?.period) {
                            const now = new Date();
                            const period = client.period.toLowerCase();

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

                        await this.db.updatePPPoE(client.id, {
                            status: "active",
                            amount: "0",
                            expiresAt: expireAt,
                            reminderSent: false
                        })
                        const platform = await this.db.getPlatform(client.platformID);

                        if (client?.email) {
                            const subject = `Payment received. Your ${platform.name} PPPoE Service has been enabled!`
                            const message = `
  <p>Confirmed we have received KSH ${(transactionDetails.amount).toString()} for your PPPoE Service. <strong>RECEIPT NUMBER - ${transactionDetails.mpesaReceiptNumber}</strong>.</p>
<p>For more status and information about this service, visit:<br />
  <a href="https://${platform.url}/pppoe?info=${paymentLink}">https://${platform.url}/pppoe?info=${paymentLink}</a></p>
`;

                            const data = {
                                name: client?.email,
                                type: "accounts",
                                email: client?.email,
                                subject: subject,
                                message: message,
                                company: platform.name
                            }
                            const sendpppoeemail = await this.mailer.EmailTemplate(data);
                            if (!sendpppoeemail.success) {
                                console.warn(`Failed to send email, ${sendpppoeemail.message}`)
                            }
                        }

                        return {
                            success: true,
                            message: "PPPoE Server enabled successfully",
                        };
                    } else {
                        return {
                            success: false,
                            message: `Failed to enable PPPoE Server!`,
                        };
                    }
                }
            } else {
                // Payment Failed
                await this.db.updateMpesaCodeByID(mpesaCode.id, {
                    status: "FAILED",
                    platformID: mpesaCode.platformID,
                    type: 'deposit',
                    failed_reason: message
                });

                const userMessage = this.getUserFriendlyMessage(message);
                socketManager.emitEvent("deposit-status", {
                    status: "FAILED",
                    checkoutRequestId: stkCallback.CheckoutRequestID,
                    message: userMessage
                }, stkCallback.checkoutRequestId);
                this.logPayment(mpesaCode.platformID, `STK payment failed (ref ${CheckoutRequestID}) - ${message}`, "warn");

                return res.status(400).json({ type: "error", message: this.getUserFriendlyMessage("Transaction not successful") });
            }
        }

        return res.status(200).json({
            success: true,
            message: "Deposit callback processed.",
        });
    }

    async WithdrawFunds(req, res) {
        const system = await this.isMaintenanceHappening();
        if (system?.ismaintenance === true) {
            return res.status(200).json({ type: "error", message: system?.reason });
        }

        const { token, amount } = req.body;
        if (!token) {
            return res.json({
                success: false,
                message: "Missing credentials required 2!",
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
        const adminID = auth.admin.adminID;
        if (!adminID || !platformID || !amount) {
            return res.status(400).json({
                success: false,
                message: "Missing fields are required!",
            });
        }
        this.logPayment(platformID, `Withdrawal request received (KES ${amount})`, "info");

        if (!this.validateWithdrawalAmount(amount)) {
            return res.status(400).json({
                success: false,
                message: "Invalid amount, try again!",
            });
        }

        try {
            const admin = await this.db.getAdminsByID(adminID);
            if (!admin) {
                return res.status(404).json({
                    success: false,
                    message: "Admin does not exist!",
                });
            }

            const checkFundsAccount = await this.db.getFunds(platformID);
            if (!checkFundsAccount) {
                return res.status(404).json({
                    success: false,
                    message: "Platform account does not exist!",
                });
            }

            if (Number(checkFundsAccount.balance) < Number(amount)) {
                return res.status(400).json({
                    success: false,
                    message: "Insufficient funds for withdrawal!",
                });
            }

            const platformCredentials = await this.db.getPlatformConfig(platformID);
            const isB2B = platformCredentials.IsB2B;
            if (!isB2B && Number(checkFundsAccount.balance) <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid operation for withdrawal, configure B2B payments on the Settings Tab first!",
                });
            }

            const payments = await this.db.getMpesaByPlatform(platformID);
            if (payments && payments.length > 0) {
                const pendingWithdrawals = payments.filter(payment => payment.type === "withdrawal" && payment.status === "PENDING");
                if (pendingWithdrawals.length >= 1) {
                    return res.status(400).json({
                        success: false,
                        message: "You have a pending withdrawal request, wait until it is processed!",
                    });
                }
            }

            const paymentType = platformCredentials.mpesaShortCodeType;
            const shortCode = platformCredentials.mpesaShortCode;
            const accountReference = platformCredentials.mpesaAccountNumber;

            let fee = 0;

            if (paymentType === "Phone") {
                if (amount <= 100) {
                    fee = 10;
                } else if (amount <= 1000) {
                    fee = 20;
                } else if (amount <= 150000) {
                    fee = 100;
                }
            } else if (paymentType === "Till" || paymentType === "Paybill") {
                if (amount <= 100) {
                    fee = 10;
                } else if (amount <= 1500) {
                    fee = 30;
                } else if (amount <= 2500) {
                    fee = 50;
                } else if (amount <= 3500) {
                    fee = 60;
                } else if (amount <= 10000) {
                    fee = 80;
                } else if (amount <= 20000) {
                    fee = 100;
                } else if (amount <= 30000) {
                    fee = 120;
                } else if (amount <= 35000) {
                    fee = 130;
                } else if (amount <= 40000) {
                    fee = 140;
                } else if (amount <= 150000) {
                    fee = 150;
                } else if (amount <= 250000) {
                    fee = 200;
                } else if (amount <= 500000) {
                    fee = 500;
                } else {
                    fee = 500;
                }
            }

            const netAmount = Number(amount) - fee;

            if (netAmount <= 0) {
                return res.status(400).json({
                    success: false,
                    message: "Withdrawal amount is too small after fees.",
                });
            }

            const IsPhone = paymentType === "Phone";
            const IsTill = paymentType === "Till";
            const IsPaybill = paymentType === "Paybill";
            let phone = "null";
            let till = "null";
            let PayBill = "null";

            if (paymentType === "Phone") {
                phone = shortCode;
            } else if (paymentType === "Till") {
                till = shortCode;
            } else if (paymentType === "Paybill") {
                PayBill = shortCode;
            }
            const payouts = this.intasend.payouts();
            let resp;
            if (IsPhone) {
                resp = await payouts.mpesa({
                    currency: "KES",
                    requires_approval: "NO",
                    transactions: [
                        {
                            name: "Nova Client",
                            account: Utils.formatPhoneNumber(phone),
                            amount: netAmount,
                            narrative: "Nova WiFi Withdrawal",
                        },
                    ],
                });
            } else {
                resp = await payouts.mpesaB2B({
                    currency: "KES",
                    requires_approval: "NO",
                    transactions: [
                        {
                            name: "Nova Client",
                            account: shortCode,
                            account_type: IsTill ? "TillNumber" : "PayBill",
                            account_reference: IsPaybill ? accountReference : "",
                            amount: netAmount,
                            narrative: "Nova WiFi Withdrawal",
                        },
                    ],
                });
            }
            const response = this.decodeBuffer(resp);
            const fileID = response.file_id;
            const currentTransaction = response.transactions[0];
            const status = currentTransaction.status;
            if (fileID) {
                const mpesaCode = await this.db.addMpesaCode({
                    platformID,
                    code: fileID,
                    reqcode: fileID,
                    phone: phone ? phone : till ? till : PayBill,
                    amount: amount.toString(),
                    type: "withdrawal",
                    status: "PENDING",
                    till,
                    paybill: PayBill,
                    account: accountReference,
                    service: "Mpesa B2B"
                });
                return res.status(200).json({
                    success: true,
                    message: "Withdrawal initiated successfully!",
                    mpesaCode,
                });
            } else {
                this.logPayment(platformID, "Withdrawal failed: IntaSend error (no file_id).", "error");
                return res.status(400).json({
                    success: false,
                    message: "Withdrawal failed! Intasend error.",
                    error: "Unknown error",
                });
            }

        } catch (err) {
            console.error("An error occurred:", this.decodeBuffer(err));
            this.logPayment(platformID, `Withdrawal request failed: ${err?.message || err}`, "error");
            return res.status(500).json({
                success: false,
                message: "Withdrawal request failed, try again later!",
                error: `An error occured: ${err}`
            });
        }
    }

    async handleIntasendCallback(req, res) {
        const { file_id, transactions, challenge } = req.body;

        if (challenge !== process.env.INTASEND_CHALLENGE) {
            return res.status(400).json({
                success: false,
                message: "Unauthorized request!",
            });
        }

        if (!file_id || !transactions || !transactions.length) {
            return res.status(200).json({
                success: false,
                message: "Missing required fields in callback data!",
            });
        }

        try {
            const transaction = transactions[0];
            const { status, amount, charge } = transaction;
            const totalAmount = parseFloat(amount) + parseFloat(charge);

            const mpesaCode = await this.db.getMpesaByCode(file_id);
            if (!mpesaCode) {
                return res.status(404).json({
                    success: false,
                    message: "MPesa code not found for the given request reference ID.",
                });
            }
            this.logPayment(mpesaCode.platformID, `IntaSend withdrawal callback: ${status} (ref ${file_id})`, status === "Successful" ? "success" : "warn");

            if (status === "Successful") {
                const funds = await this.db.getFunds(mpesaCode.platformID);
                const newBalance = parseFloat(funds.balance) - totalAmount;
                const withdrawals = funds.withdrawals
                    ? parseFloat(funds.withdrawals) + totalAmount
                    : totalAmount;
                await this.db.updateFunds(mpesaCode.platformID, {
                    balance: `${newBalance.toFixed(2)}`,
                    withdrawals: `${withdrawals.toFixed(2)}`
                });
            }

            let new_status;
            if (status === "Pending") {
                new_status = "PENDING";
            } else if (status === "Successful") {
                new_status = "COMPLETE";
            } else if (status === "Cancelled") {
                new_status = "FAILED";
            }

            await this.db.updateMpesaCodeByID(mpesaCode.id, {
                status: new_status,
                amount,
                platformID: mpesaCode.platformID,
                type: 'withdrawal',
            });

            const admins = await this.db.getSuperAdminsByPlatform(mpesaCode.platformID);
            if (admins && admins.length > 0) {
                for (const admin of admins) {
                    const name = admin.name;
                    const email = admin.email;
                    const subject = `Successful withdrawal request!`;
                    const message = `You withdrawal of ${totalAmount} KSH for a of fee KSH ${charge} has been completed.Confirmed ${file_id}. KSH ${amount} has been send to your M-PESA account.`;
                    const data = {
                        name: name,
                        type: "info",
                        email: email,
                        subject: subject,
                        message: message
                    }
                    const sendwithdrawalemail = await this.mailer.EmailTemplate(data);
                    if (!sendwithdrawalemail.success) {
                        this.logPayment(mpesaCode.platformID, `Withdrawal email failed: ${sendwithdrawalemail.message}`, "warn");
                        return res.status(200).json({
                            success: false,
                            message: sendwithdrawalemail.message,
                            admins: admins
                        });
                    }
                }
            }

            return res.status(200).json({
                success: true,
                message: "Withdrawal callback processed.",
                admins: admins
            });
        } catch (err) {
            console.error("Error processing callback:", err);
            this.logPayment(req?.body?.platformID, `Withdrawal callback error: ${err?.message || err}`, "error");
        }
        return res.status(200).json({ success: true });
    }

    async handleIntasendDepositCallback(req, res) {
        const {
            invoice_id,
            state,
            net_amount,
            account,
            challenge,
            mpesa_reference,
            failed_reason,
            value
        } = req.body;

        console.log("Intasend Deposit Callback", req.body);

        if (challenge !== process.env.INTASEND_CHALLENGE) {
            return res.status(200).json({
                success: false,
                message: "Unauthorized request!",
            });
        }

        if (!invoice_id || !state || !net_amount || !account) {
            return res.status(200).json({
                success: false,
                message: "Missing required fields in callback data!",
            });
        }

        try {
            const mpesaCode = await this.db.getMpesaByCode(invoice_id);
            if (!mpesaCode) {
                return res.status(200).json({
                    success: false,
                    message: "MPesa code not found for the given invoice ID.",
                });
            }

            this.logPayment(mpesaCode.platformID, `IntaSend deposit callback: ${state} (ref ${invoice_id})`, state === "COMPLETE" ? "success" : "warn");

            if (state === "COMPLETE") {
                const referenceCode = (mpesa_reference && mpesa_reference.trim() !== "") ? mpesa_reference : invoice_id;
                await this.db.updateMpesaCodeByID(mpesaCode.id, {
                    code: referenceCode,
                    status: state,
                    amount: net_amount,
                    platformID: mpesaCode.platformID,
                    type: 'deposit',
                });

                const funds = await this.db.getFunds(mpesaCode.platformID);
                if (mpesaCode.service === "hotspot") {
                    if (!funds) {
                        await this.db.createFunds({
                            balance: net_amount.toString(),
                            withdrawals: "0",
                            deposits: "0",
                            platformID: mpesaCode.platformID
                        })
                    } else {
                        const newBalance = parseFloat(funds.balance) + parseFloat(net_amount);
                        await this.db.updateFunds(mpesaCode.platformID, {
                            balance: newBalance.toString()
                        });
                    }
                    const pkg = await this.db.getPackagesByAmount(mpesaCode.platformID, value, mpesaCode.reason);
                    if (!pkg) {
                        return res.status(200).json({
                            success: false,
                            message: `Invalid package`,
                            value: value
                        });
                    }

                    const { expiresIn, expiresAtISO } = this.computeExpiryFromPackage(pkg);

                    const tokenPayload = {
                        phone: mpesaCode.phone,
                        username: mpesa_reference ? mpesa_reference : invoice_id,
                        packageID: pkg.id,
                        platformID: mpesaCode.platformID,
                    };
                    const jwtToken = await this.createHotspotToken(tokenPayload, expiresIn);

                    const data = {
                        token: jwtToken,
                        phone: mpesaCode.phone,
                        packageID: pkg.id,
                        platformID: mpesaCode.platformID,
                        package: pkg,
                        code: mpesa_reference ? mpesa_reference : invoice_id,
                        mac: mpesaCode?.mac && mpesaCode?.mac !== "null" ? mpesaCode.mac : (
                            mpesa_reference ? mpesa_reference : invoice_id
                        )
                    }

                    let addcodetorouter = await this.mikrotik.addManualCode(data);

                    if (!addcodetorouter.success) {
                        socketManager.emitEvent("deposit-status", {
                            status: "COMPLETE_INACTIVE",
                            checkoutRequestId: invoice_id,
                            message: "Payment received, please wait connecting you shortly...",
                            loginCode: mpesaCode?.mac && mpesaCode?.mac !== "null" ? mpesaCode.mac : (
                                mpesa_reference ? mpesa_reference : invoice_id
                            ),
                        }, invoice_id);

                        const startTime = Date.now();
                        const timeout = 10000;

                        while (Date.now() - startTime < timeout) {
                            addcodetorouter = await this.mikrotik.addManualCode(data);
                            if (addcodetorouter.success) break;
                            await new Promise((resolve) => setTimeout(resolve, 1000));
                        }

                        if (!addcodetorouter?.success) {

                            socketManager.emitEvent("deposit-status", {
                                status: "INACTIVE",
                                checkoutRequestId: invoice_id,
                                message: "Payment received but voucher activation failed. Please contact customer care for assistance.",
                                error: addcodetorouter?.message,
                                loginCode: mpesaCode?.mac && mpesaCode?.mac !== "null" ? mpesaCode.mac : (
                                    mpesa_reference ? mpesa_reference : invoice_id
                                ),
                            }, invoice_id);

                            return {
                                success: false,
                                message: "Payment received but activation failed. Please contact customer care for assistance.",
                            };
                        }
                    }

                    socketManager.emitEvent("deposit-success", {
                        status: state,
                        checkoutRequestId: invoice_id,
                        message: "Payment successful!",
                        loginCode: mpesaCode?.mac && mpesaCode?.mac !== "null" ? mpesaCode.mac : (
                            mpesa_reference ? mpesa_reference : invoice_id
                        ),
                        token: jwtToken,
                        expiresAt: expiresAtISO,
                    }, invoice_id);

                    const platformConfig = await this.db.getPlatformConfig(mpesaCode.platformID)
                    if (platformConfig?.sms === true) {
                        const sms = await this.db.getPlatformSMS(mpesaCode.platformID)
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

                        const platform = await this.db.getPlatform(mpesaCode.platformID)
                        if (!platform) {
                            return res.status(200).json({
                                success: false,
                                message: "Platform not found!",
                            });
                        }

                        const sms_message = Utils.formatMessage(sms.hotspotTemplate, {
                            company: platform.name,
                            username: addcodetorouter.code.username,
                            period: pkg.period,
                            expiry: addcodetorouter.code.expireAt,
                            package: pkg.name,
                        });

                        const is_send = await this.sms.sendSMS(mpesaCode.phone, sms_message, sms)
                        if (is_send.success && sms?.default === true) {
                            const newSMSBalance = Number(sms.balance) - Number(sms.costPerSMS);
                            const newSMS = Math.floor(Number(sms.remainingSMS)) - 1;

                            await this.db.updatePlatformSMS(mpesaCode.platformID, {
                                balance: newSMSBalance.toString(),
                                remainingSMS: newSMS.toString()
                            })
                        }
                    }
                } else if (mpesaCode.service === "pppoe") {
                    if (!funds) {
                        await this.db.createFunds({
                            balance: net_amount,
                            withdrawals: "0",
                            deposits: "0",
                            platformID: mpesaCode.platformID
                        })
                    } else {
                        const newBalance = parseFloat(funds.balance) + parseFloat(net_amount);
                        await this.db.updateFunds(mpesaCode.platformID, {
                            balance: `${newBalance.toFixed(2)}`
                        });
                    }
                    const paymentLink = mpesaCode.reason;
                    const client = await this.db.getPPPoEByPaymentLink(paymentLink);
                    if (!client) {
                        return res.status(200).json({
                            success: false,
                            message: "Invalid paymentLink!",
                        });
                    }
                    const data = {
                        platformID: client.platformID,
                        service: client.servicename,
                        user: client.clientname,
                        host: client.station
                    };
                    const enableserver = await this.mikrotik.manageMikrotikPPPoE(data)
                    if (enableserver.success) {
                        let expireAt = null;
                        if (client?.period) {
                            const now = new Date();
                            const period = client.period.toLowerCase();

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

                        await this.db.updatePPPoE(client.id, {
                            status: "active",
                            amount: "0",
                            expiresAt: expireAt,
                            reminderSent: false
                        })
                        const platform = await this.db.getPlatform(client.platformID);

                        if (client?.email) {
                            const subject = `Payment received. Your ${platform.name} PPPoE Service has been enabled!`
                            const message = `
  <p>Confirmed we have received KSH ${(net_amount).toString()} for your PPPoE Service. <strong>RECEIPT NUMBER - ${mpesa_reference}</strong>.</p>
<p>For more status and information about this service, visit:<br />
  <a href="https://${platform.url}/pppoe?info=${paymentLink}">https://${platform.url}/pppoe?info=${paymentLink}</a></p>
`;

                            const data = {
                                name: client?.email,
                                type: "accounts",
                                email: client?.email,
                                subject: subject,
                                message: message,
                                company: platform.name
                            }
                            const sendpppoeemail = await this.mailer.EmailTemplate(data);
                            if (!sendpppoeemail.success) {
                                console.warn(`Failed to send email, ${sendpppoeemail.message}`)
                            }
                        }

                        return {
                            success: true,
                            message: "PPPoE Server enabled successfully",
                        };
                    } else {
                        return {
                            success: false,
                            message: `Failed to enable PPPoE Server!`,
                        };
                    }
                }
            } else {
                await this.db.updateMpesaCodeByID(mpesaCode.id, {
                    status: state,
                    platformID: mpesaCode.platformID,
                    type: 'deposit',
                    failed_reason: failed_reason || "Payment failed"
                });
            }
        } catch (err) {
            console.error("Error processing callback:", err);
            this.logPayment(req?.body?.platformID, `IntaSend deposit callback error: ${err?.message || err}`, "error");
            return res.status(500).json({
                success: false,
                message: "Internal server error while processing callback.",
                error: err.message,
            });
        }

        return res.status(200).json({
            success: true,
            message: "Deposit callback processed.",
        });
    }

    async checkPayment(req, res) {
        try {
            const { code } = req.body || {};
            if (!code) {
                return res.status(400).json({ success: false, message: "Missing payment code." });
            }

            let payment = await this.db.getMpesaCode(String(code));
            if (!payment) {
                payment = await this.db.getMpesaByCode(String(code));
            }
            if (!payment) {
                return res.status(200).json({ success: false, message: "Payment not found." });
            }
            this.logPayment(payment.platformID, `Payment status check: ${payment.status} (ref ${code})`, payment.status === "FAILED" ? "warn" : "info");

            if (payment.status === "PENDING" || payment.status === "PROCESSING") {
                return res.status(200).json({
                    success: false,
                    status: payment.status,
                    message: "Payment is still pending.",
                });
            }

            if (payment.status === "FAILED") {
                return res.status(200).json({
                    success: false,
                    status: "FAILED",
                    message: this.getUserFriendlyMessage(payment.failed_reason || "Payment failed."),
                });
            }

            if (payment.status === "COMPLETE") {
                const result = await this.completePaymentForService(payment);
                if (payment.service === "hotspot") {
                    if (result?.status === "FAILED") {
                        this.logPayment(payment.platformID, `Payment activation failed (ref ${code})`, "warn");
                        return res.status(200).json({
                            success: false,
                            status: "FAILED",
                            message: result?.message || "Activation failed.",
                        });
                    }
                    this.logPayment(payment.platformID, `Payment activation complete (ref ${code})`, "success");
                    return res.status(200).json({
                        success: true,
                        status: "COMPLETE",
                        message: "Payment received. Connecting you shortly.",
                        loginCode: result?.loginCode || payment.code,
                        token: result?.token || null,
                        expiresAt: result?.expiresAt || null,
                    });
                }
                return res.status(200).json({
                    success: true,
                    status: "COMPLETE",
                    message: "Payment completed successfully.",
                });
            }

            return res.status(200).json({ success: false, message: "Payment status unknown." });
        } catch (error) {
            console.error("Payment check error:", error);
            this.logPayment(req?.body?.platformID, `Payment check error: ${error?.message || error}`, "error");
            return res.status(500).json({ success: false, message: "Failed to check payment." });
        }
    }

    async handlePaystackDepositCallback(req, res) {
        return res.status(200).json({
            success: true,
            message: 'Webhook event received but ignored',
        });

        const event = req.body;
        console.log("Deposit callback event:", event);

        if (event.event === 'charge.success') {
            const { reference, amount, currency, customer, subaccount } = event.data;

            try {
                const txVerify = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
                    headers: {
                        Authorization: `Bearer ${this.PAYSTACK_SECRET_KEY}`
                    }
                });

                const txData = txVerify.data.data;

                if (txData.status === 'success' && txData.currency === 'KES') {
                    const depositAmountKES = txData.amount / 100;

                    console.log("Customer:", customer.email);
                    console.log("Amount:", depositAmountKES, "KES");
                    console.log("Reference:", reference);
                    console.log("Subaccount:", subaccount);

                    return res.status(200).json({
                        success: true,
                        message: 'Customer deposit verified and processed successfully',
                        data: {
                            email: customer.email,
                            reference,
                            amount: depositAmountKES,
                            currency: txData.currency,
                            subaccount
                        }
                    });
                } else {
                    return res.status(400).json({
                        success: false,
                        message: 'Transaction failed or currency mismatch',
                        data: {
                            reference,
                            currency: txData.currency,
                            status: txData.status
                        }
                    });
                }

            } catch (error) {
                console.error("Error verifying transaction:", error.response?.data || error.message);
                return res.status(500).json({
                    success: false,
                    message: 'Error verifying transaction with Paystack',
                    error: error.response?.data || error.message
                });
            }
        }

        return res.status(200).json({
            success: true,
            message: 'Webhook event received but ignored',
            event: event.event
        });
    }

    async QueueTimeOutURLcallBack(req, res) {
        this.logPayment(req?.body?.platformID, "MPesa timeout callback received", "info");
        return res.status(200).json({ success: true });
    }

    async PullTransactionsCallback(req, res) {
        this.logPayment(req?.body?.platformID, "MPesa pull callback received", "info");
        return res.status(200).json({ success: true });
    }

    async ResultURLcallBack(req, res) {
        const payload = req?.body || {};
        const result = payload?.Result || payload;
        const originatorId = result?.OriginatorConversationID || result?.originatorConversationID;
        const match = this.resolveDarajaRequest(originatorId);
        const resultCodeRaw = result?.ResultCode ?? result?.resultCode;
        const resultCode = Number(resultCodeRaw);
        const isAlreadyReversedCode = String(resultCodeRaw) === "R000001";
        const shortCodeBalance = this.extractShortCodeBalance(result);
        let platformID = match?.platformID || null;

        // Debug: log full callback payload and parsed context (expand nested objects)
        const expandedPayload = JSON.parse(JSON.stringify(payload || {}));
        console.info("MPesa result callback received", {
            payload: expandedPayload,
            originatorId,
            match,
            resultCodeRaw,
            resultCode,
            isAlreadyReversedCode,
            shortCodeBalance,
            shortCodeBalanceType: typeof shortCodeBalance,
        });
        if (expandedPayload?.Result) {
            console.info("MPesa result parameters", expandedPayload.Result.ResultParameters || null);
            console.info("MPesa reference data", expandedPayload.Result.ReferenceData || null);
        }
        
        if (!platformID && originatorId) {
            const funds = await this.db.getFundsByshortIdentifier(originatorId);
            if (funds?.platformID) {
                platformID = funds.platformID;
            }
        }
        
        if (
            platformID &&
            (resultCode === 0 || isAlreadyReversedCode) &&
            typeof shortCodeBalance === "number" &&
            Number.isFinite(shortCodeBalance)
        ) {
            const updatePayload = { shortCodeBalance: shortCodeBalance.toFixed(2) };
            const updatedFunds = await this.db.updateFunds(platformID, updatePayload);
            console.info("Shortcode balance saved", {
                platformID,
                updatePayload,
                updatedFunds,
            });
            await this.pushDashboardStats(platformID);
        } else {
            console.warn("Shortcode balance not saved", {
                platformID,
                resultCode,
                resultCodeRaw,
                shortCodeBalance,
                hasPlatformID: Boolean(platformID),
                isResultSuccess: resultCode === 0 || isAlreadyReversedCode,
                isBalanceFinite: typeof shortCodeBalance === "number" && Number.isFinite(shortCodeBalance),
            });
        }

        if (match?.type === "reverse") {
            const params = result?.ResultParameters?.ResultParameter || [];
            const originalTx = params.find((item) => item?.Key === "OriginalTransactionID")?.Value;
            const txId = result?.TransactionID || result?.TransID;
            const reversalStatus = isAlreadyReversedCode ? true : (Number.isFinite(resultCode) ? resultCode === 0 : null);
            const targetCode = originalTx || txId;
            if (targetCode && reversalStatus !== null) {
                await this.db.updateMpesaCode(String(targetCode), {
                    reversed: reversalStatus,
                });
            }
        } else if (match?.type === "verify") {
            const params = result?.ResultParameters?.ResultParameter || [];
            const receiptNo = params.find((item) => item?.Key === "ReceiptNo")?.Value;
            const txId = result?.TransactionID || result?.TransID;
            const verifiedStatus = Number.isFinite(resultCode) ? resultCode === 0 : null;
            const targetCode = receiptNo || txId;
            if (targetCode && verifiedStatus !== null) {
                await this.db.updateMpesaCode(String(targetCode), {
                    verified: verifiedStatus,
                });
            }
        }
        if (match?.platformID) {
            socketManager.emitToRoom(`platform-${match.platformID}`, "payments:daraja-result", {
                originatorId,
                type: match.type,
                data: payload,
            });
            this.logPayment(match.platformID, "MPesa result callback received", "info");
        } else {
            this.logPayment(req?.body?.platformID, "MPesa result callback received", "info");
        }
        return res.status(200).json({ success: true });
    }

    async paySMS(req, res) {
        const system = await this.isMaintenanceHappening();
        if (system?.ismaintenance === true) {
            return res.status(200).json({ type: "error", message: system?.reason });
        }

        const { token, phone, amount } = req.body;
        if (!phone || !amount || !token) {
            return res.status(400).json({ type: "error", message: "Missing credentials are required." });
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
        const smswallet = await this.db.getPlatformSMS(platformID)
        if (!smswallet) {
            return res.status(400).json({ success: false, message: "SMS Wallet does not exists!" });
        }

        try {
            let response;
            let checkoutRequestId;

            const collection = this.intasend.collection();
            response = await collection.mpesaStkPush({
                first_name: 'Joe',
                last_name: 'Doe',
                email: 'joe@doe.com',
                host: 'https://novawifi.online/',
                amount: amount,
                phone_number: Utils.formatPhoneNumber(phone),
                api_ref: 'Bill Subscription Payment',
            });

            checkoutRequestId = response?.invoice?.invoice_id;

            if (checkoutRequestId) {
                const mpesaCode = {
                    platformID: platformID,
                    amount: amount.toString(),
                    code: checkoutRequestId,
                    phone: phone,
                    status: "PENDING",
                    reqcode: checkoutRequestId,
                    service: "sms",
                    reason: smswallet.id,
                    type: "deposit"
                };
                const addMpesaCodeTodb = await this.db.addMpesaCode(mpesaCode);
                if (addMpesaCodeTodb) {
                    this.logPayment(platformID, `SMS STK push initiated (ref ${checkoutRequestId})`, "success");
                    return res.status(200).json({
                        success: true,
                        message: "STK Push initiated successfully",
                        checkoutRequestId: checkoutRequestId,
                    });
                }

            }
            this.logPayment(platformID, "Failed to initiate SMS STK push", "error");
            return res.status(400).json({ success: false, message: "Failed to initiate STK Push" });
        } catch (error) {
            console.error('Error initiating STK Push:', error.response?.data || error.message);
            this.logPayment(platformID, `SMS STK push error: ${error.message || "unknown error"}`, "error");
            return res.status(500).json({
                success: false,
                message: "Failed to initiate STK Push",
                error: error.message
            });
        }
    }

    async confirmationURL(req, res) {
        try {
            const payload = req.body || {};
            const shortCode =
                payload.BusinessShortCode ||
                payload.ShortCode ||
                payload.Shortcode ||
                payload.PaybillNumber;
            if (!shortCode) {
                return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
            }

            const config = await this.db.getPlatformConfigByShortCode(shortCode);
            if (!config || !config.platformID) {
                return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
            }

            const platformID = config.platformID;
            const isC2BShortCode = String(config.mpesaC2BShortCode || "") === String(shortCode);
            const shortCodeType = isC2BShortCode ? config.mpesaC2BShortCodeType : config.mpesaShortCodeType;
            const isPaybill = String(shortCodeType || "").toLowerCase() === "paybill";
            this.logPayment(platformID, `Confirmation callback received (shortcode ${shortCode})`, "info");
            if (!config.offlinePayments || !isPaybill) {
                return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
            }

            const accountNumber =
                payload.BillRefNumber ||
                payload.AccountReference ||
                payload.AccountNumber ||
                payload.BillRef;
            const amount = payload.TransAmount || payload.Amount || payload.TransAmount;
            const phone = payload.MSISDN || payload.PhoneNumber || payload.Phone;
            const transId =
                payload.TransID ||
                payload.TransId ||
                payload.TransactionID ||
                payload.TransactionId;

            if (!accountNumber || !amount || !phone) {
                socketManager.log(platformID, "Offline paybill confirmation missing account/amount/phone", {
                    context: "payments",
                    level: "warn",
                });
                return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
            }

            if (transId) {
                const existing = await this.db.getMpesaCode(transId);
                if (existing) {
                    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
                }
            }

            const cleanPhone = Utils.formatPhoneNumber(String(phone));
            const paymentCode = transId || `${shortCode}-${Date.now()}`;
            const accountValue = String(accountNumber).trim();

            const pkg = await this.db.getPackageByAccountNumber(platformID, accountValue);
            if (pkg) {
                await this.db.addMpesaCode({
                    platformID,
                    amount: String(amount),
                    code: paymentCode,
                    phone: cleanPhone,
                    status: "COMPLETE",
                    reqcode: paymentCode,
                    service: "hotspot",
                    type: "deposit",
                    reason: pkg.id,
                    paybill: String(shortCode),
                    account: accountValue,
                    paymentMethod: isC2BShortCode ? "Mpesa C2B" : "unknown",
                });

                const addResult = await this.mikrotik.addManualCode({
                    phone: cleanPhone,
                    packageID: pkg.id,
                    platformID,
                    code: paymentCode,
                    mac: "null",
                    token: "null",
                });

                this.emitRecentPayment(platformID, {
                    id: paymentCode,
                    code: paymentCode,
                    phone: cleanPhone,
                    amount: String(amount),
                    status: "COMPLETE",
                    service: "hotspot",
                    packageName: pkg?.name || null,
                    createdAt: new Date().toISOString(),
                });

                socketManager.log(platformID, `Offline paybill hotspot payment received (${paymentCode})`, {
                    context: "payments",
                    level: addResult?.success ? "success" : "warn",
                });

                return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
            }

            const pppoe = await this.db.getPPPoEByAccountNumber(platformID, accountValue);
            if (pppoe) {
                const now = new Date();
                let expiresAt = null;
                if (pppoe?.period) {
                    const period = String(pppoe.period).toLowerCase();
                    const match = period.match(/^(\d+)\s+(hour|minute|day|month|year)s?$/i);
                    if (match) {
                        const value = parseInt(match[1]);
                        const unit = match[2].toLowerCase();
                        switch (unit) {
                            case "minute":
                                expiresAt = new Date(now.getTime() + value * 60000);
                                break;
                            case "hour":
                                expiresAt = new Date(now.getTime() + value * 3600000);
                                break;
                            case "day":
                                expiresAt = new Date(now.getTime() + value * 86400000);
                                break;
                            case "month":
                                expiresAt = new Date(now.setMonth(now.getMonth() + value));
                                break;
                            case "year":
                                expiresAt = new Date(now.setFullYear(now.getFullYear() + value));
                                break;
                        }
                    }
                }

                await this.db.addMpesaCode({
                    platformID,
                    amount: String(amount),
                    code: paymentCode,
                    phone: cleanPhone,
                    status: "COMPLETE",
                    reqcode: paymentCode,
                    service: "pppoe",
                    type: "deposit",
                    reason: null,
                    referenceID: pppoe.paymentLink || pppoe.id,
                    paybill: String(shortCode),
                    account: accountValue,
                    paymentMethod: isC2BShortCode ? "Mpesa C2B" : "unknown",
                });

                await this.db.updatePPPoE(pppoe.id, {
                    status: "active",
                    expiresAt,
                });

                const enableResult = await this.mikrotik.manageMikrotikPPPoE({
                    platformID,
                    user: pppoe.clientname,
                    host: pppoe.station,
                });

                this.emitRecentPayment(platformID, {
                    id: paymentCode,
                    code: paymentCode,
                    phone: cleanPhone,
                    amount: String(amount),
                    status: "COMPLETE",
                    service: "pppoe",
                    packageName: pppoe?.name || pppoe?.servicename || null,
                    createdAt: new Date().toISOString(),
                });

                socketManager.log(platformID, `Offline paybill PPPoE payment received (${paymentCode})`, {
                    context: "payments",
                    level: enableResult?.success ? "success" : "warn",
                });
            } else {
                socketManager.log(platformID, `Offline paybill payment received but no match (${accountValue})`, {
                    context: "payments",
                    level: "warn",
                });
            }
        } catch (error) {
            console.error("Error handling confirmation URL:", error);
        }
        return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    async validationURL(req, res) {
        this.logPayment(req?.body?.platformID, "Validation callback received", "info");
        return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    async handleShortCodeBalance(req, res) {
        const platformID = req?.body?.platformID;
        this.logPayment(platformID, "Shortcode balance request received", "info");

        if (!platformID) {
            this.logPayment(platformID, "Shortcode balance request missing platformID", "warn");
            return res.status(200).json({ success: false, message: "Missing credentials required!" });
        }

        try {
            const platform = await this.db.getPlatformConfig(platformID);
            if (!platform) {
                this.logPayment(platformID, "Shortcode balance request failed: platform not configured", "warn");
                return res.status(200).json({ success: false, message: "Configure Platform payments to continue!" });
            }

            const IsAPI = platform.IsAPI;
            if (!IsAPI) {
                this.logPayment(platformID, "Shortcode balance request failed: Mpesa API not enabled", "warn");
                return res.status(200).json({ success: false, message: "Configure Platform payments to Mpesa API!" });
            }

            if (platform.mpesaAccountInitiator === "") {
                this.logPayment(platformID, "Shortcode balance request failed: initiator username missing", "warn");
                return res.status(200).json({
                    success: false,
                    message: "Configure Platform payments to Mpesa API Initiator Username!",
                });
            }

            const accessToken = await this.getAccessToken(platform);
            const timestamp = moment().format('YYYYMMDDHHmmss');
            const securityCredential = this.generateSecurityCredential(platform.mpesaAccountInitiatorPassword);

            const postData = {
                Initiator: platform.mpesaAccountInitiator,
                SecurityCredential: securityCredential,
                CommandID: "AccountBalance",
                PartyA: platform.mpesaShortCode,
                IdentifierType: "4",
                Remarks: "Checking balance",
                QueueTimeOutURL: `${process.env.BASE_URL}/mpesa/timeout`,
                ResultURL: `${process.env.BASE_URL}/mpesa/result`,
            };

            // Debug: log request context + key config (no secrets)
            this.logPayment(platformID, "Shortcode balance request context", "info");
            console.info("Shortcode balance request context", {
                platformID,
                mpesaShortCode: platform?.mpesaShortCode,
                mpesaBalanceUrl: this.mpesa.MPESA_BALANCE_URL || "",
                baseUrl: process.env.BASE_URL,
                timestamp,
                isApiEnabled: platform?.IsAPI,
                initiator: platform?.mpesaAccountInitiator || null,
                initiatorPasswordSet: Boolean(platform?.mpesaAccountInitiatorPassword),
                consumerKeySet: Boolean(platform?.mpesaConsumerKey),
                consumerSecretSet: Boolean(platform?.mpesaConsumerSecret),
                passkeySet: Boolean(platform?.mpesaPasskey),
            });

            const response = await axios.post(
                this.mpesa.MPESA_BALANCE_URL || "",
                postData,
                {
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        "Content-Type": "application/json",
                    },
                }
            );

            const mpesadata = response.data;
            // Debug: log response code and type
            console.info("Shortcode balance response", {
                platformID,
                responseCode: mpesadata?.ResponseCode,
                responseCodeType: typeof mpesadata?.ResponseCode,
                response: mpesadata,
            });
            const responseCode = mpesadata?.ResponseCode;
            if (responseCode === 0 || responseCode === "0") {
                await this.db.updateFunds(platformID, {
                    shortIdentifier: mpesadata.OriginatorConversationID,
                });
                this.logPayment(platformID, "Shortcode balance request sent successfully", "success");
                return res.status(200).json({
                    success: true,
                    message: "Balance request sent successfully",
                    data: response.data,
                });
            }

            this.logPayment(platformID, "Shortcode balance request failed", "warn");
            return res.status(200).json({
                success: false,
                message: "Failed to request balance",
                data: response.data,
            });

        } catch (error) {
            console.error("Error requesting balance:", {
                platformID,
                status: error.response?.status,
                data: error.response?.data,
                message: error.message,
            });
            this.logPayment(platformID, "Shortcode balance request error", "error");
            return res.status(200).json({
                success: false,
                message: "Failed to request balance",
                error: error.message,
            });
        }
    }

    async verifyTransaction(req, res) {
        const { token, transactionCode, paymentId } = req.body || {};
        if (!token) {
            return res.status(400).json({ success: false, message: "Missing credentials required!" });
        }

        const auth = await this.auth.AuthenticateRequest(token);
        if (!auth.success) {
            return res.status(401).json({ success: false, message: auth.message });
        }

        const platformID = auth.admin.platformID;
        if (!platformID) {
            return res.status(400).json({ success: false, message: "Missing platformID." });
        }

        const config = await this.db.getPlatformConfig(platformID);
        if (!config || !config.IsAPI) {
            return res.status(400).json({ success: false, message: "Mpesa API not configured." });
        }
        if (!config.mpesaAccountInitiator || !config.mpesaAccountInitiatorPassword) {
            return res.status(400).json({ success: false, message: "Mpesa API initiator credentials missing." });
        }
        if (!this.mpesa.MPESA_TRANSACTION_STATUS_URL) {
            return res.status(500).json({ success: false, message: "MPESA_TRANSACTION_STATUS_URL not set." });
        }

        let txCode = transactionCode;
        if (!txCode && paymentId) {
            const payment = await this.db.getMpesaByID(paymentId);
            if (payment && payment.status !== "COMPLETE") {
                return res.status(400).json({
                    success: false,
                    message: "Only COMPLETE transactions can be verified.",
                });
            }
            txCode = payment?.code || payment?.reqcode || "";
        }
        if (!txCode) {
            return res.status(400).json({ success: false, message: "Transaction code is required." });
        }

        try {
            const accessToken = await this.getAccessToken(config);
            const securityCredential = this.generateSecurityCredential(config.mpesaAccountInitiatorPassword);
            const payload = {
                Initiator: config.mpesaAccountInitiator,
                SecurityCredential: securityCredential,
                CommandID: "TransactionStatusQuery",
                TransactionID: txCode,
                PartyA: config.mpesaShortCode,
                IdentifierType: "4",
                Remarks: "Transaction status query",
                Occasion: "StatusQuery",
                QueueTimeOutURL: `${process.env.BASE_URL}/mpesa/timeout`,
                ResultURL: `${process.env.BASE_URL}/mpesa/result`,
            };

            const response = await axios.post(
                this.mpesa.MPESA_TRANSACTION_STATUS_URL,
                payload,
                {
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        "Content-Type": "application/json",
                    },
                }
            );
            const originatorId = response?.data?.OriginatorConversationID || response?.data?.originatorConversationID;
            if (originatorId) {
                this.storeDarajaRequest(originatorId, platformID, "verify");
            }

            return res.status(200).json({
                success: true,
                message: "Verification request sent successfully",
                data: response.data,
            });
        } catch (error) {
            const diagnosis = this.getUserFriendlyMessage(error?.response?.data?.errorMessage || error?.message);
            return res.status(500).json({
                success: false,
                message: diagnosis || "Verification failed",
                error: error?.response?.data || error?.message,
            });
        }
    }

    async reverseTransaction(req, res) {
        const { token, transactionCode, paymentId, amount } = req.body || {};
        if (!token) {
            return res.status(400).json({ success: false, message: "Missing credentials required!" });
        }

        const auth = await this.auth.AuthenticateRequest(token);
        if (!auth.success) {
            return res.status(401).json({ success: false, message: auth.message });
        }

        const platformID = auth.admin.platformID;
        if (!platformID) {
            return res.status(400).json({ success: false, message: "Missing platformID." });
        }

        const config = await this.db.getPlatformConfig(platformID);
        if (!config || !config.IsAPI) {
            return res.status(400).json({ success: false, message: "Mpesa API not configured." });
        }
        if (!config.mpesaAccountInitiator || !config.mpesaAccountInitiatorPassword) {
            return res.status(400).json({ success: false, message: "Mpesa API initiator credentials missing." });
        }
        if (!this.mpesa.MPESA_REVERSAL_URL) {
            return res.status(500).json({ success: false, message: "MPESA_REVERSAL_URL not set." });
        }

        let txCode = transactionCode;
        let amountValue = amount;
        if ((!txCode || !amountValue) && paymentId) {
            const payment = await this.db.getMpesaByID(paymentId);
            if (payment && payment.status !== "COMPLETE") {
                return res.status(400).json({
                    success: false,
                    message: "Only COMPLETE transactions can be reversed.",
                });
            }
            txCode = txCode || payment?.code || payment?.reqcode || "";
            amountValue = amountValue || payment?.amount || "";
        }
        if (!txCode) {
            return res.status(400).json({ success: false, message: "Transaction code is required." });
        }
        if (!amountValue) {
            return res.status(400).json({ success: false, message: "Amount is required for reversal." });
        }

        try {
            const accessToken = await this.getAccessToken(config);
            const securityCredential = this.generateSecurityCredential(config.mpesaAccountInitiatorPassword);
            const payload = {
                Initiator: config.mpesaAccountInitiator,
                SecurityCredential: securityCredential,
                CommandID: "TransactionReversal",
                TransactionID: txCode,
                Amount: Number(amountValue),
                ReceiverParty: config.mpesaShortCode,
                RecieverIdentifierType: "11",
                Remarks: "Transaction reversal",
                Occasion: "Reversal",
                QueueTimeOutURL: `${process.env.BASE_URL}/mpesa/timeout`,
                ResultURL: `${process.env.BASE_URL}/mpesa/result`,
            };

            const response = await axios.post(
                this.mpesa.MPESA_REVERSAL_URL,
                payload,
                {
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        "Content-Type": "application/json",
                    },
                }
            );
            const originatorId = response?.data?.OriginatorConversationID || response?.data?.originatorConversationID;
            if (originatorId) {
                this.storeDarajaRequest(originatorId, platformID, "reverse");
            }

            return res.status(200).json({
                success: true,
                message: "Reversal request sent successfully",
                data: response.data,
            });
        } catch (error) {
            const diagnosis = this.getUserFriendlyMessage(error?.response?.data?.errorMessage || error?.message);
            return res.status(500).json({
                success: false,
                message: diagnosis || "Reversal failed",
                error: error?.response?.data || error?.message,
            });
        }
    }

    async transferToBusiness(req, res) {
        const { token, amount, destinationType, destinationShortCode, destinationAccount, remarks } = req.body || {};
        if (!token) {
            return res.status(400).json({ success: false, message: "Missing credentials required!" });
        }

        const auth = await this.auth.AuthenticateRequest(token);
        if (!auth.success) {
            return res.status(401).json({ success: false, message: auth.message });
        }

        const platformID = auth.admin.platformID;
        if (!platformID) {
            return res.status(400).json({ success: false, message: "Missing platformID." });
        }

        const config = await this.db.getPlatformConfig(platformID);
        if (!config || !config.IsAPI) {
            return res.status(400).json({ success: false, message: "Mpesa API not configured." });
        }
        if (!config.mpesaAccountInitiator || !config.mpesaAccountInitiatorPassword) {
            return res.status(400).json({ success: false, message: "Mpesa API initiator credentials missing." });
        }
        if (!this.mpesa.MPESA_B2B_URL) {
            return res.status(500).json({ success: false, message: "MPESA_B2B_URL not set." });
        }

        const amt = Number(amount);
        if (!amt || Number.isNaN(amt) || amt <= 0) {
            return res.status(400).json({ success: false, message: "Amount must be greater than 0." });
        }

        const destType = String(destinationType || "").toLowerCase();
        const isPaybill = destType === "paybill";
        const isTill = destType === "till";
        const isPochi = destType === "pochi";
        if (!isPaybill && !isTill && !isPochi) {
            return res.status(400).json({ success: false, message: "Destination type must be Till, Paybill, or Pochi." });
        }
        if (!destinationShortCode) {
            return res.status(400).json({ success: false, message: "Destination shortcode is required." });
        }
        if (isPaybill && !destinationAccount) {
            return res.status(400).json({ success: false, message: "Paybill account number is required." });
        }

        try {
            const accessToken = await this.getAccessToken(config);
            const securityCredential = this.generateSecurityCredential(config.mpesaAccountInitiatorPassword);
            let response;

            if (isPochi) {
                if (!this.mpesa.MPESA_B2POCHI_URL) {
                    return res.status(500).json({ success: false, message: "MPESA_B2POCHI_URL not set." });
                }
                const payload = {
                    OriginatorConversationID: `B2POCHI-${Date.now()}`,
                    InitiatorName: config.mpesaAccountInitiator,
                    SecurityCredential: securityCredential,
                    CommandID: "BusinessPayToPochi",
                    Amount: String(amt),
                    PartyA: config.mpesaShortCode,
                    PartyB: Utils.formatPhoneNumber(destinationShortCode),
                    Remarks: remarks || "Business transfer",
                    QueueTimeOutURL: `${process.env.BASE_URL}/mpesa/timeout`,
                    ResultURL: `${process.env.BASE_URL}/mpesa/result`,
                    Occassion: "Business transfer",
                };
                console.log("B2Pochi request", {
                    url: this.mpesa.MPESA_B2POCHI_URL,
                    payload: {
                        OriginatorConversationID: payload.OriginatorConversationID,
                        InitiatorName: payload.InitiatorName,
                        CommandID: payload.CommandID,
                        Amount: payload.Amount,
                        PartyA: payload.PartyA,
                        PartyB: payload.PartyB,
                        Remarks: payload.Remarks,
                        QueueTimeOutURL: payload.QueueTimeOutURL,
                        ResultURL: payload.ResultURL,
                        Occassion: payload.Occassion,
                    },
                });
                response = await axios.post(
                    this.mpesa.MPESA_B2POCHI_URL,
                    payload,
                    {
                        headers: {
                            Authorization: `Bearer ${accessToken}`,
                            "Content-Type": "application/json",
                        },
                    }
                );
                console.log("B2Pochi response", response?.data);
            } else {
                const commandId = isPaybill ? "BusinessPayBill" : "BusinessBuyGoods";
                const receiverIdentifierType = isPaybill ? "4" : "2";
                const senderIdentifierType = "4";
                const payload = {
                    Initiator: config.mpesaAccountInitiator,
                    SecurityCredential: securityCredential,
                    CommandID: commandId,
                    SenderIdentifierType: senderIdentifierType,
                    RecieverIdentifierType: receiverIdentifierType,
                    Amount: amt,
                    PartyA: config.mpesaShortCode,
                    PartyB: String(destinationShortCode),
                    AccountReference: isPaybill ? String(destinationAccount) : "",
                    Remarks: remarks || "Business transfer",
                    QueueTimeOutURL: `${process.env.BASE_URL}/mpesa/timeout`,
                    ResultURL: `${process.env.BASE_URL}/mpesa/result`,
                };
                response = await axios.post(
                    this.mpesa.MPESA_B2B_URL,
                    payload,
                    {
                        headers: {
                            Authorization: `Bearer ${accessToken}`,
                            "Content-Type": "application/json",
                        },
                    }
                );
            }

            const originatorId = response?.data?.OriginatorConversationID || response?.data?.originatorConversationID;
            if (originatorId) {
                this.storeDarajaRequest(originatorId, platformID, isPochi ? "b2pochi-transfer" : "b2b-transfer");
            }

            const conversationId =
                originatorId ||
                response?.data?.ConversationID ||
                response?.data?.TransID ||
                `${destinationShortCode}-${Date.now()}`;

            await this.db.addMpesaCode({
                platformID,
                amount: String(amt),
                code: conversationId,
                phone: String(destinationShortCode),
                status: "PENDING",
                reqcode: conversationId,
                type: isPochi ? "b2pochi transfer" : "b2b transfer",
                service: isPochi ? "Mpesa B2Pochi" : "Mpesa B2B",
                till: isTill ? String(destinationShortCode) : "null",
                paybill: isPaybill ? String(destinationShortCode) : "null",
                account: isPaybill ? String(destinationAccount) : "null",
                paymentMethod: "Mpesa API",
            });

            return res.status(200).json({
                success: true,
                message: "Transfer request sent successfully",
                data: response.data,
            });
        } catch (error) {
            console.error("B2Pochi/B2B transfer error", {
                status: error?.response?.status,
                data: error?.response?.data,
                message: error?.message,
            });
            const diagnosis = this.getUserFriendlyMessage(error?.response?.data?.errorMessage || error?.message);
            return res.status(500).json({
                success: false,
                message: diagnosis || "Transfer failed",
                error: error?.response?.data || error?.message,
            });
        }
    }

    decodeBuffer(data) {
        if (Buffer.isBuffer(data)) {
            try {
                return JSON.parse(data.toString());
            } catch (e) {
                return data.toString();
            }
        }
        return data;
    };

    parseMpesaBalanceValue(value) {
        if (typeof value === "number" && Number.isFinite(value)) {
            return value;
        }
        if (typeof value !== "string") return null;
        const trimmed = value.trim();
        const direct = parseFloat(trimmed);
        if (Number.isFinite(direct)) return direct;

        // Handle composite balances like "Working Account|KES|100.00|...&Utility Account|KES|..."
        if (trimmed.includes("&") && trimmed.includes("|")) {
            const segments = trimmed.split("&").map((part) => part.trim()).filter(Boolean);
            const candidates = [];
            const namedBalances = {};
            for (const segment of segments) {
                const parts = segment.split("|").map((part) => part.trim());
                if (parts.length >= 3) {
                    const preferred = parseFloat(parts[2]);
                    if (Number.isFinite(preferred)) {
                        candidates.push(preferred);
                        const name = parts[0]?.toLowerCase?.() || "";
                        if (name) {
                            namedBalances[name] = preferred;
                        }
                        continue;
                    }
                }
                for (const part of parts) {
                    const candidate = parseFloat(part);
                    if (Number.isFinite(candidate)) {
                        candidates.push(candidate);
                    }
                }
            }
            // Prefer known buckets in order: Merchant > Working > Utility
            const preferredOrder = ["merchant account", "working account", "utility account"];
            for (const key of preferredOrder) {
                if (Number.isFinite(namedBalances[key])) {
                    return namedBalances[key];
                }
            }
            if (candidates.length > 0) {
                return Math.max(...candidates);
            }
        }

        const parts = trimmed.split("|").map((part) => part.trim());
        const preferredIndexes = [2, 3];
        for (const index of preferredIndexes) {
            const candidate = parseFloat(parts[index]);
            if (Number.isFinite(candidate)) return candidate;
        }

        for (const part of parts) {
            const candidate = parseFloat(part);
            if (Number.isFinite(candidate)) return candidate;
        }

        const match = trimmed.match(/-?\d+(?:\.\d+)?/);
        if (match) {
            const candidate = parseFloat(match[0]);
            if (Number.isFinite(candidate)) return candidate;
        }

        return null;
    }

    extractShortCodeBalance(result) {
        const parameters = result?.ResultParameters?.ResultParameter;
        if (!Array.isArray(parameters)) return null;

        const keys = [
            "DebitAccountBalance",
            "AccountBalance",
            "CreditAccountBalance",
            "WorkingAccountBalance",
            "UtilityAccountBalance",
        ];

        for (const key of keys) {
            const entry = parameters.find((item) => item?.Key === key);
            if (entry && entry.Value !== undefined && entry.Value !== null) {
                return this.parseMpesaBalanceValue(entry.Value);
            }
        }

        return null;
    }

    validateWithdrawalAmount(amount) {
        if (!amount) return false;
        const num = parseFloat(amount);

        if (num > 150000) {
            return false;
        } else if (num < 1) {
            return false;
        } else if (isNaN(num)) {
            return false;
        }
        return true;
    }

    formatPhoneNumber(phone) {
        return Utils.formatPhoneNumber(phone);
    }

    generateSecurityCredential(initiatorPassword) {
        const certPath = path.join(__dirname, "..", "config", "ProductionCertificate.cer");
        const publicKey = fs.readFileSync(certPath, { encoding: "utf8" });
        const buffer = Buffer.from(initiatorPassword);
        const encrypted = crypto.publicEncrypt(
            { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
            buffer
        );
        return encrypted.toString("base64");
    }

    async addCodeToMikrotik(data) {
        const { platformID, packageID, code, password, username, phone } = data;
        const pkg = await this.db.getPackagesByID(packageID);
        if (!pkg) {
            return {
                success: false,
                message: "Failed to add user to MikroTik, Package not found!",
            };
        }
        const { expiresIn } = this.computeExpiryFromPackage(pkg);

        const profileName = pkg.name;
        const hostdata = await this.db.getStations(platformID);
        if (!hostdata) {
            return {
                success: false,
                message: "Failed to add user to MikroTik, Router not found!",
            };
        }
        if (code) {
            const codeexists = await this.db.getUserByUsername(code);
            if (codeexists) {
                return {
                    success: false,
                    message: "Code already exists, try a different one!",
                };
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
            return {
                success: false,
                message: "Failed to add user to MikroTik",
            };
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
            const jwtToken = await this.createHotspotToken(tokenPayload, expiresIn);

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
                        return {
                            success: false,
                            message: "SMS not found!",
                        };
                    }
                    if (sms && sms.sentHotspot === false) return { success: false, message: "Hotspot SMS sending is disabled!" };
                    if (sms.default === true && Number(sms.balance) < Number(sms.costPerSMS)) {
                        return {
                            success: false,
                            message: "Insufficient SMS Balance!",
                        };
                    }

                    const platform = await this.db.getPlatform(platformID)
                    if (!platform) {
                        return {
                            success: false,
                            message: "Platform not found!",
                        };
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

            return {
                success: true,
                message: "Code added successfully",
                code: code,
            };
        }
    }

    async handleSuccessfulPayment(code, txData) {
        const depositAmountKES = txData.amount / 100;
        const reference = txData.receipt_number || txData.code || code;

        const mpesaCode = await this.db.getMpesaByCode(code);
        if (!mpesaCode) {
            console.error("MPesa code not found for:", code);
            return;
        }

        await this.db.updateMpesaCodeByID(mpesaCode.id, {
            code: reference,
            status: "COMPLETE",
            amount: String(depositAmountKES),
            platformID: mpesaCode.platformID,
            type: 'deposit',
        });

        const funds = await this.db.getFunds(mpesaCode.platformID);
        if (funds) {
            const newBalance = parseFloat(funds.balance) + parseFloat(String(depositAmountKES));
            await this.db.updateFunds(mpesaCode.platformID, {
                balance: newBalance.toString(),
                deposits: `${(parseFloat(funds.deposits || 0) + parseFloat(String(depositAmountKES))).toFixed(2)}`
            });
        } else {
            await this.db.createFunds({
                balance: String(depositAmountKES),
                withdrawals: "0",
                deposits: String(depositAmountKES),
                platformID: mpesaCode.platformID
            });
        }

        if (mpesaCode.service === "hotspot") {
            const pkg = await this.db.getPackagesByAmount(mpesaCode.platformID, `${Math.trunc(depositAmountKES)}`, mpesaCode.reason);
            if (!pkg) {
                return;
            }

            const { expiresIn, expiresAtISO } = this.computeExpiryFromPackage(pkg);

            const tokenPayload = {
                phone: mpesaCode.phone,
                username: reference,
                packageID: pkg.id,
                platformID: mpesaCode.platformID,
            };
            const jwtToken = await this.createHotspotToken(tokenPayload, expiresIn);

            const data = {
                token: jwtToken,
                phone: mpesaCode.phone,
                packageID: pkg.id,
                platformID: mpesaCode.platformID,
                package: pkg,
                code: reference,
                mac: reference,
            };

            let addcodetorouter = await this.mikrotik.addManualCode(data);

            if (!addcodetorouter.success) {
                socketManager.emitEvent("deposit-status", {
                    status: "COMPLETE_INACTIVE",
                    checkoutRequestId: code,
                    message: "Payment received, please wait connecting you shortly...",
                    loginCode: reference,
                }, code);

                const startTime = Date.now();
                const timeout = 10000;

                while (Date.now() - startTime < timeout) {
                    addcodetorouter = await this.mikrotik.addManualCode(data);
                    if (addcodetorouter.success) break;
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                }

                if (!addcodetorouter?.success) {
                    socketManager.emitEvent("deposit-status", {
                        status: "INACTIVE",
                        checkoutRequestId: code,
                        message: "Payment received but failed to automatically connect to WIFI. Please connect manually using M-PESA Message.",
                        error: addcodetorouter?.message,
                        loginCode: reference,
                    }, code);
                    return;
                }
            }

            socketManager.emitEvent("deposit-success", {
                status: "COMPLETE",
                checkoutRequestId: code,
                message: "Payment successful!",
                loginCode: reference,
                token: jwtToken,
                expiresAt: expiresAtISO,
            }, code);
        }
    }

    async handleFailedPayment(code) {
        const mpesaCode = await this.db.getMpesaByCode(code);
        if (!mpesaCode) {
            console.error("MPesa code not found for:", code);
            return;
        }

        await this.db.updateMpesaCodeByID(mpesaCode.id, {
            status: "FAILED",
            type: 'deposit'
        });

        socketManager.emitEvent("deposit-status", {
            status: "FAILED",
            checkoutRequestId: code,
            message: "Payment failed"
        }, code);
    }

    async verifyPayments() {
        const collection = this.intasend.collection();

        setInterval(async () => {
            try {
                const pendingTxs = await this.db.getPendingTransactions({ maxAgeMs: 7 * 24 * 60 * 60 * 1000 });

                for (const tx of pendingTxs) {
                    const { reqcode, code } = tx;
                    try {
                        if (code === code.toUpperCase() && code.length < 8) {
                            try {
                                const resp = await collection.status(code);

                                if (resp.invoice?.state === 'COMPLETE') {
                                    await this.handleSuccessfulPayment(code, {
                                        amount: resp.invoice.value * 100,
                                        receipt_number: code,
                                        currency: resp.invoice.currency,
                                        status: 'success',
                                        invoice: resp.invoice,
                                        meta: resp.meta,
                                        code: resp.invoice.invoice_id,
                                        value: resp.invoice.value,
                                        net_amount: resp.invoice.net_amount
                                    });
                                } else if (resp.invoice?.state === 'FAILED') {
                                    await this.handleFailedPayment(resp.invoice.invoice_id);
                                } else {
                                    console.log(`Payment ${code} status:`, resp.invoice?.state || 'unknown');
                                }
                            } catch (intasendError) {
                                console.error(`IntaSend verification error for ${code}:`,
                                    intasendError.response?.data || intasendError.message);
                                continue;
                            }
                        }
                    } catch (error) {
                        console.error(`Error verifying ${code}: `, error);
                    }
                }
            } catch (err) {
                console.error("Error fetching pending transactions:", err.message);
            }
        }, 5 * 1000);
    }

    normalizeIntaSendStatus(state) {
        const stateRaw = String(state || "").toUpperCase();
        if (stateRaw === "COMPLETED" || stateRaw === "SUCCESS" || stateRaw === "COMPLETE") return "COMPLETE";
        if (stateRaw === "FAILED" || stateRaw === "CANCELLED") return "FAILED";
        if (stateRaw === "PROCESSING") return "PROCESSING";
        return "PENDING";
    }

    async fetchIntaSendStatus(invoiceId) {
        try {
            const collection = this.intasend.collection();
            if (collection && typeof collection.status === "function") {
                const response = await collection.status(invoiceId);
                return response?.invoice || response?.data || response;
            }
        } catch (error) {
            console.error("IntaSend status lookup failed:", error?.message || error);
        }
        return null;
    }

    async completePaymentForService(payment) {
        if (!payment || !payment.platformID) return null;
        const platformID = payment.platformID;
        const service = String(payment.service || "hotspot").toLowerCase();

        if (service === "hotspot") {
            if (!payment.reason) return null;
            const existingUser = await this.db.getUserByCodeAndPlatform(payment.code, platformID);
            if (existingUser) {
                return { loginCode: existingUser.username || existingUser.code, status: "COMPLETE" };
            }
            const addResult = await this.mikrotik.addManualCode({
                phone: payment.phone,
                packageID: payment.reason,
                platformID,
                code: payment.code,
                mac: payment.mac || "null",
                token: "null",
            });
            if (addResult?.success) {
                const loginCode = addResult?.code?.username || addResult?.code?.code || payment.code;
                return { loginCode, status: "COMPLETE" };
            }
            return { status: "FAILED", message: addResult?.message || "Activation failed." };
        }

        if (service === "pppoe") {
            const paymentLink = payment.referenceID || payment.reason;
            if (!paymentLink) return null;
            const pppoe = await this.db.getPPPoEByPaymentLink(paymentLink);
            if (!pppoe) return null;

            let expiresAt = null;
            const period = pppoe?.period || "";
            if (period) {
                const now = new Date();
                const match = String(period).toLowerCase().match(/^(\d+)\s+(hour|minute|day|month|year)s?$/i);
                if (match) {
                    const value = parseInt(match[1]);
                    const unit = match[2].toLowerCase();
                    switch (unit) {
                        case "minute":
                            expiresAt = new Date(now.getTime() + value * 60000);
                            break;
                        case "hour":
                            expiresAt = new Date(now.getTime() + value * 3600000);
                            break;
                        case "day":
                            expiresAt = new Date(now.getTime() + value * 86400000);
                            break;
                        case "month":
                            expiresAt = new Date(now.setMonth(now.getMonth() + value));
                            break;
                        case "year":
                            expiresAt = new Date(now.setFullYear(now.getFullYear() + value));
                            break;
                    }
                }
            }

            await this.db.updatePPPoE(pppoe.id, { status: "active", expiresAt });
            await this.mikrotik.manageMikrotikPPPoE({
                platformID,
                user: pppoe.clientname,
                host: pppoe.station,
            });
            return { status: "active" };
        }

        if (service === "bill") {
            const billId = payment.referenceID;
            if (!billId) return null;
            const bill = await this.db.getPlatformBillingByID(billId);
            if (!bill) return null;
            await this.db.updatePlatformBilling(billId, {
                status: "Paid",
                paidAt: new Date(),
                amount: "0",
            });
            return { status: "paid" };
        }

        return null;
    }
}

module.exports = { MpesaController }
