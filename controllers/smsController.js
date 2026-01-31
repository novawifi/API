
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
}

module.exports = { SMS }