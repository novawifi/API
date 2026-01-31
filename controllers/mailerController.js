// @ts-check

const { MailerConnection } = require("../configs/mailerConfig");
const { DataBase } = require("../helpers/databaseOperation");

class Mailer {
    constructor() {
        this.db = new DataBase();
        this.mailer = new MailerConnection();
    }

    async EmailTemplate(data) {
        const { name, email, message, type, subject, company } = data;

        const settings = await this.db.getSettings();
        if (!settings) {
            return { success: false, message: "Settings not found" };
        }

        const brandName = company || settings.name;
        const emailfrominfo = `${brandName} <info@novawifi.online>`;
        const emailfromaccounts = `${brandName} <accounts@novawifi.online>`;

        const formData = {
            name,
            from: type === "info" ? emailfrominfo : emailfromaccounts,
            to: email,
            subject,
            message,
            company: brandName
        };

        try {
            const result = await this.sendEmail(formData);
            return { success: result.success, message: result.message };
        } catch (error) {
            return { success: false, message: error.message || error };
        }
    };

    async sendEmail(data) {
        const { from, to, subject, message, name, company } = data;
        if (!from || !to || !subject || !message) {
            return {
                success: false,
                message: "Missing required credentials!"
            }
        }
        const emailHtml = `
        <html>
            <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                <h2 style="color: #4CAF50;">Hello ${name || "User"},</h2>
                <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
                  ${message}
                </div>
                <p>Best regards,</p>
                <p><strong>${!company ? 'Nova WiFi' : company}</strong></p>
            </body>
        </html>
    `;
        try {
            const transporter = await this.mailer.transporter();
            const sendmail = await transporter.sendMail({
                from: from,
                to: to,
                subject: subject,
                html: emailHtml,
            });

            return {
                success: true,
                message: "Email sent successfully!",
            };

        } catch (error) {
            console.error("Error sending email:", error);
            return {
                success: false,
                message: `Failed to send email. Please try again later. ${error}`,
            };
        }
    }

    async sendMail(res, req) {
        const { from, to, subject, message, name, company } = req.body;
        if (!from || !to || !subject || !message) {
            return res.json({
                success: false,
                message: "Missing required credentials!"
            })
        }
        const emailHtml = `
        <html>
            <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                <h3 style="color: #4CAF50;">Hello ${name || "User"},</h3>
                <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
                  ${message}
                </div>
                <p>Best regards,</p>
                <p><strong>${!company ? 'Nova WiFi' : company}</strong></p>
            </body>
        </html>
    `;
        try {
            const transporter = await this.mailer.transporter();
            const sendmail = await transporter.sendMail({
                from: from,
                to: to,
                subject: subject,
                html: emailHtml,
            });

            return res.json({
                success: true,
                message: "Email sent successfully!",
            });

        } catch (error) {
            console.error("Error sending email:", error);
            return res.json({
                success: false,
                message: "Failed to send email. Please try again later.",
            });
        }
    }
}

module.exports = { Mailer };