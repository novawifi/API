//@ts-check

const prisma = require("../prisma");
const {
    startOfDay,
    endOfDay,
    startOfMonth,
    endOfMonth,
} = require("date-fns");
const now = new Date();
const offsetDate = new Date(
    now.toLocaleString("en-US", { timeZone: "Africa/Nairobi" })
);

class DataBase {
    constructor() {
        this.timestamp = offsetDate;
    }

    getTodayRange() {
        const start = new Date();
        start.setHours(0, 0, 0, 0);

        const end = new Date();
        end.setHours(23, 59, 59, 999);

        return { start, end };
    }

    async validateOperation(adminID, platformID) {
        if (platformID || !adminID) return null;
        try {
            const platform = await prisma.platform.findUnique({
                where: { platformID },
            });
            if (!platform || platform.adminID !== adminID) {
                return false;
            }
            return true;
        } catch (error) {
            console.error("Error validating operation:", error);
            throw error;
        }
    }

    async getPlatformConfig(platformID) {
        if (!platformID) return null;
        try {
            const config = await prisma.platformSetting.findUnique({
                where: { platformID },
            });
            return config;
        } catch (error) {
            console.error("Error fetching platform configuration:", error);
            throw error;
        }
    }

    async getPlatformConfigByShortCode(shortCode) {
        if (!shortCode) return null;
        try {
            const config = await prisma.platformSetting.findFirst({
                where: {
                    OR: [
                        { mpesaShortCode: String(shortCode) },
                        { mpesaC2BShortCode: String(shortCode) },
                    ],
                },
            });
            return config;
        } catch (error) {
            console.error("Error fetching platform config by shortcode:", error);
            throw error;
        }
    }

    async getMikrotikPlatformConfig(platformID) {
        if (!platformID) return null;
        try {
            const config = await prisma.station.findMany({
                where: { platformID },
            });
            return config;
        } catch (error) {
            console.error("Error fetching platform configuration:", error);
            throw error;
        }
    }

    async getPlatformByIP(ip) {
        if (!ip) return null;
        try {
            const platform = await prisma.platformSetting.findFirst({
                where: { platformIP: ip },
            });
            if (!platform) {
                return null;
            }
            return platform;
        } catch (error) {
            console.error("Error fetching platform by IP:", error);
            throw error;
        }
    }

    async updatePlatformConfig(platformID, data) {
        if (!platformID || !data) return null;
        try {
            const config = await prisma.platformSetting.update({
                where: { platformID },
                data: {
                    ...data,
                },
            });
            return config;
        } catch (error) {
            console.error("Error updating platform configuration:", error);
            throw error;
        }
    }

    async deletePlatformConfig(platformID) {
        if (!platformID) return null;
        try {
            await prisma.platformSetting.delete({
                where: { platformID },
            });
        } catch (error) {
            console.error("Error deleting platform configuration:", error);
            throw error;
        }
    }

    async createPlatformConfig(platformID, data) {
        if (!platformID || !data) return null;
        try {
            const config = await prisma.platformSetting.create({
                data: {
                    platformID,
                    ...data,
                },
            });
            return config;
        } catch (error) {
            console.error("Error creating platform configuration:", error);
            throw error;
        }
    }

    async getSuperUser() {
        try {
            const superUser = await prisma.superUser.findFirst();
            return superUser;
        } catch (error) {
            console.error("Error fetching super user:", error);
            throw error;
        }
    }

    async getSuperUserByEmailAndPassword(email, password) {
        if (!email || !password) return null;
        try {
            const superUser = await prisma.superUser.findFirst({
                where: {
                    email: email,
                    password: password,
                },
            });
            return superUser;
        } catch (error) {
            console.error("Error fetching super user:", error);
            throw error;
        }
    }

    async getSuperUserByToken(token) {
        try {
            const superUser = await prisma.superUser.findUnique({
                where: { token },
            });
            return superUser;
        } catch (error) {
            console.error("Error fetching super user:", error);
            throw error;
        }
    }

    async getSuperUserById(id) {
        if (!id) return null;
        try {
            const superUser = await prisma.superUser.findUnique({
                where: { id },
            });
            return superUser;
        } catch (error) {
            console.error("Error fetching super user:", error);
            throw error;
        }
    }

    async createSuperUser(data) {
        if (!data) return null;
        try {
            const superUser = await prisma.superUser.create({
                data: {
                    ...data,
                },
            });
            return superUser;
        } catch (error) {
            console.error("Error creating super user:", error);
            throw error;
        }
    }

    async createTemplate(data) {
        if (!data) return null;
        try {
            const template = await prisma.template.create({
                data: {
                    ...data,
                },
            });
            return template;
        } catch (error) {
            console.error("Error creating template:", error);
            throw error;
        }
    }

    async deleteTemplate(id) {
        if (!id) return null;
        try {
            const template = await prisma.template.delete({
                where: {
                    id
                }
            });
            return template;
        } catch (error) {
            console.error("Error deleting template:", error);
            throw error;
        }
    }

    async editTemplate(id, data) {
        if (!id || !data) return null;
        try {
            const template = await prisma.template.update({
                where: {
                    id
                },
                data: {
                    ...data
                }
            });
            return template;
        } catch (error) {
            console.error("Error updating template:", error);
            throw error;
        }
    }

    async updateSuperUser(data) {
        if (!data) return null;
        try {
            const superUser = await prisma.superUser.update({
                where: { id: data.id },
                data: {
                    ...data,
                },
            });
            return superUser;
        } catch (error) {
            console.error("Error updating super user:", error);
            throw error;
        }
    }

    async deleteSuperUser(id) {
        if (!id) return null;
        try {
            const superUser = await prisma.superUser.delete({
                where: { id },
            });
            return superUser;
        } catch (error) {
            console.error("Error deleting super user:", error);
            throw error;
        }
    }

    async createUser(data) {
        if (!data) return null;
        try {
            const { packageID, ...restData } = data;

            const user = await prisma.user.create({
                data: {
                    ...restData,
                    package: packageID
                        ? { connect: { id: packageID } }
                        : { create: data.package },
                },
            });

            return user;
        } catch (error) {
            console.error("Error creating user:", error);
            throw error;
        }
    }

    async updateUser(id, data) {
        if (!id || !data) return null;
        try {
            const user = await prisma.user.update({
                where: { id },
                data: {
                    ...data,
                },
            });
            return user;
        } catch (error) {
            console.error("Error updating user:", error);
            throw error;
        }
    }

    async deleteUser(id) {
        if (!id) return null;
        try {
            const user = await prisma.user.delete({
                where: { id },
            });
            return user;
        } catch (error) {
            console.error("Error deleting user:", error);
            throw error;
        }
    }

    async upsertRadiusUser({ username, password, groupname, rateLimit, dataLimitBytes }) {
        if (!username || !password) return null;
        try {
            await prisma.radcheck.deleteMany({ where: { username } });
            await prisma.radcheck.create({
                data: {
                    username,
                    attribute: "Cleartext-Password",
                    op: ":=",
                    value: password,
                },
            });

            if (groupname) {
                await prisma.radusergroup.deleteMany({ where: { username } });
                await prisma.radusergroup.create({
                    data: {
                        username,
                        groupname,
                        priority: 1,
                    },
                });
            }

            if (rateLimit) {
                await prisma.radreply.deleteMany({
                    where: { username, attribute: "Mikrotik-Rate-Limit" },
                });
                await prisma.radreply.create({
                    data: {
                        username,
                        attribute: "Mikrotik-Rate-Limit",
                        op: "=",
                        value: rateLimit,
                    },
                });
            }

            await prisma.radreply.deleteMany({
                where: { username, attribute: "Mikrotik-Total-Limit" },
            });
            if (dataLimitBytes && Number(dataLimitBytes) > 0) {
                await prisma.radreply.create({
                    data: {
                        username,
                        attribute: "Mikrotik-Total-Limit",
                        op: ":=",
                        value: String(dataLimitBytes),
                    },
                });
            }

            return true;
        } catch (error) {
            console.error("Error upserting RADIUS user:", error);
            throw error;
        }
    }

    async deleteRadiusUser(username) {
        if (!username) return null;
        try {
            await prisma.radcheck.deleteMany({ where: { username } });
            await prisma.radreply.deleteMany({ where: { username } });
            await prisma.radusergroup.deleteMany({ where: { username } });
            return true;
        } catch (error) {
            console.error("Error deleting RADIUS user:", error);
            throw error;
        }
    }

    async getRadiusUsageByNasIps(nasIps = []) {
        if (!Array.isArray(nasIps) || nasIps.length === 0) {
            return { hotspot: { tx: 0, rx: 0 }, pppoe: { tx: 0, rx: 0 } };
        }
        try {
            const rows = await prisma.radacct.groupBy({
                by: ["framedprotocol"],
                where: {
                    nasipaddress: { in: nasIps },
                    acctstoptime: null,
                },
                _sum: {
                    acctinputoctets: true,
                    acctoutputoctets: true,
                },
            });

            const totals = {
                hotspot: { tx: 0, rx: 0 },
                pppoe: { tx: 0, rx: 0 },
            };

            for (const row of rows) {
                const proto = String(row.framedprotocol || "").toLowerCase();
                const target = proto.includes("ppp") ? totals.pppoe : totals.hotspot;
                const rx = row._sum?.acctinputoctets || 0n;
                const tx = row._sum?.acctoutputoctets || 0n;
                target.rx += Number(rx);
                target.tx += Number(tx);
            }

            return totals;
        } catch (error) {
            console.error("Error aggregating RADIUS usage:", error);
            return { hotspot: { tx: 0, rx: 0 }, pppoe: { tx: 0, rx: 0 } };
        }
    }

    async getRadiusUsageByUsernames(usernames = []) {
        if (!Array.isArray(usernames) || usernames.length === 0) {
            return {};
        }
        try {
            const rows = await prisma.radacct.groupBy({
                by: ["username"],
                where: {
                    username: { in: usernames },
                },
                _sum: {
                    acctinputoctets: true,
                    acctoutputoctets: true,
                },
            });

            const totals = {};
            for (const row of rows) {
                const rx = row._sum?.acctinputoctets || 0n;
                const tx = row._sum?.acctoutputoctets || 0n;
                totals[row.username] = Number(rx) + Number(tx);
            }
            return totals;
        } catch (error) {
            console.error("Error aggregating RADIUS usage by usernames:", error);
            return {};
        }
    }

    async getUserByPhone(phone) {
        if (!phone) return null;
        try {
            const users = await prisma.user.findMany({
                where: { phone },
            });
            return users;
        } catch (error) {
            console.error("Error fetching user by phone:", error);
            throw error;
        }
    }

    async getUserByToken(token) {
        if (!token) return null;
        try {
            const user = await prisma.user.findUnique({
                where: { token },
            });
            return user;
        } catch (error) {
            console.error("Error fetching user by token:", error);
            throw error;
        }
    }

    async getUserByCode(code) {
        if (!code) return null;
        try {
            const user = await prisma.user.findFirst({
                where: { code },
            });
            return user;
        } catch (error) {
            console.error("Error fetching user by code:", error);
            throw error;
        }
    }

    async getUserByCodeAndPlatform(code, platformID) {
        if (!code || !platformID) return null;
        try {
            const user = await prisma.user.findFirst({
                where: { code, platformID },
            });
            return user;
        } catch (error) {
            console.error("Error fetching user by code and platform:", error);
            throw error;
        }
    }

    async getUserByUsername(username) {
        if (!username) return null;
        try {
            const user = await prisma.user.findFirst({
                where: { username },
            });
            return user;
        } catch (error) {
            console.error("Error fetching user by username:", error);
            throw error;
        }
    }

    async getUserByUsernameAndPlatform(username, platformID) {
        if (!username || !platformID) return null;
        try {
            const user = await prisma.user.findFirst({
                where: { username, platformID },
            });
            return user;
        } catch (error) {
            console.error("Error fetching user by username and platform:", error);
            throw error;
        }
    }

    async addMpesaCode(data) {
        if (!data) return null;
        try {
            const mpesaCode = await prisma.mpesa.create({
                data: {
                    ...data,
                },
            });
            return mpesaCode;
        } catch (error) {
            console.error("Error adding mpesa code:", error);
            throw error;
        }
    }

    async updateMpesaCode(code, data) {
        if (!code || !data) return null;
        try {
            const nextData = { ...data };
            if (typeof nextData.charges === "number") {
                nextData.charges = nextData.charges.toFixed(2);
            }
            const mpesaCode = await prisma.mpesa.update({
                where: { code },
                data: {
                    ...nextData,
                },
            });
            return mpesaCode;
        } catch (error) {
            console.error("Error updating mpesa code:", error);
            throw error;
        }
    }

    async updateMpesaCodeByID(id, data) {
        if (!id || !data) return null;
        try {
            const nextData = { ...data };
            if (typeof nextData.charges === "number") {
                nextData.charges = nextData.charges.toFixed(2);
            }
            const mpesa = await prisma.mpesa.update({
                where: { id },
                data: {
                    ...nextData,
                },
            });
            return mpesa;
        } catch (error) {
            console.error("Error updating mpesa code:", error);
            throw error;
        }
    }

    async getC2BTransferPool(platformID) {
        if (!platformID) return null;
        try {
            const pool = await prisma.c2BTransferPool.findUnique({
                where: { platformID },
            });
            return pool;
        } catch (error) {
            console.error("Error getting C2B transfer pool:", error);
            return null;
        }
    }

    async upsertC2BTransferPool(platformID, data) {
        if (!platformID || !data) return null;
        try {
            const pool = await prisma.c2BTransferPool.upsert({
                where: { platformID },
                create: {
                    platformID,
                    ...data,
                },
                update: {
                    ...data,
                },
            });
            return pool;
        } catch (error) {
            console.error("Error upserting C2B transfer pool:", error);
            return null;
        }
    }

    async getMpesaPullState(platformID) {
        if (!platformID) return null;
        try {
            const state = await prisma.mpesaPullState.findUnique({
                where: { platformID },
            });
            return state;
        } catch (error) {
            console.error("Error getting Mpesa pull state:", error);
            return null;
        }
    }

    async upsertMpesaPullState(platformID, data) {
        if (!platformID || !data) return null;
        try {
            const state = await prisma.mpesaPullState.upsert({
                where: { platformID },
                create: {
                    platformID,
                    ...data,
                },
                update: {
                    ...data,
                },
            });
            return state;
        } catch (error) {
            console.error("Error upserting Mpesa pull state:", error);
            return null;
        }
    }

    async addMpesaPullTransactions(platformID, rows) {
        if (!platformID || !Array.isArray(rows) || rows.length === 0) return null;
        try {
            const result = await prisma.mpesaPullTransaction.createMany({
                data: rows.map((row) => ({
                    platformID,
                    ...row,
                })),
                skipDuplicates: true,
            });
            return result;
        } catch (error) {
            console.error("Error adding Mpesa pull transactions:", error);
            return null;
        }
    }

    async getMpesaByID(id) {
        if (!id) return null;
        try {
            const mpesaCode = await prisma.mpesa.findUnique({
                where: { id },
            });
            return mpesaCode;
        } catch (error) {
            console.error("Error getting mpesa code:", error);
            throw error;
        }
    }

    async deleteMpesaCode(code) {
        if (!code) return null;
        try {
            const mpesaCode = await prisma.mpesa.delete({
                where: { code },
            });
            return mpesaCode;
        } catch (error) {
            console.error("Error deleting mpesa code:", error);
            throw error;
        }
    }

    async getMpesaCode(code) {
        if (!code) return null;
        try {
            const mpesaCode = await prisma.mpesa.findUnique({
                where: { code },
            });
            return mpesaCode;
        } catch (error) {
            console.error("Error deleting mpesa code:", error);
            throw error;
        }
    }

    async getMpesaByCode(code) {
        if (!code) return null;
        try {
            const mpesaCode = await prisma.mpesa.findFirst({
                where: { reqcode: code },
            });
            return mpesaCode;
        } catch (error) {
            console.error("Error deleting mpesa code:", error);
            throw error;
        }
    }

    async getMpesaByPlatform(platformID) {
        if (!platformID) return null;
        try {
            const oneMinuteAgo = new Date(Date.now() - 5 * 60 * 1000);
            const mpesaRecords = await prisma.mpesa.findMany({
                where: {
                    platformID: platformID,
                    status: "COMPLETE",
                    createdAt: {
                        gte: oneMinuteAgo,
                    },
                },
            });
            return mpesaRecords;
        } catch (error) {
            console.error("Error getting mpesa records:", error);
            throw error;
        }
    }

    async getMpesaByStatuses(platformID, statuses, beforeDate) {
        if (!platformID || !Array.isArray(statuses) || statuses.length === 0) return null;
        try {
            const where = {
                platformID,
                status: { in: statuses },
            };
            if (beforeDate) {
                where.createdAt = { lte: beforeDate };
            }
            const mpesaRecords = await prisma.mpesa.findMany({ where });
            return mpesaRecords;
        } catch (error) {
            console.error("Error getting mpesa records by status:", error);
            throw error;
        }
    }

    async getMpesaFailedByPlatform(platformID) {
        if (!platformID) return null;
        try {
            const mpesaRecords = await prisma.mpesa.findMany({
                where: {
                    platformID: platformID,
                    status: "FAILED",
                },
            });
            return mpesaRecords;
        } catch (error) {
            console.error("Error getting mpesa records:", error);
            throw error;
        }
    }

    async getMpesaByPlatformAndPhone(platformID, phone, limit = 100) {
        if (!platformID || !phone) return null;
        try {
            const payments = await prisma.mpesa.findMany({
                where: {
                    platformID,
                    phone,
                },
                orderBy: {
                    createdAt: "desc",
                },
                take: limit,
            });
            return payments;
        } catch (error) {
            console.error("Error getting mpesa records by phone:", error);
            throw error;
        }
    }

    async getBillPaymentsByPlatform(platformID) {
        if (!platformID) return null;
        try {
            const payments = await prisma.mpesa.findMany({
                where: { platformID, service: "bill" },
                orderBy: { createdAt: "desc" },
            });
            return payments;
        } catch (error) {
            console.error("Error fetching bill payments by platform:", error);
            throw error;
        }
    }

    async getBillPaymentsByPlatformPaged(platformID, limit = 100, offset = 0) {
        if (!platformID) return null;
        try {
            const payments = await prisma.mpesa.findMany({
                where: { platformID, service: "bill" },
                orderBy: { createdAt: "desc" },
                skip: Number(offset) || 0,
                take: Number(limit) || 100,
            });
            return payments;
        } catch (error) {
            console.error("Error fetching paged bill payments by platform:", error);
            throw error;
        }
    }

    async createAdmin(data) {
        if (!data) return null;
        try {
            const admin = await prisma.admin.create({
                data: {
                    ...data,
                },
            });
            return admin;
        } catch (error) {
            console.error("Error creating admin:", error);
            throw error;
        }
    }

    async updateAdmin(id, data) {
        if (!id || !data) return null;
        try {
            const admin = await prisma.admin.update({
                where: { id },
                data: {
                    ...data,
                },
            });
            return admin;
        } catch (error) {
            console.error("Error updating admin:", error);
            throw error;
        }
    }

    async deleteAdmin(id) {
        if (!id) return null;
        try {
            const admin = await prisma.admin.delete({
                where: { id },
            });
            return admin;
        } catch (error) {
            console.error("Error deleting admin:", error);
            throw error;
        }
    }

    async deleteAdminsByPlatformId(platformID) {
        if (!platformID) return null;
        try {
            const result = await prisma.admin.deleteMany({
                where: { platformID },
            });
            return result;
        } catch (error) {
            console.error("Error deleting admins:", error);
            throw error;
        }
    }

    async deleteUsersByplatformID(platformID) {
        if (!platformID) return null;
        try {
            const result = await prisma.user.deleteMany({
                where: { platformID },
            });
            return result;
        } catch (error) {
            console.error("Error deleting users:", error);
            throw error;
        }
    }

    async deletePackagesByplatformID(platformID) {
        if (!platformID) return null;
        try {
            const result = await prisma.package.deleteMany({
                where: { platformID },
            });
            return result;
        } catch (error) {
            console.error("Error deleting packages:", error);
            throw error;
        }
    }


    async deleteStationsByplatformID(platformID) {
        if (!platformID) return null;
        try {
            const result = await prisma.station.deleteMany({
                where: { platformID },
            });
            return result;
        } catch (error) {
            console.error("Error deleting stations:", error);
            throw error;
        }
    }

    async deleteC2BTransferPool(platformID) {
        if (!platformID) return null;
        try {
            const result = await prisma.c2BTransferPool.deleteMany({
                where: { platformID },
            });
            return result;
        } catch (error) {
            console.error("Error deleting c2b transfer pool:", error);
            throw error;
        }
    }

    async deleteMpesaPullState(platformID) {
        if (!platformID) return null;
        try {
            const result = await prisma.mpesaPullState.deleteMany({
                where: { platformID },
            });
            return result;
        } catch (error) {
            console.error("Error deleting mpesa pull state:", error);
            throw error;
        }
    }

    async deleteMpesaPullTransactions(platformID) {
        if (!platformID) return null;
        try {
            const result = await prisma.mpesaPullTransaction.deleteMany({
                where: { platformID },
            });
            return result;
        } catch (error) {
            console.error("Error deleting mpesa pull transactions:", error);
            throw error;
        }
    }

    async deleteDashboardStats(platformID) {
        if (!platformID) return null;
        try {
            const result = await prisma.dashboardStats.deleteMany({
                where: { platformID },
            });
            return result;
        } catch (error) {
            console.error("Error deleting dashboard stats:", error);
            throw error;
        }
    }

    async deleteStationDashboardStats(platformID) {
        if (!platformID) return null;
        try {
            const result = await prisma.stationDashboardStats.deleteMany({
                where: { platformID },
            });
            return result;
        } catch (error) {
            console.error("Error deleting station dashboard stats:", error);
            throw error;
        }
    }

    async deletePPPoEPlansByplatformID(platformID) {
        if (!platformID) return null;
        try {
            const result = await prisma.pPPoEPlan.deleteMany({
                where: { platformID },
            });
            return result;
        } catch (error) {
            console.error("Error deleting pppoe plans:", error);
            throw error;
        }
    }

    async deleteScheduledSmsByplatformID(platformID) {
        if (!platformID) return null;
        try {
            const result = await prisma.scheduledSms.deleteMany({
                where: { platformID },
            });
            return result;
        } catch (error) {
            console.error("Error deleting scheduled sms:", error);
            throw error;
        }
    }

    async deletePlatformPlugins(platformID) {
        if (!platformID) return null;
        try {
            const result = await prisma.platformPlugin.deleteMany({
                where: { platformID },
            });
            return result;
        } catch (error) {
            console.error("Error deleting platform plugins:", error);
            throw error;
        }
    }

    async deletePlatformTerms(platformID) {
        if (!platformID) return null;
        try {
            const result = await prisma.platformTerms.deleteMany({
                where: { platformID },
            });
            return result;
        } catch (error) {
            console.error("Error deleting platform terms:", error);
            throw error;
        }
    }

    async deletePlatformSidebarLinks(platformID) {
        if (!platformID) return null;
        try {
            const result = await prisma.platformSidebarLink.deleteMany({
                where: { platformID },
            });
            return result;
        } catch (error) {
            console.error("Error deleting platform sidebar links:", error);
            throw error;
        }
    }

    async deleteMpesaByplatformID(platformID) {
        if (!platformID) return null;
        try {
            const result = await prisma.mpesa.deleteMany({
                where: { platformID },
            });
            return result;
        } catch (error) {
            console.error("Error deleting mpesa:", error);
            throw error;
        }
    }

    async deletDDNSByplatformID(platformID) {
        if (!platformID) return null;
        try {
            const result = await prisma.ddns.deleteMany({
                where: { platformID },
            });
            return result;
        } catch (error) {
            console.error("Error deleting ddns:", error);
            throw error;
        }
    }

    async deletePPPoEByplatformID(platformID) {
        if (!platformID) return null;
        try {
            const result = await prisma.pppoe.deleteMany({
                where: { platformID },
            });
            return result;
        } catch (error) {
            console.error("Error deleting mpesa:", error);
            throw error;
        }
    }

    async createPackage(data) {
        if (!data) return null;
        try {
            const pkg = await prisma.package.create({
                data: {
                    ...data,
                },
            });
            return pkg;
        } catch (error) {
            console.error("Error creating package:", error);
            throw error;
        }
    }


    async updatePackage(id, platformID, data) {
        if (!id || !data) return null;
        try {
            const pkg = await prisma.package.update({
                where: { id: id },
                data: {
                    ...data,
                },
            });
            return pkg;
        } catch (error) {
            console.error("Error updating package:", error);
            throw error;
        }
    }

    async getPackage(id) {
        if (!id) return null;
        try {
            const pkg = await prisma.package.findUnique({
                where: { id },
            });
            return pkg;
        } catch (error) {
            console.error("Error getting package:", error);
            throw error;
        }
    }

    async getPackages(platformID) {
        if (!platformID) return null;
        try {
            const packages = await prisma.package.findMany({
                where: { platformID },
            });
            return packages;
        } catch (error) {
            console.error("Error getting packages:", error);
            throw error;
        }
    }

    async getPackagesByHost(platformID, host) {
        if (!platformID) return null;
        try {
            const packages = await prisma.package.findMany({
                where: { platformID, routerHost: host },
            });
            return packages;
        } catch (error) {
            console.error("Error getting packages:", error);
            throw error;
        }
    }

    async getMostPurchasedPackage(platformID) {
        if (!platformID) return null;

        try {
            const packages = await prisma.package.findMany({
                where: { platformID },
                include: {
                    _count: {
                        select: { users: true },
                    },
                },
                orderBy: {
                    users: {
                        _count: 'desc',
                    },
                },
                take: 1,
            });

            return packages[0] || null;
        } catch (error) {
            console.error("Error fetching most purchased package:", error);
            throw error;
        }
    }

    async getPackagesByAmount(platformID, price, id) {
        if (!platformID || !price || !id) return null;
        const fullPrice = Math.trunc(Number(price));
        try {
            const pkg = await prisma.package.findFirst({
                where: { platformID, price: `${fullPrice}`, id },
            });
            return pkg;
        } catch (error) {
            console.error("Error getting packages:", error);
            throw error;
        }
    }

    async deletePackage(id) {
        if (!id) return null;
        try {
            const pkg = await prisma.package.delete({
                where: { id },
            });
            return pkg;
        } catch (error) {
            console.error("Error deleting package:", error);
            throw error;
        }
    }

    generateSlug(name) {
        if (!name) return null;
        return name
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9\s-]/g, "")
            .replace(/\s+/g, "-");
    }

    async createPlatform(data) {
        if (!data) return null;
        try {
            const platform = await prisma.platform.create({
                data: {
                    ...data,
                },
            });
            return platform;
        } catch (error) {
            console.error("Error creating platform:", error);
            throw error;
        }
    }

    async updatePlatform(id, data) {
        if (!data || !id) return null;
        try {
            const platform = await prisma.platform.update({
                where: { platformID: id },
                data: {
                    ...data,

                },
            });
            return platform;
        } catch (error) {
            console.error("Error updating platform:", error);
            throw error;
        }
    }

    async deletePlatform(id) {
        if (!id) return null;
        try {
            const platform = await prisma.platform.delete({
                where: { id },
            });
            return platform;
        } catch (error) {
            console.error("Error deleting platform:", error);
            throw error;
        }
    }

    async getPlatform(platformID) {
        if (!platformID) return null;
        try {
            const platform = await prisma.platform.findUnique({
                where: { platformID },
            });
            if (!platform) return null;
            const oldestAdmin = await prisma.admin.findFirst({
                where: {
                    platformID: platformID,
                    role: 'superuser',
                },
                orderBy: {
                    createdAt: 'asc',
                },
            });

            if (!oldestAdmin) return null;

            const superuser = await this.getSuperUser();
            if (superuser) {
                platform.admin_phone = superuser.phone;
            }
            const config = await this.getPlatformConfig(platformID);
            if (config) {
                platform.template = config.template;
                platform.sms = config.sms;
                platform.supportPhone = config.supportPhone || "";
                platform.brandingImage = config.brandingImage || "";
                platform.mpesaShortCode = config.mpesaShortCode || "";
                platform.mpesaShortCodeType = config.mpesaShortCodeType || "";
                platform.offlinePayments = config.offlinePayments;
            }

            const termsPlugin = await this.getPlatformPlugin(platform.platformID, "terms-of-service");
            const liveSupportPlugin = await this.getPlatformPlugin(platform.platformID, "live-support");
            platform.termsEnabled = Boolean(termsPlugin);
            platform.liveSupportEnabled = Boolean(liveSupportPlugin);
            platform.phone = config?.supportPhone || oldestAdmin.phone;
            return platform;
        } catch (error) {
            console.error("Error getting platform:", error);
            throw error;
        }
    }

    async getPlatformByID(id) {
        if (!id) return null;
        try {
            const platform = await prisma.platform.findUnique({
                where: { id },
            });
            return platform;
        } catch (error) {
            console.error("Error getting platform:", error);
            throw error;
        }
    }

    async getPlatformByplatformID(platformID) {
        if (!platformID) return null;
        try {
            const platform = await prisma.platform.findUnique({
                where: { platformID },
            });
            if (!platform) return null;
            const config = await this.getPlatformConfig(platformID);
            if (config) {
                platform.template = config.template;
                platform.sms = config.sms;
                platform.supportPhone = config.supportPhone || "";
                platform.brandingImage = config.brandingImage || "";
                platform.phone = config.supportPhone || platform.phone;
                platform.mpesaShortCode = config.mpesaShortCode || "";
                platform.mpesaShortCodeType = config.mpesaShortCodeType || "";
                platform.offlinePayments = config.offlinePayments;
            }
            const sms = await this.getPlatformSMS(platformID);
            platform.sentHotspot = sms?.sentHotspot ?? false;
            const termsPlugin = await this.getPlatformPlugin(platform.platformID, "terms-of-service");
            const liveSupportPlugin = await this.getPlatformPlugin(platform.platformID, "live-support");
            platform.termsEnabled = Boolean(termsPlugin);
            platform.liveSupportEnabled = Boolean(liveSupportPlugin);
            return platform;
        } catch (error) {
            console.error("Error getting platform:", error);
            throw error;
        }
    }

    async getAdmin(adminID) {
        if (!adminID) return null;
        try {
            const admin = await prisma.admin.findFirst({
                where: { adminID },
            });
            return admin;
        } catch (error) {
            console.error("Error getting admin:", error);
            throw error;
        }
    }

    async getAdminByID(id) {
        if (!id) return null;
        try {
            const admin = await prisma.admin.findUnique({
                where: { id },
            });
            return admin;
        } catch (error) {
            console.error("Error getting admin:", error);
            throw error;
        }
    }

    async getPlatformByUrl(url) {
        if (!url) return null;
        try {
            let platform = await prisma.platform.findUnique({
                where: { url },
            });
            if (!platform) {
                platform = await prisma.platform.findFirst({
                    where: { domain: url },
                });
            }
            if (!platform) return null;
            const oldestAdmin = await prisma.admin.findFirst({
                where: {
                    platformID: platform.platformID,
                    role: 'superuser',
                },
                orderBy: {
                    createdAt: 'asc',
                },
            });

            if (!oldestAdmin) return null;
            const superuser = await this.getSuperUser();
            if (superuser) {
                platform.admin_phone = superuser.phone;
            }
            const config = await this.getPlatformConfig(platform.platformID);
            if (config) {
                platform.template = config.template;
                platform.sms = config.sms;
                platform.supportPhone = config.supportPhone || "";
                platform.brandingImage = config.brandingImage || "";
                platform.mpesaShortCode = config.mpesaShortCode || "";
                platform.mpesaShortCodeType = config.mpesaShortCodeType || "";
                platform.offlinePayments = config.offlinePayments;
            }
            const termsPlugin = await this.getPlatformPlugin(platform.platformID, "terms-of-service");
            const liveSupportPlugin = await this.getPlatformPlugin(platform.platformID, "live-support");
            platform.termsEnabled = Boolean(termsPlugin);
            platform.liveSupportEnabled = Boolean(liveSupportPlugin);
            platform.phone = config?.supportPhone || oldestAdmin.phone;
            return platform;
        } catch (error) {
            console.error("Error getting platform:", error);
            throw error;
        }
    }

    async getCodesByPhone(phone, platformID) {
        if (!phone || !platformID) return null;
        try {
            const activeCodes = await prisma.user.findMany({
                where: {
                    phone: phone,
                    status: "active",
                    platformID: platformID
                }
            });

            if (activeCodes.length > 0) {
                return activeCodes;
            }

            const inactiveCodes = await prisma.user.findMany({
                where: {
                    phone: phone,
                    status: "expired",
                    platformID: platformID
                },
                orderBy: {
                    createdAt: "desc"
                },
                take: 1
            });

            return inactiveCodes;
        } catch (error) {
            console.error("Error getting codes by phone:", error);
            throw error;
        }
    }

    async getCodesByMpesa(code, platformID) {
        if (!code) return null;

        try {
            const activeCodes = await prisma.user.findMany({
                where: {
                    code: code,
                    status: "active",
                    platformID: platformID
                }
            });

            if (activeCodes.length > 0) {
                return activeCodes;
            }

            const inactiveCodes = await prisma.user.findMany({
                where: {
                    username: code,
                    status: "expired",
                    platformID: platformID
                },
                take: 1
            });

            return inactiveCodes;
        } catch (error) {
            console.error("Error getting codes by MPESA:", error);
            throw error;
        }
    }

    async getUsersByCodes(platformID) {
        if (!platformID) return null;
        try {
            const codes = await prisma.user.findMany({
                where: {
                    platformID,
                },
            });
            return codes;
        } catch (error) {
            console.error("Error getting codes:", error);
            throw error;
        }
    }

    async getUsersByActiveCodes(platformID) {
        if (!platformID) return null;
        try {
            const codes = await prisma.user.findMany({
                where: {
                    platformID,
                    status: "active",
                },
            });
            return codes;
        } catch (error) {
            console.error("Error getting codes:", error);
            throw error;
        }
    }

    async getMpesaPayments(platformID) {
        if (!platformID) return null;

        try {
            const payments = await prisma.mpesa.findMany({
                where: { platformID },
                orderBy: { createdAt: "desc" },
                // take: 100,
            });

            const total = await prisma.mpesa.count({
                where: { platformID },
            });

            return payments;
        } catch (error) {
            console.error("Error getting payments:", error);
            throw error;
        }
    }

    async getRecentMpesaPayments(platformID, limit = 5) {
        if (!platformID) return [];
        try {
            return prisma.mpesa.findMany({
                where: { platformID },
                orderBy: { createdAt: "desc" },
                take: Math.max(1, Math.min(Number(limit) || 5, 20)),
                include: { package: true },
            });
        } catch (error) {
            console.error("Error getting recent payments:", error);
            throw error;
        }
    }

    async getMpesaPaymentsBatch(platformID, cursorId = null, limit = 500) {
        if (!platformID) return [];
        try {
            return prisma.mpesa.findMany({
                where: { platformID },
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                take: Math.max(1, Math.min(Number(limit) || 500, 2000)),
                ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
            });
        } catch (error) {
            console.error("Error getting payments batch:", error);
            throw error;
        }
    }

    async getUsersBatch(platformID, cursorId = null, limit = 500) {
        if (!platformID) return [];
        try {
            return prisma.user.findMany({
                where: { platformID },
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                take: Math.max(1, Math.min(Number(limit) || 500, 2000)),
                ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
            });
        } catch (error) {
            console.error("Error getting users batch:", error);
            throw error;
        }
    }

    async getMpesaPaymentsToday(platformID) {
        if (!platformID) return [];

        const { start, end } = this.getTodayRange();

        return prisma.mpesa.findMany({
            where: {
                platformID,
                OR: [
                    {
                        service: "hotspot",
                        createdAt: {
                            gte: start,
                            lte: end,
                        },
                    },
                    {
                        service: {
                            in: ["bill", "Mpesa B2B", "pppoe"],
                        },
                    },
                ],
            },
            orderBy: { createdAt: "desc" },
            include: {
                package: true,
            },
        });
    }

    async deleteMpesaPayment(id) {
        if (!id) return null;
        try {
            const del = await prisma.mpesa.delete({
                where: {
                    id,
                },
            });
        } catch (error) {
            console.error("Error deleting payment:", error);
            throw error;
        }
    }

    async getPlatforms() {
        try {
            const platforms = await prisma.platform.findMany({
                select: { platformID: true },
            });
            return platforms;
        } catch (error) {
            console.error("Error getting platform:", error);
            throw error;
        }
    }

    async getAllPlatforms() {
        try {
            const platforms = await prisma.platform.findMany();
            return platforms;
        } catch (error) {
            console.error("Error getting platform:", error);
            throw error;
        }
    }

    async getActivePlatformUsers(platformID) {
        if (!platformID) return null;
        try {
            const users = await prisma.user.findMany({
                where: { status: "active", platformID: platformID },
                select: {
                    id: true,
                    username: true,
                    phone: true,
                    expireAt: true,
                    createdAt: true,
                    status: true,
                    packageID: true,
                    package: {
                        select: {
                            category: true,
                            routerHost: true,
                        },
                    },
                },
            });

            return users;
        } catch (error) {
            console.error("Error getting users:", error);
            throw error;
        }
    }

    async getRecentlyActivePlatformUsers(platformID) {
        if (!platformID) return null;
        try {
            const oneMinuteAgo = new Date(Date.now() - 5 * 60 * 1000);
            const users = await prisma.user.findMany({
                where: {
                    status: "active",
                    platformID: platformID,
                    createdAt: {
                        gte: oneMinuteAgo,
                    },
                },
            });

            return users;
        } catch (error) {
            console.error("Error getting recently active users:", error);
            throw error;
        }
    }

    async getPlatformByURLData(url) {
        if (!url) return null;
        try {
            const platform = await prisma.platform.findUnique({
                where: {
                    url,
                },
            });

            return platform;
        } catch (error) {
            console.log("An error occured", error);
            return false;
        }
    }

    async getPlatformByDomain(domain) {
        if (!domain) return null;
        try {
            const platform = await prisma.platform.findFirst({
                where: {
                    domain,
                },
            });
            return platform;
        } catch (error) {
            console.log("An error occured", error);
            return false;
        }
    }

    async getAdminByEmail(email) {
        if (!email) return null;
        try {
            const admin = await prisma.admin.findUnique({
                where: {
                    email,
                },
            });
            return admin;
        } catch (error) {
            console.log("An error occured", error);
            return false;
        }
    }

    async getAdminsByID(adminID) {
        if (!adminID) return null;
        try {
            const admin = await prisma.admin.findMany({
                where: {
                    adminID: adminID,
                },
            });
            return admin;
        } catch (error) {
            console.log("An error occured", error);
            return false;
        }
    }

    async getSuperAdminsByPlatform(platformID) {
        if (!platformID) return null;
        try {
            const superadmin = await prisma.admin.findMany({
                where: {
                    platformID: platformID,
                    role: "superuser"
                },
            });
            return superadmin;
        } catch (error) {
            console.log("An error occured", error);
            return false;
        }
    }

    async getAdmins() {
        try {
            const admins = await prisma.admin.findMany();
            return admins;
        } catch (error) {
            console.log("An error occured", error);
            return false;
        }
    }

    async getAdminsWithPlatforms() {
        try {
            const [admins, platforms] = await Promise.all([
                prisma.admin.findMany(),
                prisma.platform.findMany({
                    select: {
                        platformID: true,
                        name: true,
                    },
                }),
            ]);

            const platformMap = new Map(
                platforms.map((platform) => [platform.platformID, platform.name])
            );

            return admins.map((admin) => ({
                ...admin,
                platformName: platformMap.get(admin.platformID) || "Unknown",
            }));
        } catch (error) {
            console.log("An error occured", error);
            return false;
        }
    }

    async getAdminByToken(token) {
        if (!token) return null;
        try {
            const admin = await prisma.admin.findUnique({
                where: {
                    token: token.trim(),
                },
            });
            return admin;
        } catch (error) {
            console.log("An error occured", error);
            return false;
        }
    }

    async getUserByPlatform(platformID) {
        if (!platformID) return null;
        try {
            const users = await prisma.user.findMany({
                where: {
                    platformID,
                },
            });
            return users;
        } catch (error) {
            console.log("An error occured", error);
            return false;
        }
    }

    async getUserByPlatformToday(platformID) {
        if (!platformID) return [];

        const { start, end } = this.getTodayRange();

        return prisma.user.findMany({
            where: {
                platformID,
                OR: [
                    {
                        createdAt: { gte: start, lte: end },
                    },
                    {
                        status: "active",
                        createdAt: { lt: start },
                    },
                ],
            },
            include: { package: true },
            orderBy: { createdAt: "desc" },
        });
    }

    async getPackagesByPlatformID(platformID) {
        if (!platformID) return null;
        try {
            const packages = await prisma.package.findMany({
                where: {
                    platformID,
                },
            });
            return packages;
        } catch (error) {
            console.log("An error occured", error);
            return false;
        }
    }

    async getPackagesByID(ID) {
        if (!ID) return null;
        try {
            const pkg = await prisma.package.findUnique({
                where: {
                    id: ID,
                },
            });
            return pkg;
        } catch (error) {
            console.log("An error occured", error);
            return false;
        }
    }

    async getPackageByAccountNumber(platformID, accountNumber) {
        if (!platformID || !accountNumber) return null;
        try {
            const pkg = await prisma.package.findFirst({
                where: {
                    platformID,
                    accountNumber: String(accountNumber),
                },
            });
            return pkg;
        } catch (error) {
            console.log("An error occured", error);
            return false;
        }
    }

    async getPPPoEByAccountNumber(platformID, accountNumber) {
        if (!platformID || !accountNumber) return null;
        try {
            const pppoe = await prisma.pppoe.findFirst({
                where: {
                    platformID,
                    accountNumber: String(accountNumber),
                },
            });
            return pppoe;
        } catch (error) {
            console.log("An error occured", error);
            return false;
        }
    }

    async getPackagesByName(name, platformID) {
        if (!name) return null;
        try {
            const pkg = await prisma.package.findFirst({
                where: {
                    platformID: platformID,
                    name: name,
                },
            });
            return pkg;
        } catch (error) {
            console.log("An error occured", error);
            return false;
        }
    }

    async getPlatformIDfromPackage(adminID) {
        if (!adminID) return null;
        try {
            const admin = await prisma.package.findUnique({
                where: {
                    adminID: adminID,
                },
            });
        } catch (error) {
            console.log("An error occured", error);
            return false;
        }
    }

    async getStations(platformID) {
        if (!platformID) return null;
        try {
            const stations = await prisma.station.findMany({
                where: {
                    platformID,
                },
            });
            return stations;
        } catch (error) {
            console.log("An error occured", error);
            return false;
        }
    }

    async getAdminStations() {
        try {
            const stations = await prisma.station.findMany();
            return stations;
        } catch (error) {
            console.log("An error occured", error);
            return false;
        }
    }

    async getAllStations() {
        try {
            const stations = await prisma.station.findMany({
                select: {
                    name: true,
                    mikrotikHost: true,
                    platformID: true
                },
            });
            return stations;
        } catch (error) {
            console.log("An error occurred", error);
            return false;
        }
    }

    async getStation(stationID) {
        try {
            const station = await prisma.station.findUnique({
                where: {
                    id: stationID,
                },
            });
            return station;
        } catch (error) {
            console.log("An error occured", error);
            return false;
        }
    }

    async createStation(data) {
        if (!data) return null;
        try {
            const station = await prisma.station.create({
                data: {
                    ...data,
                },
            });
            return station;
        } catch (error) {
            console.log("An error occured", error);
            return [];
        }
    }

    async updateStation(id, data) {
        if (!id || !data) return null;
        try {
            const station = await prisma.station.update({
                where: { id },
                data: {
                    ...data,
                },
            });
            return station;
        } catch (error) {
            console.log("An error occured", error);
            return [];
        }
    }

    async deleteStation(id) {
        if (!id) return null;
        try {
            const station = await prisma.station.delete({
                where: { id },
            });
            return station;
        } catch (error) {
            console.log("An error occured", error);
            return false;
        }
    }

    async getPlatformRevenue() {
        try {
            const payments = await prisma.mpesa.findMany({
                where: {
                    status: "COMPLETE",
                    service: "bill",
                },
            });
            const totalRevenue = payments.reduce(
                (sum, payment) => sum + parseFloat(payment.amount),
                0
            );
            return { payments, totalRevenue };
        } catch (error) {
            console.error("Error getting platform revenue:", error);
            throw error;
        }
    }

    async getPlatformSMSDeposits() {
        try {
            const sms = await prisma.sms.findMany();
            const totalBalances = sms.reduce(
                (sum, sms) => sum + parseFloat(sms.balance),
                0
            );
            const remainingSMS = sms.reduce(
                (sum, sms) => sum + parseFloat(sms.remainingSMS),
                0
            );
            return { sms, totalBalances, remainingSMS };
        } catch (error) {
            console.error("Error getting platform sms:", error);
            throw error;
        }
    }

    async getDailyRevenue(platformID) {
        if (!platformID) return null;

        try {
            const midnight = this.timestamp;
            midnight.setHours(0, 0, 0, 0);

            const payments = await prisma.mpesa.findMany({
                where: {
                    platformID,
                    status: "COMPLETE",
                    createdAt: {
                        gte: midnight,
                    },
                    service: {
                        notIn: ["bill", "sms", "Mpesa B2B"],
                    },
                },
            });

            const totalRevenue = payments.reduce(
                (sum, payment) => sum + parseFloat(payment.amount),
                0
            );

            return { payments, totalRevenue };
        } catch (error) {
            console.error("Error getting daily revenue:", error);
            throw error;
        }
    }

    async getAllTimeRevenue(platformID) {
        if (!platformID) return null;

        try {
            const payments = await prisma.mpesa.findMany({
                where: {
                    platformID,
                    status: "COMPLETE",
                    service: {
                        notIn: ["bill", "sms", "Mpesa B2B"],
                    },
                },
            });

            const totalRevenue = payments.reduce(
                (sum, payment) => sum + parseFloat(payment.amount),
                0
            );

            return { payments, totalRevenue };
        } catch (error) {
            console.error("Error getting all-time revenue:", error);
            throw error;
        }
    }

    async getYesterdayRevenue(platformID) {
        if (!platformID) return null;
        try {
            const midnight = this.timestamp;
            midnight.setHours(0, 0, 0, 0);
            const yestermidnight = new Date(midnight.getTime() - (24 * 60 * 60 * 1000));
            yestermidnight.setHours(0, 0, 0, 0);
            const formatedyestermidnight = yestermidnight;

            const payments = await prisma.mpesa.findMany({
                where: {
                    platformID,
                    status: "COMPLETE",
                    createdAt: {
                        gte: formatedyestermidnight,
                        lte: midnight
                    },
                    service: {
                        notIn: ["bill", "sms", "Mpesa B2B"],
                    },
                },
            });
            const totalRevenue = payments.reduce((sum, payment) => sum + parseFloat(payment.amount), 0);
            return { payments, totalRevenue };
        } catch (error) {
            console.error("Error getting daily revenue:", error);
            throw error;
        }
    }

    async getLastMonthRevenue(platformID) {
        if (!platformID) return null;
        try {
            const now = this.timestamp;
            const firstDayOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
            const firstDayOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            const lastDayOfLastMonth = new Date(firstDayOfThisMonth.getTime() - 1);

            const payments = await prisma.mpesa.findMany({
                where: {
                    platformID,
                    status: "COMPLETE",
                    createdAt: {
                        gte: firstDayOfLastMonth,
                        lte: lastDayOfLastMonth,
                    },
                    service: {
                        notIn: ["bill", "sms", "Mpesa B2B"],
                    },
                },
            });
            const totalRevenue = payments.reduce((sum, payment) => sum + parseFloat(payment.amount), 0);
            return { payments, totalRevenue };
        } catch (error) {
            console.error("Error getting last month revenue:", error);
            throw error;
        }
    }

    async getThisMonthRevenue(platformID) {
        if (!platformID) return null;
        try {
            const now = this.timestamp;
            const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
            firstDayOfMonth.setHours(0, 0, 0, 0);

            const payments = await prisma.mpesa.findMany({
                where: {
                    platformID,
                    status: "COMPLETE",
                    createdAt: {
                        gte: firstDayOfMonth,
                        lte: now,
                    },
                    service: {
                        notIn: ["bill", "sms", "Mpesa B2B"],
                    },
                },
            });
            const totalRevenue = payments.reduce((sum, payment) => sum + parseFloat(payment.amount), 0);
            return { payments, totalRevenue };
        } catch (error) {
            console.error("Error getting current month revenue:", error);
            throw error;
        }
    }

    async getPreviousFiveMonthsRevenue(platformID) {
        if (!platformID) return [];
        const results = [];
        try {
            const now = this.timestamp;

            for (let i = 2; i <= 6; i++) {
                const target = new Date(now.getFullYear(), now.getMonth() - i, 1);
                const monthStart = new Date(target.getFullYear(), target.getMonth(), 1);
                const monthEnd = new Date(target.getFullYear(), target.getMonth() + 1, 0, 23, 59, 59, 999);

                const payments = await prisma.mpesa.findMany({
                    where: {
                        platformID,
                        status: "COMPLETE",
                        createdAt: {
                            gte: monthStart,
                            lte: monthEnd,
                        },
                        service: {
                            notIn: ["bill", "sms", "Mpesa B2B"],
                        },
                    },
                });
                const totalRevenue = payments.reduce((sum, p) => sum + parseFloat(p.amount), 0)
                results.push({
                    month: monthStart.toLocaleString("default", { month: "long" }),
                    totalRevenue,
                });
            }
            return results;
        } catch (error) {
            console.error("Error fetching previous five months revenue:", error);
            throw error;
        }
    }

    async getRevenueByCustomDateRange(platformID, from, to) {
        if (!platformID || !from || !to) return null;
        try {
            const fromDate = new Date(from);
            const toDate = new Date(to);

            fromDate.setHours(0, 0, 0, 0);
            toDate.setHours(23, 59, 59, 999);

            const payments = await prisma.mpesa.findMany({
                where: {
                    platformID,
                    status: "COMPLETE",
                    createdAt: {
                        gte: fromDate,
                        lte: toDate,
                    },
                    service: {
                        notIn: ["bill", "sms", "Mpesa B2B"],
                    },
                },
            });
            const totalRevenue = payments.reduce((sum, payment) => sum + parseFloat(payment.amount), 0);
            return { payments, totalRevenue };
        } catch (error) {
            console.error("Error getting custom date range revenue:", error);
            throw error;
        }
    }

    async createFunds(data) {
        if (!data) return null;
        try {
            const addfunds = await prisma.funds.create({
                data: {
                    ...data,
                },
            })
            return addfunds;
        } catch (error) {
            console.error("An error occured:", error);
            return null;
        }
    }

    async getFunds(platformID) {
        if (!platformID) return null;
        try {
            const funds = await prisma.funds.findUnique({
                where: {
                    platformID
                }
            })
            return funds;
        } catch (error) {
            console.error("An error occured:", error);
            return null;
        }
    }

    async getFundsByshortIdentifier(shortIdentifier) {
        if (!shortIdentifier) return null;
        try {
            const funds = await prisma.funds.findFirst({
                where: {
                    shortIdentifier
                }
            })
            return funds;
        } catch (error) {
            console.error("An error occured:", error);
            return null;
        }
    }

    async deleteFunds(platformID) {
        if (!platformID) return null;
        try {
            const delfunds = await prisma.funds.delete({
                where: {
                    platformID
                }
            })
            return true;
        } catch (error) {
            console.error("An error occured:", error);
            return false;
        }
    }

    async updateFunds(platformID, data) {
        if (!platformID) return null;
        try {
            const updfunds = await prisma.funds.update({
                where: {
                    platformID
                },
                data: {
                    ...data,
                },
            })
            return updfunds;
        } catch (error) {
            console.error("An error occured:", error);
            return null;
        }
    }

    async createDDNS(data) {
        if (!data) return null;
        try {
            const created = await prisma.ddns.create({
                data
            })
            return created;
        } catch (error) {
            console.error("An error occured:", error);
            return null;
        }
    }

    async updateDDNS(id, data) {
        if (!data || !id) return null;
        try {
            const upd = await prisma.ddns.update({
                where: {
                    id
                },
                data
            })
            return upd;
        } catch (error) {
            console.error("An error occured:", error);
            return null;
        }
    }

    async getDDNS(platformID) {
        if (!platformID) return null;
        try {
            const ddns = await prisma.ddns.findMany({
                where: {
                    platformID
                }
            })
            return ddns;
        } catch (error) {
            console.error("An error occured:", error);
            return null;
        }
    }

    async getDDNSById(id) {
        if (!id) return null;
        try {
            const ddns = await prisma.ddns.findUnique({
                where: {
                    id
                }
            })
            return ddns;
        } catch (error) {
            console.error("An error occured:", error);
            return null;
        }
    }

    async getDDNSByUrl(url) {
        if (!url) return null;
        try {
            const ddns = await prisma.ddns.findUnique({
                where: {
                    url
                }
            })
            return ddns;
        } catch (error) {
            console.error("An error occured:", error);
            return null;
        }
    }

    async deleteDDNS(id) {
        if (!id) return null;
        try {
            const del = await prisma.ddns.delete({
                where: {
                    id
                }
            })
            return del;
        } catch (error) {
            console.error("An error occured:", error);
            return null;
        }
    }

    async getPendingTransactions({ maxAgeMs }) {
        const cutoff = new Date(Date.now() - maxAgeMs);
        try {
            const transactions = await prisma.mpesa.findMany({
                where: {
                    status: {
                        not: 'COMPLETE'
                    },
                    createdAt: {
                        gte: cutoff
                    }
                }
            });

            return transactions.filter(tx => {
                const code = tx.reqcode;
                const isUpperCase = code && code === code.toUpperCase();
                const isFailed = tx.status === 'FAILED';
                return !(isUpperCase && isFailed);
            });
        } catch (error) {
            console.error("An error occured:", error);
            return null;
        }
    }

    async createPPPoE(data) {
        if (!data) return null;
        try {
            const created = await prisma.pppoe.create({
                data
            })
            return created;
        } catch (error) {
            console.error("An error occured:", error);
            return null;
        }
    }

    async createPPPoEPlan(data) {
        if (!data) return null;
        try {
            const created = await prisma.pPPoEPlan.create({
                data
            });
            return created;
        } catch (error) {
            console.error("An error occured:", error);
            return null;
        }
    }

    async updatePPPoE(id, data) {
        if (!data || !id) return null;
        try {
            const upd = await prisma.pppoe.update({
                where: {
                    id
                },
                data
            })
            return upd;
        } catch (error) {
            console.error("An error occured:", error);
            return null;
        }
    }

    async getPPPoE(platformID) {
        if (!platformID) return null;
        try {
            const pppoe = await prisma.pppoe.findMany({
                where: {
                    platformID
                }
            })
            return pppoe;
        } catch (error) {
            console.error("An error occured:", error);
            return null;
        }
    }

    async getPPPoEPlans(platformID) {
        if (!platformID) return null;
        try {
            const plans = await prisma.pPPoEPlan.findMany({
                where: {
                    platformID
                }
            });
            return plans;
        } catch (error) {
            console.error("An error occured:", error);
            return null;
        }
    }

    async getPPPoEById(id) {
        if (!id) return null;
        try {
            const pppoe = await prisma.pppoe.findUnique({
                where: {
                    id
                }
            })
            return pppoe;
        } catch (error) {
            console.error("An error occured:", error);
            return null;
        }
    }

    async getPPPoEPlanById(id) {
        if (!id) return null;
        try {
            const plan = await prisma.pPPoEPlan.findUnique({
                where: {
                    id
                }
            });
            return plan;
        } catch (error) {
            console.error("An error occured:", error);
            return null;
        }
    }

    async getPPPoEByPaymentLink(id) {
        if (!id) return null;
        try {
            const pppoe = await prisma.pppoe.findFirst({
                where: {
                    paymentLink: id
                }
            })
            return pppoe;
        } catch (error) {
            console.error("An error occured:", error);
            return null;
        }
    }

    async getPPPoEByAccount(id) {
        if (!id) return null;
        try {
            const pppoe = await prisma.pppoe.findFirst({
                where: {
                    accountNumber: id
                }
            })
            return pppoe;
        } catch (error) {
            console.error("An error occured:", error);
            return null;
        }
    }

    async getAllActivePPPoE() {
        try {
            const pppoe = await prisma.pppoe.findMany({
                where: {
                    status: "active"
                }
            })
            return pppoe;
        } catch (error) {
            console.error("An error occured:", error);
            return null;
        }
    }

    async deletePPPoE(id) {
        if (!id) return null;
        try {
            const del = await prisma.pppoe.delete({
                where: {
                    id
                }
            })
            return del;
        } catch (error) {
            console.error("An error occured:", error);
            return null;
        }
    }

    async getTemplates() {
        try {
            const template = await prisma.template.findMany()
            return template;
        } catch (error) {
            console.error("An error occured:", error);
            return null;
        }
    }

    async getUniqueCode(code, platformID) {
        if (!code) return null;
        try {
            const cod = await prisma.user.findFirst({
                where: { username: code, platformID },
            });

            return cod;
        } catch (error) {
            console.error("Error fetching code:", error);
            throw error;
        }
    }

    async deletePPPoEByHost(host) {
        if (!host) return null;
        try {
            const pppoe = await prisma.pppoe.findFirst({
                where: { station: host }
            })
            if (!pppoe) return null
            const cod = await prisma.pppoe.delete({
                where: { id: pppoe.id },
            });
            return true;
        } catch (error) {
            console.error("Error fetching code:", error);
            throw error;
        }
    }

    async deletePackagesByHost(host) {
        if (!host) return null;
        try {
            const pkg = await prisma.package.findFirst({
                where: { routerHost: host }
            })
            if (!pkg) return null

            const cod = await prisma.package.delete({
                where: { id: pkg.id },
            });
            return true;
        } catch (error) {
            console.error("Error fetching code:", error);
            throw error;
        }
    }

    async getPlatformMikrotikBackUp(platformID) {
        if (!platformID) return null;
        try {
            const backups = await prisma.backUp.findMany({
                where: { platformID }
            })
            return backups;
        } catch (error) {
            console.error("Error fetching backup:", error);
            throw error;
        }
    }

    async getPlatformMikrotikBackUpByHost(platformID, host) {
        if (!platformID || !host) return null;
        try {
            const backup = await prisma.backUp.findFirst({
                where: { platformID, host }
            })
            return backup;
        } catch (error) {
            console.error("Error fetching backup:", error);
            throw error;
        }
    }

    async createPlatformMikrotikBackUp(data) {
        if (!data) return null;
        try {
            const backup = await prisma.backUp.create({
                data
            })

            return backup;
        } catch (error) {
            console.error("Error creating backup:", error);
            throw error;
        }
    }

    async createHomeFibreLead(data) {
        if (!data) return null;
        try {
            const lead = await prisma.homeFibreLead.create({
                data
            })
            return lead;
        } catch (error) {
            console.error("Error creating home fibre lead:", error);
            throw error;
        }
    }

    async getOpenHomeFibreLeadByPhone(platformID, phone) {
        if (!platformID || !phone) return null;
        try {
            const lead = await prisma.homeFibreLead.findFirst({
                where: {
                    platformID,
                    phone,
                    status: "new",
                },
                orderBy: {
                    createdAt: "desc",
                },
            });
            return lead;
        } catch (error) {
            console.error("Error fetching open home fibre lead:", error);
            throw error;
        }
    }

    async deleteHomeFibreLeadById(id, platformID) {
        if (!id || !platformID) return null;
        try {
            const existing = await prisma.homeFibreLead.findFirst({
                where: { id, platformID },
            });
            if (!existing) return null;
            const deleted = await prisma.homeFibreLead.delete({
                where: { id },
            });
            return deleted;
        } catch (error) {
            console.error("Error deleting home fibre lead:", error);
            throw error;
        }
    }

    async getHomeFibreLeadsByPlatform(platformID) {
        if (!platformID) return [];
        try {
            const leads = await prisma.homeFibreLead.findMany({
                where: { platformID },
                orderBy: [
                    { status: "asc" },
                    { createdAt: "desc" }
                ],
            });
            return leads;
        } catch (error) {
            console.error("Error fetching home fibre leads:", error);
            throw error;
        }
    }

    async updateHomeFibreLeadStatus(id, platformID, status) {
        if (!id || !platformID || !status) return null;
        try {
            const existing = await prisma.homeFibreLead.findFirst({
                where: { id, platformID },
            });
            if (!existing) return null;
            const updated = await prisma.homeFibreLead.update({
                where: { id },
                data: { status },
            });
            return updated;
        } catch (error) {
            console.error("Error updating home fibre lead status:", error);
            throw error;
        }
    }

    async deleteHomeFibreLeadsByplatformID(platformID) {
        if (!platformID) return null;
        try {
            await prisma.homeFibreLead.deleteMany({
                where: { platformID },
            });
            return true;
        } catch (error) {
            console.error("Error deleting home fibre leads by platformID:", error);
            throw error;
        }
    }

    async updatePlatformMikrotikBackUp(id, data) {
        if (!id || !data) return null;
        try {
            const backup = await prisma.backUp.update({
                where: {
                    id
                },
                data
            })
            return backup;
        } catch (error) {
            console.error("Error updating backup:", error);
            throw error;
        }
    }

    async deletePlatformMikrotikBackUp(id) {
        if (!id) return null;
        try {
            const delbackup = await prisma.backUp.delete({
                where: {
                    id
                }
            })
            return delbackup;
        } catch (error) {
            console.error("Error deleting backup:", error);
            throw error;
        }
    }

    async deletePlatformMikrotikBackUpByHost(host) {
        if (!host) return null;
        try {
            const delallbackup = await prisma.backUp.deleteMany({
                where: {
                    host: host
                }
            });
            return delallbackup;
        } catch (error) {
            console.error("Error deleting backup:", error);
            throw error;
        }
    }

    async deleteAllPlatformMikrotikBackUp(platformID) {
        if (!platformID) return null;
        try {
            const delallbackup = await prisma.backUp.deleteMany({
                where: {
                    platformID
                }
            })
            return delallbackup;
        } catch (error) {
            console.error("Error deleting backup files:", error);
            throw error;
        }
    }

    async createTwoFa(data) {
        if (!data) return null;
        try {
            const twofa = await prisma.twoFa.create({
                data
            })
            return twofa;
        } catch (error) {
            console.error("Error creating twofa:", error);
            throw error;
        }
    }

    async updateTwoFa(id, data) {
        if (!id || !data) return null;
        try {
            const twofa = await prisma.twoFa.update({
                where: {
                    id
                },
                data
            })
            return twofa;
        } catch (error) {
            console.error("Error updating twofa:", error);
            throw error;
        }
    }

    async deleteGGTwoFa(id) {
        if (!id) return null;
        try {
            const deltwofa = await prisma.twoFa.delete({
                where: {
                    id
                }
            })
            return deltwofa;
        } catch (error) {
            console.error("Error deleting twofa:", error);
            throw error;
        }
    }

    async getTwoFaByAdminID(adminID) {
        if (!adminID) return null;
        try {
            const twofa = await prisma.twoFa.findFirst({
                where: {
                    adminID
                }
            })
            return twofa;
        } catch (error) {
            console.error("Error fetching twofa:", error);
            throw error;
        }
    }

    async createSession(data) {
        if (!data) return null;
        try {
            const session = await prisma.session.create({
                data: {
                    ...data,
                },
            });
            return session;
        } catch (error) {
            console.error("Error creating session:", error);
            throw error;
        }
    }

    async deleteSession(id) {
        if (!id) return null;
        try {
            const session = await prisma.session.delete({
                where: { id },
            });
            return session;
        } catch (error) {
            console.error("Error deleting session:", error);
            throw error;
        }
    }

    async deleteSessionByToken(token) {
        if (!token) return null;
        try {
            const session = await prisma.session.delete({
                where: { token },
            });
            return session;
        } catch (error) {
            console.error("Error deleting session:", error);
            throw error;
        }
    }

    async deleteSessions(platformID) {
        if (!platformID) return null;
        try {
            const result = await prisma.session.deleteMany({
                where: { platformID },
            });
            return result;
        } catch (error) {
            console.error("Error deleting sessions:", error);
            throw error;
        }
    }

    async updateSession(id, data) {
        if (!id || !data) return null;
        try {
            const session = await prisma.session.update({
                where: { id },
                data: {
                    ...data,
                },
            });
            return session;
        } catch (error) {
            console.error("Error updating session:", error);
            throw error;
        }
    }

    async getSessionByID(id) {
        if (!id) return null;
        try {
            const session = await prisma.session.findUnique({
                where: { id },
            });
            return session;
        } catch (error) {
            console.error("Error getting session by token:", error);
            throw error;
        }
    }

    async getSessionByToken(token) {
        if (!token) return null;
        try {
            const session = await prisma.session.findUnique({
                where: { token },
            });
            return session;
        } catch (error) {
            console.error("Error getting session by token:", error);
            throw error;
        }
    }

    async getSessions(adminID) {
        if (!adminID) return null;
        try {
            const sessions = await prisma.session.findMany({
                where: { adminID },
            });
            return sessions;
        } catch (error) {
            console.error("Error getting sessions:", error);
            throw error;
        }
    }

    async createNetworkUsage(data) {
        if (!data) return null;
        try {
            const network = await prisma.networkUsage.create({
                data: {
                    ...data,
                },
            });
            return network;
        } catch (error) {
            console.error("Error creating network:", error);
            throw error;
        }
    }

    async updateNetworkUsage(id, data) {
        if (!id || !data) return null;
        try {
            const network = await prisma.networkUsage.update({
                where: { id },
                data: {
                    ...data,
                },
            });
            return network;
        } catch (error) {
            console.error("Error updating network:", error);
            throw error;
        }
    }

    async getNetworkUsageByPlatform(platformID) {
        if (!platformID) return null;
        try {
            const network = await prisma.networkUsage.findMany({
                where: { platformID },
            });
            return network;
        } catch (error) {
            console.error("Error getting network usage by platform:", error);
            throw error;
        }
    }

    async getDashboardStatsBundle(platformID) {
        if (!platformID) return null;
        try {
            const now = new Date(this.timestamp);
            const startOfToday = new Date(now);
            startOfToday.setHours(0, 0, 0, 0);
            const endOfToday = new Date(now);
            endOfToday.setHours(23, 59, 59, 999);
            const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
            const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
            const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);
            const endOfYesterday = new Date(startOfToday.getTime() - 1);
            const fiveMonthsStart = new Date(now.getFullYear(), now.getMonth() - 6, 1);

            const revenueWhere = {
                platformID,
                status: "COMPLETE",
                service: {
                    notIn: ["bill", "sms", "Mpesa B2B"],
                },
            };

            const [
                codes,
                pppoe,
                packages,
                allPayments,
                dailyPayments,
                yesterdayPayments,
                lastMonthPayments,
                thisMonthPayments,
                recentPayments,
                stations,
                bills,
                funds,
                mostPurchased,
                networkUsage,
                platformConfig,
            ] = await prisma.$transaction([
                prisma.user.findMany({
                    where: { platformID, status: "active" },
                }),
                prisma.pppoe.findMany({
                    where: { platformID },
                }),
                prisma.package.findMany({
                    where: { platformID },
                }),
                prisma.mpesa.findMany({
                    where: revenueWhere,
                    select: { amount: true },
                }),
                prisma.mpesa.findMany({
                    where: {
                        ...revenueWhere,
                        createdAt: { gte: startOfToday, lte: endOfToday },
                    },
                    select: { amount: true },
                }),
                prisma.mpesa.findMany({
                    where: {
                        ...revenueWhere,
                        createdAt: { gte: startOfYesterday, lte: endOfYesterday },
                    },
                    select: { amount: true },
                }),
                prisma.mpesa.findMany({
                    where: {
                        ...revenueWhere,
                        createdAt: { gte: startOfLastMonth, lte: endOfLastMonth },
                    },
                    select: { amount: true },
                }),
                prisma.mpesa.findMany({
                    where: {
                        ...revenueWhere,
                        createdAt: { gte: startOfThisMonth, lte: now },
                    },
                    select: { amount: true },
                }),
                prisma.mpesa.findMany({
                    where: {
                        ...revenueWhere,
                        createdAt: { gte: fiveMonthsStart, lte: startOfThisMonth },
                    },
                    select: { amount: true, createdAt: true },
                }),
                prisma.station.findMany({
                    where: { platformID },
                }),
                prisma.bill.findMany({
                    where: { platformID },
                    select: { amount: true },
                }),
                prisma.funds.findUnique({
                    where: { platformID },
                }),
                prisma.package.findMany({
                    where: { platformID },
                    include: { _count: { select: { users: true } } },
                    orderBy: { users: { _count: "desc" } },
                    take: 1,
                }),
                prisma.networkUsage.findMany({
                    where: { platformID },
                }),
                prisma.platformSetting.findUnique({
                    where: { platformID },
                }),
            ]);

            const sumAmounts = (rows) =>
                rows.reduce((sum, row) => sum + parseFloat(row.amount || "0"), 0);

            const totalRevenue = sumAmounts(allPayments);
            const dailyRevenue = sumAmounts(dailyPayments);
            const yesterdayRevenue = sumAmounts(yesterdayPayments);
            const lastMonthRevenue = sumAmounts(lastMonthPayments);
            const thisMonthRevenue = sumAmounts(thisMonthPayments);

            const months = [];
            for (let i = 2; i <= 6; i += 1) {
                const target = new Date(now.getFullYear(), now.getMonth() - i, 1);
                const monthStart = new Date(target.getFullYear(), target.getMonth(), 1);
                const monthEnd = new Date(target.getFullYear(), target.getMonth() + 1, 0, 23, 59, 59, 999);
                const total = recentPayments
                    .filter((p) => new Date(p.createdAt) >= monthStart && new Date(p.createdAt) <= monthEnd)
                    .reduce((sum, p) => sum + parseFloat(p.amount || "0"), 0);
                months.push({
                    month: monthStart.toLocaleString("default", { month: "long" }),
                    totalRevenue: total,
                });
            }

            const totalBills = bills.reduce((acc, b) => acc + Number(b.amount || 0), 0);

            return {
                codes,
                pppoe,
                packages,
                totalRevenue,
                dailyRevenue,
                yesterdayRevenue,
                lastMonthRevenue,
                thisMonthRevenue,
                months,
                stations,
                totalBills,
                funds,
                mostPurchased: mostPurchased[0] || null,
                networkUsage,
                platformConfig,
            };
        } catch (error) {
            console.error("Error fetching dashboard bundle:", error);
            throw error;
        }
    }

    async getDashboardStats(platformID) {
        if (!platformID) return null;
        try {
            const stats = await prisma.dashboardStats.findUnique({
                where: { platformID },
            });
            return stats;
        } catch (error) {
            console.error("Error fetching dashboard stats record:", error);
            throw error;
        }
    }

    async getStationDashboardStats(platformID, stationId) {
        if (!platformID || !stationId) return null;
        try {
            const stats = await prisma.stationDashboardStats.findUnique({
                where: { platformID_stationId: { platformID, stationId } },
            });
            return stats;
        } catch (error) {
            console.error("Error fetching station dashboard stats record:", error);
            throw error;
        }
    }

    async upsertDashboardStats(platformID, data) {
        if (!platformID || !data) return null;
        try {
            const stats = await prisma.dashboardStats.upsert({
                where: { platformID },
                update: {
                    ...data,
                },
                create: {
                    platformID,
                    ...data,
                },
            });
            return stats;
        } catch (error) {
            console.error("Error upserting dashboard stats:", error);
            throw error;
        }
    }

    async upsertStationDashboardStats(platformID, stationId, data) {
        if (!platformID || !stationId || !data) return null;
        try {
            const stats = await prisma.stationDashboardStats.upsert({
                where: { platformID_stationId: { platformID, stationId } },
                update: {
                    ...data,
                },
                create: {
                    platformID,
                    stationId,
                    ...data,
                },
            });
            return stats;
        } catch (error) {
            console.error("Error upserting station dashboard stats:", error);
            throw error;
        }
    }

    buildNetworkUsageStats(rawNetworkUsage) {
        const networkusage = Array.isArray(rawNetworkUsage) ? rawNetworkUsage : [];
        const now = new Date();

        const dailyUsage = networkusage.filter((u) =>
            new Date(u.createdAt) >= startOfDay(now) && new Date(u.createdAt) <= endOfDay(now)
        );
        const monthlyUsage = networkusage.filter((u) =>
            new Date(u.createdAt) >= startOfMonth(now) && new Date(u.createdAt) <= endOfMonth(now)
        );

        const sumUsage = (usage) =>
            usage.reduce(
                (acc, u) => {
                    const rx = Number(u.rx) || 0;
                    const tx = Number(u.tx) || 0;
                    acc.rx += rx;
                    acc.tx += tx;
                    acc.totalBandwidth += rx + tx;
                    return acc;
                },
                { rx: 0, tx: 0, totalBandwidth: 0 }
            );

        const services = ["pppoe", "hotspot"];

        const dailyStats = services.map((service) => ({
            service,
            period: "daily",
            ...sumUsage(dailyUsage.filter((u) => u.service === service)),
        }));

        const monthlyStats = services.map((service) => ({
            service,
            period: "monthly",
            ...sumUsage(monthlyUsage.filter((u) => u.service === service)),
        }));

        const overallPerService = services.map((service) => ({
            service,
            period: "overall",
            ...sumUsage(networkusage.filter((u) => u.service === service)),
        }));

        const overallDaily = { service: "Overall", period: "daily", ...sumUsage(dailyUsage) };
        const overallMonthly = { service: "Overall", period: "monthly", ...sumUsage(monthlyUsage) };
        const overallAllTime = { service: "Overall", period: "overall", ...sumUsage(networkusage) };

        return [
            ...dailyStats,
            overallDaily,
            ...monthlyStats,
            overallMonthly,
            ...overallPerService,
            overallAllTime,
        ];
    }

    async buildDashboardStatsPayload(platformID, options = {}) {
        if (!platformID) return null;
        const dashboard = await this.getDashboardStatsBundle(platformID);
        if (!dashboard) return null;

        const {
            codes = [],
            pppoe = [],
            packages = [],
            totalRevenue = 0,
            dailyRevenue = 0,
            yesterdayRevenue = 0,
            lastMonthRevenue = 0,
            thisMonthRevenue = 0,
            months = [],
            stations = [],
            totalBills = 0,
            funds: allfunds = null,
            mostPurchased = null,
            networkUsage: rawNetworkUsage = [],
            platformConfig: platformsettings = null,
        } = dashboard || {};

        const isB2B = !!platformsettings?.IsB2B;

        let balance = 0, withdrawals = 0, shortCodeBalance = 0;
        if (allfunds) {
            balance = allfunds.balance;
            withdrawals = allfunds.withdrawals;
            shortCodeBalance = allfunds.shortCodeBalance;
        }

        const existing = await this.getDashboardStats(platformID);
        const previousStats = existing?.stats || {};

        const onlineHotspotUsers = Number.isFinite(options?.onlineHotspotUsers)
            ? options.onlineHotspotUsers
            : Number(previousStats.totalUsersOnline) || 0;
        const onlinePPPoEUsers = Number.isFinite(options?.onlinePPPoEUsers)
            ? options.onlinePPPoEUsers
            : Number(previousStats.totalPPPoEUsersOnline) || 0;

        const stats = {
            totalUsers: codes.length,
            totalPPPoEUsers: pppoe.length,
            totalUsersOnline: onlineHotspotUsers,
            totalPPPoEUsersOnline: onlinePPPoEUsers,
            totalPackages: packages.length,
            totalRevenue: totalRevenue || 0,
            dailyRevenue: dailyRevenue || 0,
            yesterdayRevenue: yesterdayRevenue || 0,
            routers: stations.length,
            thismonthRevenue: thisMonthRevenue || 0,
            lastmonthRevenue: lastMonthRevenue || 0,
            months,
            mostpurchased: mostPurchased ? mostPurchased.name : "",
        };

        const funds = {
            balance,
            withdrawals,
            bills: totalBills || 0,
            shortCodeBalance,
        };

        const networkusage = this.buildNetworkUsageStats(rawNetworkUsage);

        return {
            stats,
            funds,
            networkusage,
            IsB2B: isB2B,
        };
    }

    async getStationDashboardStatsBundle(platformID, stationId) {
        if (!platformID || !stationId) return null;
        try {
            const station = await prisma.station.findUnique({
                where: { id: stationId },
            });
            if (!station || station.platformID !== platformID) return null;

            const now = new Date(this.timestamp);
            const startOfToday = new Date(now);
            startOfToday.setHours(0, 0, 0, 0);
            const endOfToday = new Date(now);
            endOfToday.setHours(23, 59, 59, 999);
            const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
            const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
            const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);
            const endOfYesterday = new Date(startOfToday.getTime() - 1);
            const fiveMonthsStart = new Date(now.getFullYear(), now.getMonth() - 6, 1);

            const revenueWhere = {
                platformID,
                status: "COMPLETE",
                service: {
                    notIn: ["bill", "sms", "Mpesa B2B"],
                },
            };

            const [
                codes,
                pppoe,
                packages,
                allPayments,
                dailyPayments,
                yesterdayPayments,
                lastMonthPayments,
                thisMonthPayments,
                recentPayments,
                bills,
                funds,
                mostPurchased,
                networkUsage,
                platformConfig,
            ] = await prisma.$transaction([
                prisma.user.findMany({
                    where: { platformID, status: "active" },
                }),
                prisma.pppoe.findMany({
                    where: { platformID, station: station.mikrotikHost || "" },
                }),
                prisma.package.findMany({
                    where: { platformID },
                }),
                prisma.mpesa.findMany({
                    where: revenueWhere,
                    select: { amount: true },
                }),
                prisma.mpesa.findMany({
                    where: {
                        ...revenueWhere,
                        createdAt: { gte: startOfToday, lte: endOfToday },
                    },
                    select: { amount: true },
                }),
                prisma.mpesa.findMany({
                    where: {
                        ...revenueWhere,
                        createdAt: { gte: startOfYesterday, lte: endOfYesterday },
                    },
                    select: { amount: true },
                }),
                prisma.mpesa.findMany({
                    where: {
                        ...revenueWhere,
                        createdAt: { gte: startOfLastMonth, lte: endOfLastMonth },
                    },
                    select: { amount: true },
                }),
                prisma.mpesa.findMany({
                    where: {
                        ...revenueWhere,
                        createdAt: { gte: startOfThisMonth, lte: now },
                    },
                    select: { amount: true },
                }),
                prisma.mpesa.findMany({
                    where: {
                        ...revenueWhere,
                        createdAt: { gte: fiveMonthsStart, lte: startOfThisMonth },
                    },
                    select: { amount: true, createdAt: true },
                }),
                prisma.bill.findMany({
                    where: { platformID },
                    select: { amount: true },
                }),
                prisma.funds.findUnique({
                    where: { platformID },
                }),
                prisma.package.findMany({
                    where: { platformID },
                    include: { _count: { select: { users: true } } },
                    orderBy: { users: { _count: "desc" } },
                    take: 1,
                }),
                prisma.networkUsage.findMany({
                    where: { platformID, station: station.id },
                }),
                prisma.platformSetting.findUnique({
                    where: { platformID },
                }),
            ]);

            const sumAmounts = (rows) =>
                rows.reduce((sum, row) => sum + parseFloat(row.amount || "0"), 0);

            const totalRevenue = sumAmounts(allPayments);
            const dailyRevenue = sumAmounts(dailyPayments);
            const yesterdayRevenue = sumAmounts(yesterdayPayments);
            const lastMonthRevenue = sumAmounts(lastMonthPayments);
            const thisMonthRevenue = sumAmounts(thisMonthPayments);

            const months = [];
            for (let i = 2; i <= 6; i += 1) {
                const target = new Date(now.getFullYear(), now.getMonth() - i, 1);
                const monthStart = new Date(target.getFullYear(), target.getMonth(), 1);
                const monthEnd = new Date(target.getFullYear(), target.getMonth() + 1, 0, 23, 59, 59, 999);
                const total = recentPayments
                    .filter((p) => new Date(p.createdAt) >= monthStart && new Date(p.createdAt) <= monthEnd)
                    .reduce((sum, p) => sum + parseFloat(p.amount || "0"), 0);
                months.push({
                    month: monthStart.toLocaleString("default", { month: "long" }),
                    totalRevenue: total,
                });
            }

            const totalBills = bills.reduce((acc, b) => acc + Number(b.amount || 0), 0);

            return {
                station,
                codes,
                pppoe,
                packages,
                totalRevenue,
                dailyRevenue,
                yesterdayRevenue,
                lastMonthRevenue,
                thisMonthRevenue,
                months,
                totalBills,
                funds,
                mostPurchased: mostPurchased[0] || null,
                networkUsage,
                platformConfig,
            };
        } catch (error) {
            console.error("Error fetching station dashboard bundle:", error);
            throw error;
        }
    }

    async buildStationDashboardStatsPayload(platformID, stationId, options = {}) {
        if (!platformID || !stationId) return null;
        const dashboard = await this.getStationDashboardStatsBundle(platformID, stationId);
        if (!dashboard) return null;

        const {
            station,
            codes = [],
            pppoe = [],
            packages = [],
            totalRevenue = 0,
            dailyRevenue = 0,
            yesterdayRevenue = 0,
            lastMonthRevenue = 0,
            thisMonthRevenue = 0,
            months = [],
            totalBills = 0,
            funds: allfunds = null,
            mostPurchased = null,
            networkUsage: rawNetworkUsage = [],
            platformConfig: platformsettings = null,
        } = dashboard || {};

        const isB2B = !!platformsettings?.IsB2B;

        let balance = 0, withdrawals = 0, shortCodeBalance = 0;
        if (allfunds) {
            balance = allfunds.balance;
            withdrawals = allfunds.withdrawals;
            shortCodeBalance = allfunds.shortCodeBalance;
        }

        const existing = await this.getStationDashboardStats(platformID, stationId);
        const previousStats = existing?.stats || {};

        const onlineHotspotUsers = Number.isFinite(options?.onlineHotspotUsers)
            ? options.onlineHotspotUsers
            : Number(previousStats.totalUsersOnline) || 0;
        const onlinePPPoEUsers = Number.isFinite(options?.onlinePPPoEUsers)
            ? options.onlinePPPoEUsers
            : Number(previousStats.totalPPPoEUsersOnline) || 0;

        const stats = {
            totalUsers: codes.length,
            totalPPPoEUsers: pppoe.length,
            totalUsersOnline: onlineHotspotUsers,
            totalPPPoEUsersOnline: onlinePPPoEUsers,
            totalPackages: packages.length,
            totalRevenue: totalRevenue || 0,
            dailyRevenue: dailyRevenue || 0,
            yesterdayRevenue: yesterdayRevenue || 0,
            routers: station ? 1 : 0,
            thismonthRevenue: thisMonthRevenue || 0,
            lastmonthRevenue: lastMonthRevenue || 0,
            months,
            mostpurchased: mostPurchased ? mostPurchased.name : "",
        };

        const funds = {
            balance,
            withdrawals,
            bills: totalBills || 0,
            shortCodeBalance,
        };

        const networkusage = this.buildNetworkUsageStats(rawNetworkUsage);

        return {
            stats,
            funds,
            networkusage,
            IsB2B: isB2B,
        };
    }

    async rebuildDashboardStats(platformID, options = {}) {
        const payload = await this.buildDashboardStatsPayload(platformID, options);
        if (!payload) return null;
        await this.upsertDashboardStats(platformID, {
            stats: payload.stats,
            funds: payload.funds,
            networkUsage: payload.networkusage,
            isB2B: payload.IsB2B,
        });
        const stations = await prisma.station.findMany({
            where: { platformID },
            select: { id: true },
        });
        for (const station of stations) {
            await this.rebuildStationDashboardStats(platformID, station.id, options);
        }
        return payload;
    }

    async rebuildStationDashboardStats(platformID, stationId, options = {}) {
        const payload = await this.buildStationDashboardStatsPayload(platformID, stationId, options);
        if (!payload) return null;
        await this.upsertStationDashboardStats(platformID, stationId, {
            stats: payload.stats,
            funds: payload.funds,
            networkUsage: payload.networkusage,
            isB2B: payload.IsB2B,
        });
        return payload;
    }

    async seedDashboardStatsFromMpesa(options = {}) {
        const {
            platformIDs = null,
            includeAllPlatforms = true,
            dryRun = false,
        } = options || {};

        try {
            let ids = [];
            if (Array.isArray(platformIDs) && platformIDs.length) {
                ids = platformIDs;
            } else {
                const [mpesaPlatforms, platforms] = await prisma.$transaction([
                    prisma.mpesa.findMany({
                        distinct: ["platformID"],
                        select: { platformID: true },
                    }),
                    includeAllPlatforms
                        ? prisma.platform.findMany({
                              select: { platformID: true },
                          })
                        : Promise.resolve([]),
                ]);

                const seen = new Set();
                mpesaPlatforms.forEach((p) => {
                    if (p?.platformID) seen.add(p.platformID);
                });
                platforms.forEach((p) => {
                    if (p?.platformID) seen.add(p.platformID);
                });
                ids = Array.from(seen);
            }

            let seeded = 0;
            let skipped = 0;
            const errors = [];

            for (const platformID of ids) {
                if (!platformID) {
                    skipped += 1;
                    continue;
                }

                try {
                    const payload = await this.buildDashboardStatsPayload(platformID, options);
                    if (!payload) {
                        skipped += 1;
                        continue;
                    }

                    if (!dryRun) {
                        await this.upsertDashboardStats(platformID, {
                            stats: payload.stats,
                            funds: payload.funds,
                            networkUsage: payload.networkusage,
                            isB2B: payload.IsB2B,
                        });
                        const stations = await prisma.station.findMany({
                            where: { platformID },
                            select: { id: true },
                        });
                        for (const station of stations) {
                            await this.rebuildStationDashboardStats(platformID, station.id, options);
                        }
                    }

                    seeded += 1;
                } catch (error) {
                    errors.push({
                        platformID,
                        error: error?.message || String(error),
                    });
                }
            }

            return {
                totalPlatforms: ids.length,
                seeded,
                skipped,
                errors,
                dryRun: !!dryRun,
            };
        } catch (error) {
            console.error("Error seeding dashboard stats from mpesa:", error);
            throw error;
        }
    }

    async getNetworkUsageByStation(stationID, service, period, date) {
        if (!stationID || !service || !period || !date) return null;
        try {
            const network = await prisma.networkUsage.findFirst({
                where: { station: stationID, service, period, date },
            });
            return network;
        } catch (error) {
            console.error("Error getting network usage by station:", error);
            throw error;
        }
    }

    async createPlatformBilling(data) {
        if (!data) return null;
        try {
            const bill = await prisma.bill.create({
                data: {
                    ...data
                }
            })
            return bill;
        } catch (error) {
            console.error("Error creating data:", error);
            throw error;
        }
    }

    async getPlatformBilling(platformID) {
        if (!platformID) return null;
        try {
            const bills = await prisma.bill.findMany({
                where: { platformID },
            });
            return bills;
        } catch (error) {
            console.error("Error getting bills:", error);
            throw error;
        }
    }

    async getPlatformBillingByID(id) {
        if (!id) return null;
        try {
            const bill = await prisma.bill.findUnique({
                where: { id },
            });
            return bill;
        } catch (error) {
            console.error("Error getting bill:", error);
            throw error;
        }
    }

    async getPlatformBillingByName(name, platformID) {
        if (!name || !platformID) return null;
        try {
            const bill = await prisma.bill.findFirst({
                where: {
                    name,
                    platformID,
                },
            });
            return bill;
        } catch (error) {
            console.error("Error getting bill by name:", error);
            throw error;
        }
    }

    async updatePlatformBilling(id, data) {
        if (!id || !data) return null;
        try {
            const bill = await prisma.bill.update({
                where: { id },
                data: {
                    ...data,
                },
            });
            return bill;
        } catch (error) {
            console.error("Error updating bill:", error);
            throw error;
        }
    }

    async deletePlatformBilling(id) {
        if (!id) return null;
        try {
            const bill = await prisma.bill.delete({
                where: { id },
            });
            return bill;
        } catch (error) {
            console.error("Error deleting bill:", error);
            throw error;
        }
    }

    async getTotalBills(platformID) {
        if (!platformID) return null;
        try {
            const bills = await prisma.bill.findMany({
                where: { platformID },
                select: { amount: true },
            });
            const total = bills.reduce((acc, b) => acc + Number(b.amount), 0);
            return total;
        } catch (error) {
            console.error("Error getting total bills:", error);
            throw error;
        }
    }

    async deleteTwoFa(platformID) {
        if (!platformID) return null;
        try {
            await prisma.twoFa.deleteMany({
                where: { platformID },
            });
            return true;
        } catch (error) {
            console.error("Error deleting twoFa:", error);
            throw error;
        }
    }

    async deletSessions(platformID) {
        if (!platformID) return null;
        try {
            await prisma.session.deleteMany({
                where: { platformID },
            });
            return true;
        } catch (error) {
            console.error("Error deleting session:", error);
            throw error;
        }
    }

    async deleteBills(platformID) {
        if (!platformID) return null;
        try {
            await prisma.bill.deleteMany({
                where: { platformID },
            });
            return true;
        } catch (error) {
            console.error("Error deleting bills:", error);
            throw error;
        }
    }

    async getPlatformPlugins(platformID) {
        if (!platformID) return null;
        try {
            return await prisma.platformPlugin.findMany({
                where: { platformID },
            });
        } catch (error) {
            console.error("Error fetching platform plugins:", error);
            throw error;
        }
    }

    async getPlatformPlugin(platformID, serviceKey) {
        if (!platformID || !serviceKey) return null;
        try {
            return await prisma.platformPlugin.findFirst({
                where: { platformID, serviceKey },
            });
        } catch (error) {
            console.error("Error fetching platform plugin:", error);
            throw error;
        }
    }

    async createPlatformPlugin(data) {
        if (!data) return null;
        try {
            return await prisma.platformPlugin.create({ data });
        } catch (error) {
            console.error("Error creating platform plugin:", error);
            throw error;
        }
    }

    async updatePlatformPlugin(platformID, serviceKey, data) {
        if (!platformID || !serviceKey || !data) return null;
        try {
            return await prisma.platformPlugin.update({
                where: {
                    platformID_serviceKey: {
                        platformID,
                        serviceKey,
                    },
                },
                data,
            });
        } catch (error) {
            console.error("Error updating platform plugin:", error);
            throw error;
        }
    }

    async deletePlatformPlugin(platformID, serviceKey) {
        if (!platformID || !serviceKey) return null;
        try {
            return await prisma.platformPlugin.delete({
                where: {
                    platformID_serviceKey: {
                        platformID,
                        serviceKey,
                    },
                },
            });
        } catch (error) {
            console.error("Error deleting platform plugin:", error);
            throw error;
        }
    }

    async getPlatformTerms(platformID) {
        if (!platformID) return null;
        try {
            return await prisma.platformTerms.findUnique({
                where: { platformID },
            });
        } catch (error) {
            console.error("Error fetching platform terms:", error);
            throw error;
        }
    }

    async upsertPlatformTerms(platformID, data) {
        if (!platformID || !data) return null;
        try {
            return await prisma.platformTerms.upsert({
                where: { platformID },
                update: { ...data },
                create: {
                    platformID,
                    ...data,
                },
            });
        } catch (error) {
            console.error("Error upserting platform terms:", error);
            throw error;
        }
    }

    async getSidebarLinks(platformID, adminId) {
        if (!platformID || !adminId) return null;
        try {
            return await prisma.platformSidebarLink.findMany({
                where: { platformID, adminId },
            });
        } catch (error) {
            console.error("Error fetching sidebar links:", error);
            throw error;
        }
    }

    async upsertSidebarLink(platformID, adminId, linkKey, data) {
        if (!platformID || !adminId || !linkKey || !data) return null;
        try {
            return await prisma.platformSidebarLink.upsert({
                where: {
                    platformID_adminId_linkKey: {
                        platformID,
                        adminId,
                        linkKey,
                    },
                },
                update: { ...data },
                create: {
                    platformID,
                    adminId,
                    linkKey,
                    ...data,
                },
            });
        } catch (error) {
            console.error("Error upserting sidebar link:", error);
            throw error;
        }
    }

    async deleteNetworkUsages(platformID) {
        if (!platformID) return null;
        try {
            await prisma.networkUsage.deleteMany({
                where: { platformID },
            });
            return true;
        } catch (error) {
            console.error("Error deleting NetworkUsages:", error);
            throw error;
        }
    }

    async deleteBackups(platformID) {
        if (!platformID) return null;
        try {
            await prisma.backUp.deleteMany({
                where: { platformID },
            });
            return true;
        } catch (error) {
            console.error("Error deleting backups:", error);
            throw error;
        }
    }

    async getPlatformSMS(platformID) {
        if (!platformID) return null;
        try {
            const sms = await prisma.sms.findUnique({
                where: { platformID },
            });
            return sms;
        } catch (error) {
            console.error("Error getting sms:", error);
            throw error;
        }
    }

    async getPlatformEmailTemplate(platformID) {
        if (!platformID) return null;
        try {
            const email = await prisma.email.findUnique({
                where: { platformID },
            });
            return email;
        } catch (error) {
            console.error("Error getting email:", error);
            throw error;
        }
    }

    async createPlatformSMS(data) {
        if (!data) return null;
        try {
            const sms = await prisma.sms.create({
                data: {
                    ...data
                }
            })
            return sms;
        } catch (error) {
            console.error("Error creating data:", error);
            throw error;
        }
    }

    async updatePlatformSMS(platformID, updateData) {
        if (!platformID || !updateData) return null;
        try {
            const sms = await prisma.sms.update({
                where: { platformID },
                data: updateData,
            });
            return sms;
        } catch (err) {
            console.error("Update Platform SMS error:", err);
            throw err;
        }
    }

    async createPlatformEmailTemplate(data) {
        if (!data) return null;
        try {
            const sms = await prisma.email.create({
                data: {
                    ...data
                }
            })
            return sms;
        } catch (error) {
            console.error("Error creating data:", error);
            throw error;
        }
    }

    async updatePlatformEmailTemplate(platformID, updateData) {
        if (!platformID || !updateData) return null;
        try {
            const email = await prisma.email.update({
                where: { platformID },
                data: updateData,
            });
            return email;
        } catch (err) {
            console.error("Update Platform Email error:", err);
            throw err;
        }
    }

    async deletePlatformSMS(platformID) {
        if (!platformID) return null;
        try {
            await prisma.sms.deleteMany({
                where: { platformID },
            });
            return true;
        } catch (error) {
            console.error("Error deleting sms:", error);
            throw error;
        }
    }

    async deletePlatformEmailTemplate(platformID) {
        if (!platformID) return null;
        try {
            await prisma.email.deleteMany({
                where: { platformID },
            });
            return true;
        } catch (error) {
            console.error("Error deleting email templates:", error);
            throw error;
        }
    }

    async createScheduledSms(data) {
        if (!data) return null;
        try {
            const scheduled = await prisma.scheduledSms.create({ data });
            return scheduled;
        } catch (error) {
            console.error("Error creating scheduled SMS:", error);
            throw error;
        }
    }

    async getDueScheduledSms(platformID, now) {
        if (!platformID) return [];
        try {
            const scheduled = await prisma.scheduledSms.findMany({
                where: {
                    platformID,
                    status: "scheduled",
                    scheduledAt: { lte: now || new Date() },
                },
                orderBy: { scheduledAt: "asc" },
            });
            return scheduled;
        } catch (error) {
            console.error("Error fetching scheduled SMS:", error);
            throw error;
        }
    }

    async updateScheduledSms(id, data) {
        if (!id || !data) return null;
        try {
            const updated = await prisma.scheduledSms.update({
                where: { id },
                data,
            });
            return updated;
        } catch (error) {
            console.error("Error updating scheduled SMS:", error);
            throw error;
        }
    }

    async createScheduledInternalSms(data) {
        if (!data) return null;
        try {
            const scheduled = await prisma.scheduledInternalSms.create({ data });
            return scheduled;
        } catch (error) {
            console.error("Error creating scheduled internal SMS:", error);
            throw error;
        }
    }

    async getDueScheduledInternalSms(now) {
        try {
            const scheduled = await prisma.scheduledInternalSms.findMany({
                where: {
                    status: "scheduled",
                    scheduledAt: { lte: now || new Date() },
                },
                orderBy: { scheduledAt: "asc" },
            });
            return scheduled;
        } catch (error) {
            console.error("Error fetching scheduled internal SMS:", error);
            throw error;
        }
    }

    async updateScheduledInternalSms(id, data) {
        if (!id || !data) return null;
        try {
            const updated = await prisma.scheduledInternalSms.update({
                where: { id },
                data,
            });
            return updated;
        } catch (error) {
            console.error("Error updating scheduled internal SMS:", error);
            throw error;
        }
    }

    async createScheduledInternalEmail(data) {
        if (!data) return null;
        try {
            const scheduled = await prisma.scheduledInternalEmail.create({ data });
            return scheduled;
        } catch (error) {
            console.error("Error creating scheduled internal email:", error);
            throw error;
        }
    }

    async getDueScheduledInternalEmail(now) {
        try {
            const scheduled = await prisma.scheduledInternalEmail.findMany({
                where: {
                    status: "scheduled",
                    scheduledAt: { lte: now || new Date() },
                },
                orderBy: { scheduledAt: "asc" },
            });
            return scheduled;
        } catch (error) {
            console.error("Error fetching scheduled internal email:", error);
            throw error;
        }
    }

    async updateScheduledInternalEmail(id, data) {
        if (!id || !data) return null;
        try {
            const updated = await prisma.scheduledInternalEmail.update({
                where: { id },
                data,
            });
            return updated;
        } catch (error) {
            console.error("Error updating scheduled internal email:", error);
            throw error;
        }
    }

    async getSettings() {
        try {
            const settings = await prisma.setting.findFirst();
            return settings;
        } catch (error) {
            console.log("An error occured", error);
            return false;
        }
    }

    async createPlatformSettings(data) {
        if (!data) return null;
        try {
            const settings = await prisma.setting.create({
                data: {
                    ...data,
                },
            });
            return settings;
        } catch (error) {
            console.error("Error creating settings:", error);
            throw error;
        }
    }

    async updatePlatformSettings(id, data) {
        if (!id || !data) return null;
        try {
            const settings = await prisma.setting.update({
                where: { id },
                data: {
                    ...data,
                },
            });
            return settings;
        } catch (error) {
            console.error("Error updating settings:", error);
            throw error;
        }
    }

    async getConfigFiles() {
        try {
            const configs = await prisma.config.findMany();
            return configs;
        } catch (error) {
            console.error("Error fetching configuration files:", error);
            throw error;
        }
    }

    async createConfigFile(data) {
        if (!data) return null;
        try {
            const config = await prisma.config.create({
                data
            });
            return config;
        } catch (error) {
            console.error("Error creating configuration file:", error);
            throw error;
        }
    }

    async updateConfigFile(id, data) {
        if (!id || !data) return null;
        try {
            const config = await prisma.config.update({
                where: { id },
                data
            });
            return config;
        } catch (error) {
            console.error("Error updating configuration file:", error);
            throw error;
        }
    }

    async deleteConfigFile(id) {
        if (!id) return null;
        try {
            const config = await prisma.config.delete({
                where: { id },
            });
            return config;
        } catch (error) {
            console.error("Error deleting configuration file:", error);
            throw error;
        }
    }

    async getConfigFileByID(id) {
        if (!id) return null;
        try {
            const config = await prisma.config.findUnique({
                where: { id },
            });
            return config;
        } catch (error) {
            console.error("Error fetching configuration file by ID:", error);
            throw error;
        }
    }

    async createBlockedUser(data) {
        if (!data) return null;
        try {
            const blockedUser = await prisma.blockedUser.create({
                data
            });
            return blockedUser;
        } catch (error) {
            console.error("Error creating blocked user:", error);
            throw error;
        }
    }

    async updateBlockedUser(id, data) {
        if (!id || !data) return null;
        try {
            const blockedUser = await prisma.blockedUser.update({
                where: { id },
                data
            });
            return blockedUser;
        } catch (error) {
            console.error("Error updating blocked user:", error);
            throw error;
        }
    }

    async deleteBlockedUser(id) {
        if (!id) return null;
        try {
            const blockedUser = await prisma.blockedUser.delete({
                where: { id },
            });
            return blockedUser;
        } catch (error) {
            console.error("Error deleting blocked user:", error);
            throw error;
        }
    }

    async getBlockedUserByPhone(phone, platformID) {
        if (!phone) return null;
        try {
            const blockedUser = await prisma.blockedUser.findFirst({
                where: platformID ? { phone, platformID } : { phone },
            });
            return blockedUser;
        } catch (error) {
            console.error("Error fetching blocked user by phone:", error);
            throw error;
        }
    }

    async getBlockedUsersByPlatform(platformID) {
        if (!platformID) return null;
        try {
            const blockedUser = await prisma.blockedUser.findMany({
                where: { platformID },
            });
            return blockedUser;
        } catch (error) {
            console.error("Error fetching blocked users by platform:", error);
            throw error;
        }
    }

    async deleteBlockedUsersByplatformID(platformID) {
        if (!platformID) return null;
        try {
            await prisma.blockedUser.deleteMany({
                where: { platformID },
            });
            return true;
        } catch (error) {
            console.error("Error deleting blocked users by platformID:", error);
            throw error;
        }
    }

    async deleteBlockedUserByID(id) {
        if (!id) return null;
        try {
            await prisma.blockedUser.delete({
                where: { id },
            });
            return true;
        } catch (error) {
            console.error("Error deleting blocked user by ID:", error);
            throw error;
        }
    }

    async getBlockedUserByID(id) {
        if (!id) return null;
        try {
            const blockedUser = await prisma.blockedUser.findUnique({
                where: { id },
            });
            return blockedUser;
        } catch (error) {
            console.error("Error fetching blocked user by ID:", error);
            throw error;
        }
    }

    async searchMpesa({ platformID, search, limit, offset, date }) {
        const where = {
            platformID,
            ...(search && {
                OR: [
                    { phone: { contains: search } },
                    { code: { contains: search } },
                    { account: { contains: search } },
                    { status: { contains: search } },
                ],
            }),
        };

        if (date === "today") {
            where.createdAt = {
                gte: new Date(new Date().setHours(0, 0, 0, 0)),
            };
        }

        const [rows, totalCount] = await Promise.all([
            prisma.mpesa.findMany({
                where,
                orderBy: { createdAt: "desc" },
                skip: offset,
                take: limit,
            }),
            prisma.mpesa.count({ where }),
        ]);

        return { rows, totalCount };
    }

    async searchUsers({ platformID, search, limit, offset }) {
        const where = {
            platformID,
            ...(search && {
                OR: [
                    { username: { contains: search } },
                    { mac: { contains: search } },
                    { phone: { contains: search } },
                    { id: { contains: search } },
                    { status: { contains: search } },
                ],
            }),
        };

        const [rows, totalCount] = await Promise.all([
            prisma.user.findMany({
                where,
                include: { package: true },
                skip: offset,
                take: limit,
                orderBy: { createdAt: "desc" },
            }),
            prisma.user.count({ where }),
        ]);

        return { rows, totalCount };
    }

    async searchPackages({ platformID, search, limit, offset }) {
        const where = {
            platformID,
            ...(search && {
                OR: [
                    { name: { contains: search } },
                    { period: { contains: search } },
                    { price: { contains: search } },
                    { speed: { contains: search } },
                    { devices: { contains: search } },
                    { usage: { contains: search } },
                    { category: { equals: search } },
                    { routerHost: { contains: search } },
                    { routerName: { contains: search } },
                    { pool: { contains: search } },
                    { status: { contains: search } },
                ],
            }),
        };

        const [rows, totalCount] = await Promise.all([
            prisma.package.findMany({
                where,
                skip: offset,
                take: limit,
                orderBy: { createdAt: "desc" },
            }),
            prisma.package.count({ where }),
        ]);

        return { rows, totalCount };
    }

    async searchStations({ platformID, search, limit, offset }) {
        const where = {
            platformID,
            ...(search && {
                OR: [
                    { name: { contains: search } },
                    { mikrotikHost: { contains: search } },
                    { mikrotikPublicHost: { contains: search } },
                    { mikrotikUser: { contains: search } },
                    { mikrotikDDNS: { contains: search } },
                    { mikrotikWebfigHost: { contains: search } },
                ],
            }),
        };

        const [rows, totalCount] = await Promise.all([
            prisma.station.findMany({
                where,
                skip: offset,
                take: limit,
                orderBy: { createdAt: "desc" },
            }),
            prisma.station.count({ where }),
        ]);

        return { rows, totalCount };
    }

    async searchPppoe({ platformID, search, limit, offset }) {
        const where = {
            platformID,
            ...(search && {
                OR: [
                    { name: { contains: search } },
                    { profile: { contains: search } },
                    { servicename: { contains: search } },
                    { station: { contains: search } },
                    { pool: { contains: search } },
                    { clientname: { contains: search } },
                    { clientpassword: { contains: search } },
                    { status: { contains: search } },
                    { price: { contains: search } },
                    { amount: { contains: search } },
                ],
            }),
        };

        const [rows, totalCount] = await Promise.all([
            prisma.pppoe.findMany({
                where,
                skip: offset,
                take: limit,
                orderBy: { createdAt: "desc" },
            }),
            prisma.pppoe.count({ where }),
        ]);

        return { rows, totalCount };
    }

    async searchModerators({ platformID, search, limit, offset }) {
        const where = {
            platformID,
            role: { not: "superuser" },
            ...(search && {
                OR: [
                    { adminID: { contains: search } },
                    { name: { contains: search } },
                    { email: { contains: search } },
                    { phone: { contains: search } },
                    { role: { contains: search } },
                    { status: { contains: search } },
                ],
            }),
        };

        const [rows, totalCount] = await Promise.all([
            prisma.admin.findMany({
                where,
                skip: offset,
                take: limit,
                orderBy: { createdAt: "desc" },
            }),
            prisma.admin.count({ where }),
        ]);

        return { rows, totalCount };
    }

    async searchDDNS({ platformID, search, limit, offset }) {
        const where = {
            platformID,
            ...(search && {
                OR: [
                    { url: { contains: search } },
                    { publicIP: { contains: search } },
                ],
            }),
        };

        const [rows, totalCount] = await Promise.all([
            prisma.ddns.findMany({
                where,
                skip: offset,
                take: limit,
                orderBy: { createdAt: "desc" },
            }),
            prisma.ddns.count({ where }),
        ]);

        return { rows, totalCount };
    }

    async searchSupportThreads({ platformID, search, limit, offset }) {
        const where = {
            platformID,
            ...(search && {
                OR: [
                    { subject: { contains: search } },
                    { status: { contains: search } },
                    { priority: { contains: search } },
                    { channel: { contains: search } },
                ],
            }),
        };

        const [rows, totalCount] = await Promise.all([
            prisma.supportThread.findMany({
                where,
                skip: offset,
                take: limit,
                orderBy: { createdAt: "desc" },
            }),
            prisma.supportThread.count({ where }),
        ]);

        return { rows, totalCount };
    }

    async getMpesaByPhone(phone, platformID) {
        if (!phone || !platformID) return null;
        try {
            const mpesa = await prisma.mpesa.findMany({
                where: { phone, platformID },
            });
            return mpesa;
        } catch (error) {
            console.error("Error fetching mpesa by phone:", error);
            throw error;
        }
    }

    async createSupportThread(data) {
        if (!data) return null;
        try {
            return await prisma.supportThread.create({ data });
        } catch (error) {
            console.error("Error creating support thread:", error);
            throw error;
        }
    }

    async updateSupportThread(id, data) {
        if (!id || !data) return null;
        try {
            return await prisma.supportThread.update({
                where: { id },
                data,
            });
        } catch (error) {
            console.error("Error updating support thread:", error);
            throw error;
        }
    }

    async getSupportThreadById(id) {
        if (!id) return null;
        try {
            return await prisma.supportThread.findUnique({
                where: { id },
                include: { messages: { orderBy: { createdAt: "asc" } } },
            });
        } catch (error) {
            console.error("Error fetching support thread:", error);
            throw error;
        }
    }

    async getSupportThreadByPlatformSubject(platformID, subject, type = "live", channel = "public", statuses = []) {
        if (!platformID || !subject) return null;
        try {
            return await prisma.supportThread.findFirst({
                where: {
                    platformID,
                    subject,
                    type,
                    channel,
                    ...(statuses.length ? { status: { in: statuses } } : {}),
                },
                include: { messages: { orderBy: { createdAt: "asc" } } },
            });
        } catch (error) {
            console.error("Error fetching support thread by subject:", error);
            throw error;
        }
    }

    async getSupportThreadsByPlatform(platformID, type) {
        if (!platformID) return null;
        try {
            return await prisma.supportThread.findMany({
                where: {
                    platformID,
                    ...(type ? { type } : {}),
                },
                orderBy: { updatedAt: "desc" },
                include: { messages: { take: 1, orderBy: { createdAt: "desc" } } },
            });
        } catch (error) {
            console.error("Error fetching support threads by platform:", error);
            throw error;
        }
    }

    async getSupportThreadsByPlatformPaged(platformID, type, limit, offset, channel) {
        if (!platformID) return { rows: [], totalCount: 0 };
        try {
            const where = {
                platformID,
                ...(type ? { type } : {}),
                ...(channel ? { channel } : {}),
            };
            const [rows, totalCount] = await Promise.all([
                prisma.supportThread.findMany({
                    where,
                    skip: offset,
                    take: limit,
                    orderBy: { updatedAt: "desc" },
                    include: { messages: { take: 1, orderBy: { createdAt: "desc" } } },
                }),
                prisma.supportThread.count({ where }),
            ]);
            return { rows, totalCount };
        } catch (error) {
            console.error("Error fetching paged support threads by platform:", error);
            throw error;
        }
    }

    async deleteSupportThreadsByPlatform(platformID) {
        if (!platformID) return null;
        try {
            await prisma.supportThread.deleteMany({
                where: { platformID },
            });
            return true;
        } catch (error) {
            console.error("Error deleting support threads by platform:", error);
            throw error;
        }
    }

    async deleteSupportThreadById(id) {
        if (!id) return null;
        try {
            return await prisma.supportThread.delete({
                where: { id },
            });
        } catch (error) {
            console.error("Error deleting support thread by id:", error);
            throw error;
        }
    }

    async deleteOldSupportThreads({ type, channel, olderThan }) {
        if (!olderThan) return 0;
        try {
            const result = await prisma.supportThread.deleteMany({
                where: {
                    ...(type ? { type } : {}),
                    ...(channel ? { channel } : {}),
                    updatedAt: { lt: olderThan },
                },
            });
            return result?.count || 0;
        } catch (error) {
            console.error("Error deleting old support threads:", error);
            throw error;
        }
    }

    async getSupportThreadsWithMessagesBefore({ type, channel, olderThan }) {
        if (!olderThan) return [];
        try {
            return await prisma.supportThread.findMany({
                where: {
                    ...(type ? { type } : {}),
                    ...(channel ? { channel } : {}),
                    updatedAt: { lt: olderThan },
                },
                include: {
                    messages: {
                        select: {
                            attachments: true,
                        },
                    },
                },
            });
        } catch (error) {
            console.error("Error fetching old support threads:", error);
            throw error;
        }
    }

    async getSupportThreads(type) {
        try {
            return await prisma.supportThread.findMany({
                where: type ? { type } : {},
                orderBy: { updatedAt: "desc" },
                include: { messages: { take: 1, orderBy: { createdAt: "desc" } } },
            });
        } catch (error) {
            console.error("Error fetching support threads:", error);
            throw error;
        }
    }

    async getSupportThreadsPaged(type, limit, offset, channel) {
        try {
            const where = {
                ...(type ? { type } : {}),
                ...(channel ? { channel } : {}),
            };
            const [rows, totalCount] = await Promise.all([
                prisma.supportThread.findMany({
                    where,
                    skip: offset,
                    take: limit,
                    orderBy: { updatedAt: "desc" },
                    include: { messages: { take: 1, orderBy: { createdAt: "desc" } } },
                }),
                prisma.supportThread.count({ where }),
            ]);
            return { rows, totalCount };
        } catch (error) {
            console.error("Error fetching paged support threads:", error);
            throw error;
        }
    }

    async createSupportMessage(data) {
        if (!data) return null;
        try {
            return await prisma.supportMessage.create({ data });
        } catch (error) {
            console.error("Error creating support message:", error);
            throw error;
        }
    }

    async createSystemService(data) {
        if (!data) return null;
        try {
            return await prisma.systemService.create({ data });
        } catch (error) {
            console.error("Error creating system service:", error);
            throw error;
        }
    }

    async getSystemServices() {
        try {
            return await prisma.systemService.findMany({
                orderBy: { createdAt: "desc" },
            });
        } catch (error) {
            console.error("Error fetching system services:", error);
            throw error;
        }
    }

    async getSystemServiceByKey(key) {
        if (!key) return null;
        try {
            return await prisma.systemService.findUnique({
                where: { key },
            });
        } catch (error) {
            console.error("Error fetching system service:", error);
            throw error;
        }
    }

    async updateSystemService(key, data) {
        if (!key || !data) return null;
        try {
            return await prisma.systemService.update({
                where: { key },
                data,
            });
        } catch (error) {
            console.error("Error updating system service:", error);
            throw error;
        }
    }

    async deleteSystemService(key) {
        if (!key) return null;
        try {
            return await prisma.systemService.delete({
                where: { key },
            });
        } catch (error) {
            console.error("Error deleting system service:", error);
            throw error;
        }
    }
}

module.exports = { DataBase };
