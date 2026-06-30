
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
                    const trailingPunctuation = match.match(/[.,!?;:]+$/)?.[0] || "";
                    const url = trailingPunctuation ? match.slice(0, -trailingPunctuation.length) : match;
                    const lower = url.toLowerCase();
                    let label = "Open Link";
                    if (lower.includes("/admin") || lower.includes("dashboard")) {
                        label = "Open Dashboard";
                    } else if (lower.includes("login")) {
                        label = "Open Login";
                    }
                    return `<a href="${url}">${label}</a>${trailingPunctuation}`;
                });
        }
        return this.formatLinksAsButtons(html);
    }

    buildEmailHtml({ name, message, company }) {
        const brandName = company || "Nova WiFi";
        const legalName = "NOVA NETCORE SYSTEMS";
        const safeMessage = this.normalizeEmailMessage(message);
        return `
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>${brandName}</title>
            <style>
              body {
                margin: 0;
                padding: 0;
                background-color: #f5f7fa;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
                color: #2c3e50;
              }
              .email-container {
                max-width: 600px;
                margin: 0 auto;
                background: #ffffff;
                border-radius: 12px;
                overflow: hidden;
                box-shadow: 0 4px 6px rgba(0, 0, 0, 0.07), 0 10px 20px rgba(0, 0, 0, 0.08);
              }
              .header-box {
                background: linear-gradient(135deg, #0077cc 0%, #0057a0 100%);
                padding: 32px 24px;
                text-align: center;
                border-bottom: 4px solid #0055a0;
              }
              .brand-name {
                font-size: 28px;
                font-weight: 700;
                color: #ffffff;
                margin: 0;
                letter-spacing: -0.5px;
              }
              .greeting-box {
                padding: 32px 24px;
              }
              .greeting-text {
                margin: 0 0 20px 0;
                font-size: 16px;
                font-weight: 600;
                color: #2c3e50;
              }
              .content-box {
                padding: 24px;
                background: #f9fbfc;
                border-left: 4px solid #0077cc;
                border-radius: 6px;
                margin: 0 0 24px 0;
              }
              .message-content {
                font-size: 15px;
                line-height: 1.8;
                color: #555a62;
                margin: 0;
              }
              .message-content p {
                margin: 0 0 16px 0;
              }
              .message-content p:last-child {
                margin-bottom: 0;
              }
              .message-content a {
                color: #0077cc;
                text-decoration: none;
                font-weight: 600;
                transition: color 0.2s;
              }
              .message-content a:hover {
                color: #0055a0;
              }
              .cta-button {
                display: inline-block;
                padding: 12px 28px;
                background: #0077cc;
                color: #ffffff !important;
                text-decoration: none !important;
                border-radius: 6px;
                font-weight: 600;
                font-size: 15px;
                margin: 16px 0 0 0;
                transition: background 0.2s;
              }
              .cta-button:hover {
                background: #0055a0;
              }
              .divider {
                height: 1px;
                background: #e8ecf1;
                margin: 24px 0;
              }
              .signature-box {
                padding: 0;
                color: #7f8c8d;
                font-size: 14px;
              }
              .signature-box p {
                margin: 0 0 8px 0;
              }
              .signature-name {
                color: #2c3e50;
                font-weight: 600;
              }
              .footer-box {
                background: #f9fbfc;
                padding: 20px 24px;
                border-top: 1px solid #e8ecf1;
                text-align: center;
              }
              .footer-text {
                margin: 0;
                font-size: 13px;
                color: #7f8c8d;
                line-height: 1.6;
              }
              .footer-text a {
                color: #0077cc;
                text-decoration: none;
                font-weight: 600;
              }
              .footer-text a:hover {
                text-decoration: underline;
              }
              .copyright {
                margin-top: 12px;
                padding-top: 12px;
                border-top: 1px solid #e8ecf1;
                font-size: 12px;
                color: #bdc3c7;
              }
            </style>
          </head>
          <body>
            <div style="padding: 20px;">
              <div class="email-container">
                <!-- Header -->
                <div class="header-box">
                  <h1 class="brand-name">${brandName}</h1>
                </div>

                <!-- Main Content -->
                <div style="padding: 40px 24px;">
                  <p class="greeting-text">Hello ${name || "Valued User"},</p>
                  
                  <div class="content-box">
                    <div class="message-content">
                      ${safeMessage}
                    </div>
                  </div>

                  <!-- Signature -->
                  <div class="signature-box">
                    <p>Best regards,</p>
                    <p class="signature-name">${brandName} Team</p>
                  </div>
                </div>

                <!-- Footer -->
                <div class="footer-box">
                  <p class="footer-text">
                    <strong>Need assistance?</strong><br/>
                    Contact our support team at <a href="mailto:support@novawifi.co.ke">support@novawifi.co.ke</a>
                  </p>
                  <div class="copyright">
                    &copy; ${new Date().getFullYear()} ${legalName}. All rights reserved.<br/>
                    We value your business and are here to help.
                  </div>
                </div>
              </div>
            </div>
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
        const emailfrominfo = `${brandName} <info@novawifi.co.ke>`;
        const emailfromaccounts = `${brandName} <accounts@novawifi.co.ke>`;

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

            const accepted = Array.isArray(sendmail?.accepted) ? sendmail.accepted : [];
            const rejected = Array.isArray(sendmail?.rejected) ? sendmail.rejected : [];
            const pending = Array.isArray(sendmail?.pending) ? sendmail.pending : [];
            if (rejected.length > 0 || accepted.length === 0) {
                return {
                    success: false,
                    message: rejected.length > 0
                        ? `Email rejected by SMTP for: ${rejected.join(", ")}`
                        : "SMTP did not accept any recipient.",
                    accepted,
                    rejected,
                    pending,
                    messageId: sendmail?.messageId || null,
                    response: sendmail?.response || null,
                };
            }

            return {
                success: true,
                message: "Email sent successfully!",
                accepted,
                rejected,
                pending,
                messageId: sendmail?.messageId || null,
                response: sendmail?.response || null,
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
      const emailfrominfo = `${brandName} <info@novawifi.co.ke>`;
      const emailfromaccounts = `${brandName} <accounts@novawifi.co.ke>`;
      const emailfromsupport = process.env.INTERNAL_EMAIL_FROM || `${brandName} <support@novawifi.co.ke>`;

      // allow caller to override sender via data.from (full "Name <email@...>")
      // or pick via data.fromType: 'info' | 'accounts' | 'support'
      const { fromType, from: fromOverride } = data || {};
      let selectedFrom = emailfromsupport;
      if (fromOverride && String(fromOverride).trim()) {
        selectedFrom = String(fromOverride).trim();
      } else if (fromType === "info") {
        selectedFrom = emailfrominfo;
      } else if (fromType === "accounts") {
        selectedFrom = emailfromaccounts;
      } else {
        selectedFrom = emailfromsupport;
      }

      return this.sendEmail({
        from: selectedFrom,
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
