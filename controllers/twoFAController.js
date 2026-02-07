const speakeasy = require("speakeasy");
const qrcode = require("qrcode");
const jwt = require("jsonwebtoken");
const { DataBase } = require("../helpers/databaseOperation");
const { Auth } = require("./authController");

class TwoFAController {
    constructor() {
        this.db = new DataBase();
        this.auth = new Auth();
    }

    generateKey(companyName = "NovaWifi", adminEmail = "Admin") {
        try {
            return speakeasy.generateSecret({
                length: 20,
                name: `${companyName} : ${adminEmail}`,
                issuer: companyName,
            });
        } catch (error) {
            console.error("Error generating secret:", error);
            return null;
        }
    }

    async generateQR(secret) {
        try {
            if (!secret?.otpauth_url) {
                throw new Error("Missing otpauth_url in secret");
            }
            const qrCodeDataURL = await qrcode.toDataURL(secret.otpauth_url);
            return {
                qrCodeDataURL,
                secret: secret.base32,
                otpauth_url: secret.otpauth_url,
            };
        } catch (error) {
            console.error("Error generating QR code:", error);
            return null;
        }
    }

    verifyToken(secret, userToken) {
        try {
            return speakeasy.totp.verify({
                secret,
                encoding: "base32",
                token: userToken,
                window: 1,
            });
        } catch (error) {
            console.error("Error verifying token:", error);
            return false;
        }
    }

    async GenerateSecretKey(req, res) {
        try {
            const secret = await this.generateKey();
            if (!secret) {
                return res.json({
                    message: "An error occurred",
                    success: false,
                });
            }
            return res.json({
                message: "Secret Key generated",
                secret_key: secret,
                success: true,
            });
        } catch (error) {
            return res.json({
                message: "An error occurred",
                success: false,
                error: error.message,
            });
        }
    }

    async GenerateQRCode(req, res) {
        const { secret } = req.body;
        try {
            const qr = await this.generateQR(secret);
            if (!qr) {
                return res.json({
                    message: "Failed to generate QR Code",
                    success: false,
                });
            }
            return res.json({
                message: "2FA Secret and QR Code generated",
                secret_key: qr.secret,
                otpauth_url: qr.otpauth_url,
                qr_code: qr.qrCodeDataURL,
                success: true,
            });
        } catch (error) {
            return res.json({
                message: "Failed to generate QR Code",
                success: false,
                error: error.message,
            });
        }
    }

    async Verify2FAToken(req, res) {
        try {
            const { otpCode, token, device, ip } = req.body;

            if (!otpCode || !token) {
                return res.status(400).json({
                    message: "OTP code and verifyOTPtoken are required",
                    success: false,
                });
            }

            let payload;
            try {
                payload = jwt.verify(token, process.env.JWT_SECRET);
            } catch (err) {
                return res.status(401).json({
                    message: "Invalid or expired verification token.",
                    success: false,
                });
            }

            const admin = await this.db.getAdminByID(payload.adminID);
            if (!admin) {
                return res.status(401).json({
                    message: "Admin not found.",
                    success: false,
                });
            }

            const twoFAData = await this.db.getTwoFaByAdminID(admin.id);
            if (!twoFAData || !twoFAData.enabled || !twoFAData.secret) {
                return res.status(403).json({
                    message: "2FA is not enabled for this account.",
                    success: false,
                });
            }

            const verified = await this.verifyToken(twoFAData.secret, otpCode);

            if (verified) {
                const sessionToken = jwt.sign({ adminID: admin.id }, process.env.JWT_SECRET, { expiresIn: "30d" });
                await this.db.createSession({
                    device,
                    ip,
                    token: sessionToken,
                    adminID: admin.id,
                    platformID: admin.platformID,
                });

                const platform = await this.db.getPlatform(admin.platformID);
                const domain = platform?.url || "";

                return res.json({
                    message: "2FA verification successful",
                    success: true,
                    token: sessionToken,
                    user: admin,
                    domain
                });
            }

            return res.json({
                message: "Invalid OTP code",
                success: false,
            });
        } catch (error) {
            return res.json({
                message: "An error occurred during verification",
                success: false,
                error: error.message,
            });
        }
    }

    async fetch2FA(req, res) {
        try {
            const { adminID, token } = req.body;
            if (!adminID || !token) {
                return res.json({
                    success: false,
                    message: "Missing credentials required!",
                });
            }

            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success) {
                return res.json({
                    success: false,
                    message: auth.message,
                });
            }

            const admin = await this.db.getAdminByID(adminID);
            if (!admin) {
                return res.status(404).json({
                    message: "Admin not found",
                    success: false,
                });
            }

            const platformID = admin?.platformID;
            const platform = await this.db.getPlatform(platformID);
            if (!platform) {
                return res.status(404).json({
                    message: "Platform not found",
                    success: false,
                });
            }

            const twoFAData = await this.db.getTwoFaByAdminID(adminID);
            if (twoFAData) {
                return res.json({
                    message: "2FA data fetched successfully",
                    data: twoFAData,
                    success: true,
                });
            }

            const secretData = this.generateKey(platform?.name || "NovaWifi", admin?.email || "Admin");
            const qrData = await this.generateQR(secretData);

            const newTwoFA = await this.db.createTwoFa({
                adminID,
                platformID,
                secret: secretData.base32,
                qrCode: qrData?.qrCodeDataURL || "",
                enabled: false,
                verified: false,
            });

            return res.json({
                message: "New 2FA data created for this admin",
                data: newTwoFA,
                success: true,
            });
        } catch (error) {
            return res.json({
                message: "An error occurred while fetching 2FA data",
                success: false,
                error: error.message,
            });
        }
    }

    async enable2FA(req, res) {
        try {
            const { token, adminID, secret, verificationCode } = req.body;
            if (!adminID || !secret || !verificationCode || !token) {
                return res.json({
                    success: false,
                    message: "Missing credentials required!",
                });
            }

            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success) {
                return res.json({
                    success: false,
                    message: auth.message,
                });
            }

            const isValid = await this.verifyToken(secret, verificationCode);
            if (!isValid) {
                return res.json({
                    message: "Invalid verification code",
                    success: false,
                });
            }

            const twoFAData = await this.db.getTwoFaByAdminID(adminID);
            if (!twoFAData) {
                return res.status(404).json({
                    message: "2FA data not found for this admin",
                    success: false,
                });
            }

            const updated = await this.db.updateTwoFa(twoFAData.id, {
                enabled: true,
                verified: true,
            });

            if (updated) {
                return res.json({
                    message: "Two-Factor Authentication enabled",
                    success: true,
                });
            }

            return res.json({
                message: "Failed to update 2FA status",
                success: false,
            });
        } catch (error) {
            return res.json({
                message: "An error occurred while enabling 2FA",
                success: false,
                error: error.message,
            });
        }
    }

    async disable2FA(req, res) {
        try {
            const { token, adminID } = req.body;
            if (!adminID || !token) {
                return res.json({
                    success: false,
                    message: "Missing credentials required!",
                });
            }

            const auth = await this.auth.AuthenticateRequest(token);
            if (!auth.success) {
                return res.json({
                    success: false,
                    message: auth.message,
                });
            }

            const twoFAData = await this.db.getTwoFaByAdminID(adminID);
            if (!twoFAData) {
                return res.status(404).json({
                    message: "2FA data not found for this admin",
                    success: false,
                });
            }

            const updated = await this.db.updateTwoFa(twoFAData.id, {
                enabled: false,
                verified: false,
            });

            if (updated) {
                return res.json({
                    message: "Two-Factor Authentication disabled",
                    success: true,
                });
            }

            return res.json({
                message: "Failed to disable 2FA",
                success: false,
            });
        } catch (error) {
            return res.json({
                message: "An error occurred while disabling 2FA",
                success: false,
                error: error.message,
            });
        }
    }
}

module.exports = { TwoFAController };
