//@ts-check

const nodemailer = require('nodemailer');

class MailerConnection {
    constructor() {
        this.user = process.env.SES_MAILER_USERNAME || process.env.MAILER_USERNAME || "";
        this.pass = process.env.SES_MAILER_PASSWORD || process.env.MAILER_PASSWORD || "";
        this.host = process.env.SES_MAILER_URL || process.env.MAILER_URL || "";
        this.port = 465;
    }

    async transporter() {
        return nodemailer.createTransport({
            host: this.host,
            port: this.port,
            secure: true,
            auth: {
                user: this.user,
                pass: this.pass,
            },
            connectionTimeout: 20000,
            logger: true,
            debug: true
        });
    };

}

module.exports = { MailerConnection };