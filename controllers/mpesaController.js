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
const { Socket } = require("./socketController");
const { MpesaConfig } = require("../configs/mpesaConfig");


class MpesaController {
    constructor() {
        this.intasend = new IntaSend(
            process.env.INTASEND_PUBLISHABLE_KEY,
            process.env.INTASEND_SECRET_KEY,
            this.ENVIRONMENT === "production" ? false : true,
        );
        this.ENVIRONMENT = process.env.ENVIRONMENT;
        this.PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

        this.db = new DataBase();
        this.auth = new Auth();
        this.socket = new Socket();
        this.mpesa = new MpesaConfig();
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
            throw error;
        }
    };

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

    async isBlocked(phone) {
        if (!phone) return null;
        try {
            const user = await this.db.getBlockedUserByPhone(phone);
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

    async registerURL() {
        try {
            const platforms = await this.db.getAllPlatforms();
            for (const platform of platforms) {
                try {
                    const platformID = platform.platformID;
                    const config = await this.db.getPlatformConfig(platformID);
                    if (!config) continue;

                    if (config.offlinePayments === true || config.registeredURL === false || config.IsAPI === true) {
                        const shortCode = config.mpesaShortCode;
                        const accessToken = await this.getAccessToken(platform);

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

        const { phone, amount, pkg, mac, platformID } = req.body;
        if (!phone || !amount) {
            return res.status(400).json({
                success: false,
                message: "Phone number and amount are required."
            });
        }

        const Blocked = await this.isBlocked(phone);
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

            const C2B = platform.IsC2B;
            const API = platform.IsAPI;
            const B2B = platform.IsB2B;
            const shortCode = platform.mpesaShortCode;
            const shortCodetype = platform.mpesaShortCodeType;

            let response;
            let checkoutRequestId;

            if (C2B) {
                // const apiUrl = "https://apicrane.tonightleads.com/api/mpesa-deposit/initiate";
                // const bodyData = {
                //     mpesaNumber: formatPhoneNumber(phone),
                //     amount: amount,
                //     paymentType: shortCodetype === "paybill" ? 'CustomerPayBillOnline' : 'CustomerBuyGoods',
                //     tillOrPaybill: shortCode,
                //     accountNumber: shortCodetype === "paybill" ? shortCode : '',
                //     callback: process.env.MPESA_CALLBACK_URL,
                //     token: "test-token",
                // };
                // response = await axios.post(apiUrl, bodyData);
                // checkoutRequestId = response.data?.CheckoutRequestID;
                // console.log("Subaccount code:", platform.mpesaSubAccountCode);

                const response = await axios.post(
                    'https://api.paystack.co/transaction/initialize',
                    {
                        email: `${phone}@novawifi.online`,
                        amount: parseFloat(amount) * 100,
                        subaccount: platform.mpesaSubAccountCode,
                        callback_url: '',
                        currency: "KES"
                    },
                    {
                        headers: {
                            Authorization: `Bearer ${this.PAYSTACK_SECRET_KEY}`,
                            'Content-Type': 'application/json'
                        }
                    }
                );
                const mpesaCode = {
                    platformID: platformID,
                    amount: amount,
                    code: response.data.data.reference,
                    phone: phone,
                    status: "PENDING",
                    reqcode: response.data.data.reference,
                    service: "hotspot",
                    type: "deposit",
                    reason: pkg.id
                };
                const addMpesaCodeTodb = await this.db.addMpesaCode(mpesaCode);
                if (addMpesaCodeTodb) {
                    return res.status(200).json({
                        success: true,
                        message: "STK Push initiated successfully",
                        data: {
                            checkoutRequestId: response.data.data.reference,
                            authorization_url: response.data.data.authorization_url
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
                    return res.status(200).json({
                        success: true,
                        message: "STK Push initiated successfully",
                        data: {
                            checkoutRequestId: checkoutRequestId,
                        }
                    });
                }
            }
            return res.status(400).json({
                success: false,
                message: "Failed to initiate STK Push"
            });
        } catch (error) {
            console.error('Error initiating STK Push:', this.decodeBuffer(error));
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
        let amount = 0;
        amount = Number(pkg.amount) > 0 ? pkg.amount : pkg.price;
        const platformID = pkg.platformID;
        if (!pkg) {
            return res.status(400).json({
                success: false,
                message: "PPPoE Package does not exists!"
            });
        }

        try {
            const platform = await this.db.getPlatformConfig(platformID);
            if (!platform) {
                return res.status(400).json({
                    success: false,
                    message: "Configure Platform payments to continue!"
                });
            }

            const C2B = platform.IsC2B;
            const API = platform.IsAPI;
            const B2B = platform.IsB2B;
            const shortCode = platform.mpesaShortCode;
            const shortCodetype = platform.mpesaShortCodeType;

            let response;
            let checkoutRequestId;

            if (C2B) {
                // const apiUrl = "https://apicrane.tonightleads.com/api/mpesa-deposit/initiate";
                // const bodyData = {
                //     mpesaNumber: formatPhoneNumber(phone),
                //     amount: amount,
                //     paymentType: shortCodetype === "paybill" ? 'CustomerPayBillOnline' : 'CustomerBuyGoods',
                //     tillOrPaybill: shortCode,
                //     accountNumber: shortCodetype === "paybill" ? shortCode : '',
                //     callback: process.env.MPESA_CALLBACK_URL,
                //     token: "test-token",
                // };
                // response = await axios.post(apiUrl, bodyData);
                // checkoutRequestId = response.data?.CheckoutRequestID;
                // console.log("Subaccount code:", platform.mpesaSubAccountCode);

                const response = await axios.post(
                    'https://api.paystack.co/transaction/initialize',
                    {
                        email: `${phone}@novawifi.online`,
                        amount: Number(amount) * 100,
                        subaccount: platform.mpesaSubAccountCode,
                        callback_url: '',
                        currency: "KES"
                    },
                    {
                        headers: {
                            Authorization: `Bearer ${this.PAYSTACK_SECRET_KEY}`,
                            'Content-Type': 'application/json'
                        }
                    }
                );
                const mpesaCode = {
                    platformID: platformID,
                    amount: amount,
                    code: response.data.data.reference,
                    phone: phone,
                    status: "PENDING",
                    reqcode: response.data.data.reference,
                    service: "pppoe",
                    reason: paymentLink,
                    type: "deposit"
                };
                const addMpesaCodeTodb = await this.db.addMpesaCode(mpesaCode);
                if (addMpesaCodeTodb) {
                    return res.status(200).json({
                        success: true,
                        message: "STK Push initiated successfully",
                        data: {
                            checkoutRequestId: response.data.data.reference,
                            authorization_url: response.data.data.authorization_url
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
                    reason: paymentLink,
                    type: "deposit"
                };
                const addMpesaCodeTodb = await this.db.addMpesaCode(mpesaCode);
                if (addMpesaCodeTodb) {
                    return res.status(200).json({
                        success: true,
                        message: "STK Push initiated successfully",
                        data: {
                            checkoutRequestId: checkoutRequestId,
                        }
                    });
                }
            }

            return res.status(400).json({
                success: false,
                message: "Failed to initiate STK Push"
            });
        } catch (error) {
            console.error('Error initiating STK Push:', error.response?.data || error.message);
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
        const payingmonths = Number(months) || 0;
        const amount = Number(bill.amount) + (Number(bill.price * Number(payingmonths)));
        if (!bill) {
            return res.status(400).json({
                success: false,
                message: "Bill does not exist!"
            });
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
                    service: "bill",
                    reason: bill.id,
                    type: "deposit"
                };
                const addMpesaCodeTodb = await this.db.addMpesaCode(mpesaCode);
                if (addMpesaCodeTodb) {
                    return res.status(200).json({
                        success: true,
                        message: "STK Push initiated successfully",
                        data: {
                            checkoutRequestId: checkoutRequestId,
                        }
                    });
                }

            }
            return res.status(400).json({
                success: false,
                message: "Failed to initiate STK Push"
            });
        } catch (error) {
            console.error('Error initiating STK Push:', error.response?.data || error.message);
            return res.status(500).json({
                success: false,
                message: "Failed to initiate STK Push",
                error: error.message
            });
        }
    };

    async callBack(req, res) {
        return res.status(200).json({ success: true });
    }

    async WithdrawFunds(req, res) {
        return res.status(200).json({ success: false, message: "Withdraw handler not available" });
    }

    async handleIntasendCallback(req, res) {
        return res.status(200).json({ success: false, message: "IntaSend callback handler not available" });
    }

    async handleIntasendDepositCallback(req, res) {
        return res.status(200).json({ success: false, message: "IntaSend deposit handler not available" });
    }

    async checkPayment(req, res) {
        return res.status(200).json({ success: false, message: "Payment check handler not available" });
    }

    async handlePaystackDepositCallback(req, res) {
        return res.status(200).json({ success: false, message: "Paystack deposit handler not available" });
    }

    async QueueTimeOutURLcallBack(req, res) {
        return res.status(200).json({ success: true });
    }

    async ResultURLcallBack(req, res) {
        return res.status(200).json({ success: true });
    }

    async paySMS(req, res) {
        return res.status(200).json({ success: false, message: "SMS payment handler not available" });
    }

    async confirmationURL(req, res) {
        return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    async validationURL(req, res) {
        return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    async handleShortCodeBalance(req, res) {
        return res.status(200).json({ success: true });
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
}

module.exports = { MpesaController }
