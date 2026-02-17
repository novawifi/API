const axios = require("axios");
const { SMSConnection } = require("../configs/smsConfig");
const { Utils } = require("../utils/Functions");

class SMS {
    constructor() {
        this.configs = new SMSConnection();
    }

    async sendSMS(phone, msg, sms) {
        if (!phone || !msg || !sms) {
            return { success: false, message: "Missing credentials required" };
        }

        try {
            let url;
            let payload = {
                apikey: sms?.default === false ? sms?.apiKey : this.configs.API_KEY,
                partnerID: sms?.default === false ? sms?.patnerID : this.configs.PATNER_ID,
                message: msg,
                shortcode: sms?.senderID || "TextSMS",
                mobile: Utils.formatPhoneNumber(phone),
            };

            if (sms.provider === "TextSMS" || !sms.provider) {
                url = this.configs.SEND_SMS_URL || "";
            } else if (sms.provider === "AdvantaSMS") {
                url = this.configs.ADVANTA_SMS_URL || "";
            } else if (sms.provider === "AfrinetSMS") {
                url = this.configs.AFRINET_SMS_URL || "";
            } else if (sms.provider === "TechcribSMS") {
                url = this.configs.TECHCRIB_SMS_URL || "";
            } else if (sms.provider === "JazaSMS") {
                url = this.configs.JAZA_SMS_URL || "";
            } else {
                return { success: false, message: "Unsupported SMS provider" };
            }

            const response = await axios.post(url, payload, {
                headers: { "Content-Type": "application/json" },
            });

            const { status, data } = response;
            if (status !== 200) {
                return { success: false, message: `HTTP ${status}` };
            }

            const resp = Array.isArray(data?.responses)
                ? data.responses[0]
                : data;

            const success =
                Number(resp?.["response-code"]) === 200 ||
                String(resp?.["response-description"]).toLowerCase() === "success";

            const message =
                resp?.["response-description"] ||
                resp?.message ||
                "Message sent successfully";

            return { success, message };

        } catch (err) {
            console.error("SMS Error:", err?.response?.data || err.message);
            return {
                success: false,
                message: err?.response?.data?.message || "Failed to send SMS"
            };
        }
    };

    async sendInternalSMS(phone, message) {
        const API_URL = process.env.UMS_SMS_API_URL || "https://comms.umeskiasoftwares.com/api/v1/sms/send";
        if (!phone || !message) {
            return { success: false, message: "Missing credentials required" };
        }

        const formatted = Utils.formatPhoneNumber(phone);
        if (!formatted) {
            return { success: false, message: "Invalid phone number" };
        }

        const payload = {
            api_key: process.env.UMS_API_KEY,
            app_id: process.env.UMS_APP_ID,
            sender_id: process.env.UMS_SENDER_ID || "UMS_TX",
            message,
            phone: formatted
        };

        try {
            const response = await fetch(API_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            const result = await response.json();

            if (result.status !== "complete") {
                console.error("SMS FAILED:", result);
                return { success: false, message: "SMS failed to send", result };
            }

            return { success: true, message: "SMS sent successfully", result };
        } catch (error) {
            console.error("SMS API ERROR:", error);
            return { success: false, message: "SMS API error", error: error?.message || error };
        }
    }

    async sendStationDownSMS(stationName, ip, phone) {
        const message = `ALERT FROM NOVAWIFI: Station-> ${stationName} (${ip}) is unreachable at ${new Date().toLocaleString()}. Please check power or internet link.`;
        return this.sendInternalSMS(phone, message);
    }
}

module.exports = { SMS }
