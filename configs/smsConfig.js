// @ts-check

class SMSConnection {
  constructor() {
    this.API_KEY = process.env.TEXT_SMS_API_KEY;
    this.PATNER_ID = process.env.TEXT_SMS_PATNER_ID;
    this.SEND_SMS_URL = process.env.TEXT_SMS_SEND_SMS_URL || "https://sms.textsms.co.ke/api/services/sendsms/";
    this.ADVANTA_SMS_URL = process.env.ADVANTA_SMS_SEND_SMS_URL || "https://quicksms.advantasms.com/api/services/sendsms/";
    this.AFRINET_SMS_URL = process.env.AFRINET_SMS_SEND_SMS_URL || "https://sms.imarabiz.com/api/services/sendsms/";
    this.TECHCRIB_SMS_URL = process.env.TECHCRIB_SMS_SEND_SMS_URL || "https://bulksms.techcrib.co.ke/api/services/sendsms/";
    this.JAZA_SMS_URL = process.env.JAZA_SMS_SEND_SMS_URL || "https://sms.jazaafrica.com/api/services/sendsms/";
  }

  async configs() {
    return {
      API_KEY: this.API_KEY,
      PATNER_ID: this.PATNER_ID,
      SEND_SMS_URL: this.SEND_SMS_URL,
      ADVANTA_SMS_URL: this.ADVANTA_SMS_URL,
      AFRINET_SMS_URL: this.AFRINET_SMS_URL,
      TECHCRIB_SMS_URL: this.TECHCRIB_SMS_URL,
      JAZA_SMS_URL: this.JAZA_SMS_URL,
    };
  };
};

module.exports = { SMSConnection };
