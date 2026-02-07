class MpesaConfig {
    constructor() {
            this.MPESA_CALLBACK_URL = process.env.MPESA_CALLBACK_URL,
            this.MPESA_AUTH_URL = process.env.MPESA_AUTH_URL,
            this.MPESA_STK_URL = process.env.MPESA_STK_URL,
            this.MPESA_BALANCE_URL = process.env.MPESA_BALANCE_URL,
            this.MPESA_B2B_URL = process.env.MPESA_B2B_URL,
            this.BASE_URL = process.env.BASE_URL,
            this.MPESA_REGISTER_URL = process.env.MPESA_REGISTER_URL
    }
}

module.exports = { MpesaConfig };
