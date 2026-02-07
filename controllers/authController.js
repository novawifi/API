// @ts-check

const { DataBase } = require("../helpers/databaseOperation")

class Auth {
    constructor() {
        this.db = new DataBase();
    }

    async AuthenticateRequest(token) {

        if (!token) {
            return {
                success: false,
                message: "Missing token!",
            };
        }

        const session = await this.db.getSessionByToken(token);
        if (!session) {
            const superuser = await this.db.getSuperUserByToken(token);
            if (superuser) {
                return {
                    success: true,
                    message: "Authenticated successfully",
                    admin: null,
                    superuser: superuser || null,
                };
            }
            return {
                success: false,
                message: "Session not found or expired",
            };
        }

        const admin = await this.db.getAdminByID(session.adminID);
        if (!admin) {
            const superuser = await this.db.getSuperUserById(session.adminID);
            if (superuser) {
                return {
                    success: true,
                    message: "Authenticated successfully",
                    admin: {
                        id: superuser.id,
                        adminID: superuser.id,
                        platformID: session.platformID,
                        role: "superuser",
                        email: superuser.email,
                        name: superuser.name || superuser.email,
                        level: "2",
                    },
                    superuser,
                };
            }
            return {
                success: false,
                message: "Invalid token provided",
            };
        }

        if (session.platformID !== admin.platformID) {
            return {
                success: false,
                message: "Invalid token provided",
            };
        }

        return {
            success: true,
            message: "Authenticated successfully",
            admin: admin || null,
            superuser: null,
        };
    };
}

module.exports = { Auth }
