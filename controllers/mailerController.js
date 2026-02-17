// @ts-check

const { MailerConnection } = require("../configs/mailerConfig");
const { DataBase } = require("../helpers/databaseOperation");

class Mailer {
    constructor() {
        this.db = new DataBase();
        this.mailer = new MailerConnection();
    }

    formatLinksAsButtons(html) {
        if (!html) return html;
        const buttonStyle = "display:inline-block;padding:12px 18px;background:#0ea5e9;color:#ffffff;text-decoration:none;border-radius:4px;font-weight:600;";
        return html.replace(/<a\s+([^>]*?)>/gi, (match, attrs) => {
            if (!/href=/i.test(attrs)) return match;
            let nextAttrs = attrs;
            if (/style=/i.test(nextAttrs)) {
                nextAttrs = nextAttrs.replace(/style=["']([^"']*)["']/i, (m, styleValue) => `style="${styleValue}; ${buttonStyle}"`);
            } else {
                nextAttrs += ` style="${buttonStyle}"`;
            }
            if (!/target=/i.test(nextAttrs)) nextAttrs += ' target="_blank"';
            if (!/rel=/i.test(nextAttrs)) nextAttrs += ' rel="noopener noreferrer"';
            return `<a ${nextAttrs}>`;
        });
    }

    normalizeEmailMessage(message) {
        if (!message) return "";
        const hasHtmlTag = /<\/?[a-z][\s\S]*>/i.test(message);
        let html = message;
        if (!hasHtmlTag) {
            html = html
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/\n/g, "<br />")
                .replace(/(https?:\/\/[^\s<]+)/g, (match) => {
                    const lower = match.toLowerCase();
                    let label = "Open Link";
                    if (lower.includes("/admin") || lower.includes("dashboard")) {
                        label = "Open Dashboard";
                    } else if (lower.includes("login")) {
                        label = "Open Login";
                    }
                    return `<a href="${match}">${label}</a>`;
                });
        }
        return this.formatLinksAsButtons(html);
    }

    buildEmailHtml({ name, message, company }) {
        const brandName = company || "Nova WiFi";
        const safeMessage = this.normalizeEmailMessage(message);
        return `
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>${brandName}</title>
          </head>
          <body style="margin:0;padding:0;background-color:#0b1220;font-family:'Poppins', Arial, sans-serif;color:#0f172a;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#0b1220;padding:24px 0;">
              <tr>
                <td align="center">
                  <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:600px;max-width:92%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 10px 30px rgba(2,6,23,0.35);">
                    <tr>
                      <td style="padding:18px 24px;background:#1f2937;color:#ffffff;">
                        <h1 style="margin:0;font-size:20px;letter-spacing:0.5px;">${brandName}</h1>
                        
                      </td>
                    </tr>
                    <tr>
                      <td style="padding:28px 24px 12px 24px;">
                        <h2 style="margin:0 0 12px 0;font-size:18px;color:#0f172a;">Hello ${name || "User"},</h2>
                        <div style="font-size:14px;line-height:1.7;color:#334155;">
                          ${safeMessage}
                        </div>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding:18px 24px 26px 24px;">
                        <p style="margin:0;font-size:13px;color:#475569;">Best regards,</p>
                        <p style="margin:4px 0 0 0;font-size:13px;color:#0f172a;font-weight:600;">${brandName}</p>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding:14px 24px;background:#f1f5f9;">
                        <p style="margin:0;font-size:12px;color:#64748b;">
                          Need help? Contact support at <a href="mailto:support@novawifi.online" style="color:#0ea5e9;text-decoration:none;font-weight:600;">support@novawifi.online</a>
                        </p>
                      </td>
                    </tr>
                  </table>
                  <p style="margin:16px 0 0 0;font-size:11px;color:#94a3b8;">© ${brandName}. All rights reserved.</p>
                </td>
              </tr>
            </table>
          </body>
        </html>
        `;
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
        const emailHtml = this.buildEmailHtml({
            name,
            message,
            company
        });
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

    async sendInternalEmail(data) {
        const { to, subject, message, name, company } = data || {};
        if (!to || !subject || !message) {
            return { success: false, message: "Missing required credentials!" };
        }
        const settings = await this.db.getSettings();
        const brandName = company || settings?.name || "Nova WiFi";
        const supportFrom = process.env.INTERNAL_EMAIL_FROM || `${brandName} <support@novawifi.online>`;
        return this.sendEmail({
            from: supportFrom,
            to,
            subject,
            message,
            name,
            company: brandName
        });
    }

    async sendMail(res, req) {
        const { from, to, subject, message, name, company } = req.body;
        if (!from || !to || !subject || !message) {
            return res.json({
                success: false,
                message: "Missing required credentials!"
            })
        }
        const emailHtml = this.buildEmailHtml({
            name,
            message,
            company
        });
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
