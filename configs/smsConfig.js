// @ts-check

class SMSConnection {
  constructor() {
    this.API_KEY = process.env.TEXT_SMS_API_KEY;
    this.PATNER_ID = process.env.TEXT_SMS_PATNER_ID;
    this.SEND_SMS_URL = process.env.TEXT_SMS_SEND_SMS_URL;
    this.ADVANTA_SMS_URL = process.env.ADVANTA_SMS_SEND_SMS_URL;
  }

  async configs() {
    return {
      API_KEY: this.API_KEY,
      PATNER_ID: this.PATNER_ID,
      SEND_SMS_URL: this.SEND_SMS_URL,
      ADVANTA_SMS_URL: this.ADVANTA_SMS_URL,
    };
  };
};

module.exports = { SMSConnection };
