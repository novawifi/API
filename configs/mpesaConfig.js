class MpesaConfig {
    constructor() {
            this.MPESA_CALLBACK_URL = process.env.MPESA_CALLBACK_URL,
            this.MPESA_AUTH_URL = process.env.MPESA_AUTH_URL,
            this.MPESA_STK_URL = process.env.MPESA_STK_URL,
            this.MPESA_BALANCE_URL = process.env.MPESA_BALANCE_URL,
            this.MPESA_B2B_URL = process.env.MPESA_B2B_URL,
            this.MPESA_B2POCHI_URL = process.env.MPESA_B2POCHI_URL,
            this.MPESA_TRANSACTION_STATUS_URL = process.env.MPESA_TRANSACTION_STATUS_URL,
            this.MPESA_REVERSAL_URL = process.env.MPESA_REVERSAL_URL,
            this.BASE_URL = process.env.BASE_URL,
            this.MPESA_REGISTER_URL = process.env.MPESA_REGISTER_URL,
            this.MPESA_PULL_REGISTER_URL = process.env.MPESA_PULL_REGISTER_URL,
            this.MPESA_PULL_QUERY_URL = process.env.MPESA_PULL_QUERY_URL
    }
}

module.exports = { MpesaConfig };
