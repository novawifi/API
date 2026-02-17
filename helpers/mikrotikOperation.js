//@ts-check

class Mikrotik {
    async addSecret(channel, { name, password, service = 'pppoe', profile = 'default', disabled = 'false' }) {
        return channel.write('/ppp/secret/add', [
            `=name=${name}`,
            `=password=${password}`,
            `=service=${service}`,
            `=profile=${profile}`,
            `=disabled=${disabled}`,
        ]);
    }

    async updateSecret(channel, id, updates) {
        const params = Object.entries(updates).map(([key, value]) => `=${key}=${value}`);
        return channel.write('/ppp/secret/set', [
            `=.id=${id}`,
            ...params,
        ]);
    }

    async deleteSecret(channel, id) {
        return channel.write('/ppp/secret/remove', [
            `=.id=${id}`,
        ]);
    }

    async listSecrets(channel) {
        return channel.write('/ppp/secret/print');
    }

    async getSecretById(channel, id) {
        const response = await channel.write('/ppp/secret/print', [
            `=.id=${id}`,
        ]);
        return response.length > 0 ? response[0] : null;
    }

    async getSecretsByName(channel, name) {
        const response = await channel.write('/ppp/secret/print', [
            `?name=${name}`,
        ]);
        return response.length > 0 ? response : [];
    }

    async addHotspotUser(channel, {
        name,
        password,
        profile = 'default',
        limitUptime,
        limitBytesTotal
    }) {
        const args = [
            `=name=${name}`,
            `=password=${password}`,
            `=profile=${profile}`,
        ];
        if (limitUptime) {
            args.push(`=limit-uptime=${limitUptime}`);
        }
        if (limitBytesTotal && limitBytesTotal > 0) {
            args.push(`=limit-bytes-total=${limitBytesTotal}`);
        }
        return channel.write('/ip/hotspot/user/add', args);
    }

    async updateHotspotUser(channel, id, updates) {
        const params = Object.entries(updates).map(([key, value]) => `=${key}=${value}`);
        return channel.write('/ip/hotspot/user/set', [
            `=.id=${id}`,
            ...params,
        ]);
    }

    async deleteHotspotUser(channel, id) {
        return channel.write('/ip/hotspot/user/remove', [
            `=.id=${id}`,
        ]);
    }

    async deleteHotspotActiveUser(channel, id) {
        return channel.write('/ip/hotspot/user/active/remove', [
            `=.id=${id}`,
        ]);
    }

    async deleteHotspotCookie(channel, id) {
        return channel.write('/ip/hotspot/cookie/remove', [
            `=.id=${id}`,
        ]);
    }
    async listHotspotUsers(channel) {
        return channel.write('/ip/hotspot/user/print');
    }

    async getHotspotUserById(channel, id) {
        const response = await channel.write('/ip/hotspot/user/print', [
            `=.id=${id}`,
        ]);
        return response.length > 0 ? response[0] : null;
    }

    async getHotspotUsersByName(channel, name) {
        const response = await channel.write('/ip/hotspot/user/print', [
            `?name=${name}`,
        ]);
        return response.length > 0 ? response : [];
    }

    async addHotspotProfile(channel, {
        name,
        rateLimit = '1M/1M',
        sharedUsers = 1,
        pool = 'default',
        time,
        addMacCookie,
        macCookieTimeout
    }) {
        const args = [
            `=name=${name}`,
            `=rate-limit=${rateLimit}`,
            `=shared-users=${sharedUsers}`,
            `=address-pool=${pool}`,
        ];
        if (time) {
            args.push(`=session-timeout=${time}`);
        }
        if (addMacCookie !== undefined && addMacCookie !== null) {
            args.push(`=add-mac-cookie=${addMacCookie}`);
        }
        if (macCookieTimeout) {
            args.push(`=mac-cookie-timeout=${macCookieTimeout}`);
        }
        return channel.write('/ip/hotspot/user/profile/add', args);
    }


    async updateHotspotProfile(channel, id, updates) {
        const params = Object.entries(updates).map(([key, value]) => `=${key}=${value}`);
        return channel.write('/ip/hotspot/user/profile/set', [
            `=.id=${id}`,
            ...params,
        ]);
    }

    async deleteHotspotProfile(channel, id) {
        return channel.write('/ip/hotspot/user/profile/remove', [
            `=.id=${id}`,
        ]);
    }

    async listHotspotProfiles(channel) {
        return channel.write('/ip/hotspot/user/profile/print');
    }

    async listSystemResource(channel) {
        return channel.write('/system/resource/print');
    }

    async getHotspotProfileById(channel, id) {
        const response = await channel.write('/ip/hotspot/user/profile/print', [
            `=.id=${id}`,
        ]);
        return response.length > 0 ? response[0] : null;
    }

    async getHotspotProfilesByName(channel, name) {
        const response = await channel.write('/ip/hotspot/user/profile/print', [
            `?name=${name}`,
        ]);
        return response.length > 0 ? response : [];
    }

    async listHotspotActiveUsers(channel) {
        return channel.write('/ip/hotspot/active/print');
    }

    async getHotspotActiveUserById(channel, id) {
        const response = await channel.write('/ip/hotspot/active/print', [
            `=.id=${id}`,
        ]);
        return response.length > 0 ? response[0] : null;
    }

    async getHotspotActiveUsersByName(channel, name) {
        const response = await channel.write('/ip/hotspot/active/print', [
            `?name=${name}`,
        ]);
        return response.length > 0 ? response : [];
    }

    async addPPPService(channel, { name, type = 'pppoe' }) {
        return channel.write('/ppp/service/add', [
            `=name=${name}`,
            `=type=${type}`,
        ]);
    }

    async updatePPPService(channel, id, updates) {
        const params = Object.entries(updates).map(([key, value]) => `=${key}=${value}`);
        return channel.write('/ppp/service/set', [
            `=.id=${id}`,
            ...params,
        ]);
    }

    async deletePPPService(channel, id) {
        return channel.write('/ppp/service/remove', [
            `=.id=${id}`,
        ]);
    }

    async listPPPServices(channel) {
        return channel.write('/ppp/service/print');
    }

    async getPPPServiceById(channel, id) {
        const response = await channel.write('/ppp/service/print', [
            `=.id=${id}`,
        ]);
        return response.length > 0 ? response[0] : null;
    }

    async getPPPServicesByName(channel, name) {
        const response = await channel.write('/ppp/service/print', [
            `?name=${name}`,
        ]);
        return response.length > 0 ? response : [];
    }

    async addPPPProfile(channel, { name, localAddress, remoteAddress, dnsServer, rateLimit }) {
        const fields = [`=name=${name}`];

        if (localAddress) fields.push(`=local-address=${localAddress}`);
        if (remoteAddress) fields.push(`=remote-address=${remoteAddress}`);
        if (dnsServer) fields.push(`=dns-server=${dnsServer}`);
        if (rateLimit) fields.push(`=rate-limit=${rateLimit}`);

        return channel.write('/ppp/profile/add', fields);
    }

    async updatePPPProfile(channel, id, updates) {
        const params = Object.entries(updates).map(([key, value]) => `=${key}=${value}`);
        return channel.write('/ppp/profile/set', [
            `=.id=${id}`,
            ...params,
        ]);
    }

    async deletePPPProfile(channel, id) {
        return channel.write('/ppp/profile/remove', [
            `=.id=${id}`,
        ]);
    }

    async listPPPProfiles(channel) {
        return channel.write('/ppp/profile/print');
    }

    async getPPPProfileById(channel, id) {
        const response = await channel.write('/ppp/profile/print', [
            `=.id=${id}`,
        ]);
        return response.length > 0 ? response[0] : null;
    }

    async getPPPProfilesByName(channel, name) {
        const response = await channel.write('/ppp/profile/print', [
            `?name=${name}`,
        ]);
        return response.length > 0 ? response : [];
    }

    async addPPPServer(channel, fields) {
        const params = Object.entries(fields).map(([key, value]) => `=${key}=${value}`);
        return channel.write('/interface/pppoe-server/server/add', [
            ...params,
        ]);
    }

    async updatePPPServer(channel, id, updates) {
        const params = Object.entries(updates).map(([key, value]) => `=${key}=${value}`);
        return channel.write('/interface/pppoe-server/server/set', [
            `=.id=${id}`,
            ...params,
        ]);
    }

    async deletePPPServer(channel, id) {
        return channel.write('/interface/pppoe-server/server/remove', [
            `=.id=${id}`,
        ]);
    }

    async listPPPServers(channel) {
        return channel.write('/interface/pppoe-server/server/print');
    }

    async getPPPServerById(channel, id) {
        const response = await channel.write('/interface/pppoe-server/server/print', [
            `=.id=${id}`,
        ]);
        return response.length > 0 ? response[0] : null;
    }

    async getPPPServersByName(channel, name) {
        const response = await channel.write('/interface/pppoe-server/server/print', [
            `?name=${name}`,
        ]);
        return response.length > 0 ? response : [];
    }

    async addPool(channel, { name, ranges, comment }) {
        const args = [
            `=name=${name}`,
            `=ranges=${ranges}`,
        ];

        if (comment) {
            args.push(`=comment=${comment}`);
        }

        return channel.write('/ip/pool/add', args);
    }

    async updatePool(channel, id, updates) {
        const params = Object.entries(updates).map(([key, value]) => `=${key}=${value}`);
        return channel.write('/ip/pool/set', [
            `=.id=${id}`,
            ...params,
        ]);
    }

    async deletePool(channel, id) {
        return channel.write('/ip/pool/remove', [
            `=.id=${id}`,
        ]);
    }

    async listPools(channel) {
        return channel.write('/ip/pool/print');
    }

    async getPoolById(channel, id) {
        const response = await channel.write('/ip/pool/print', [
            `=.id=${id}`,
        ]);
        return response.length > 0 ? response[0] : null;
    }

    async getPoolsByName(channel, name) {
        const response = await channel.write('/ip/pool/print', [
            `?name=${name}`,
        ]);
        return response.length > 0 ? response : [];
    }

    async listInterfaces(channel) {
        return channel.write('/interface/print');
    }

    async listHotspotServers(channel) {
        const response = await channel.write('/ip/hotspot/print');
        return response.length > 0 ? response : [];
    }

    async getHotspotProfiles(channel) {
        const response = await channel.write('/ip/hotspot/profile/print');
        return response.length > 0 ? response : [];
    }

    async addIPAddress(channel, {
        address,
        network,
        intf,
        comment = ''
    }) {
        const args = [
            `=address=${address}`,
            `=network=${network}`,
            `=interface=${intf}`,
        ];
        if (comment) {
            args.push(`=comment=${comment}`);
        }
        return channel.write('/ip/address/add', args);
    }

    async updateIPAddress(channel, id, updates) {
        const params = Object.entries(updates).map(([key, value]) => `=${key}=${value}`);
        return channel.write('/ip/address/set', [
            `=.id=${id}`,
            ...params,
        ]);
    }

    async deleteIPAddress(channel, id) {
        return channel.write('/ip/address/remove', [
            `=.id=${id}`,
        ]);
    }

    async listIPAddresses(channel) {
        return channel.write('/ip/address/print');
    }

    async addFirewallNatRule(channel, {
        chain,
        action,
        srcAddress,
        outInterface,
        comment
    }) {
        const args = [
            `=chain=${chain}`,
            `=action=${action}`,
        ];
        if (srcAddress) {
            args.push(`=src-address=${srcAddress}`);
        }
        if (outInterface) {
            args.push(`=out-interface=${outInterface}`);
        }
        if (comment) {
            args.push(`=comment=${comment}`);
        }
        return channel.write('/ip/firewall/nat/add', args);
    }

    async addHotspotServerProfile(
        channel,
        {
            name,
            hotspotAddress,
            dnsName,
            smtpServer = "0.0.0.0",
            folder = "hotspot",
            loginBy,
        }
    ) {
        const args = [
            `=name=${name}`,
            `=hotspot-address=${hotspotAddress}`,
            `=dns-name=${dnsName}`,
            `=smtp-server=${smtpServer}`,
            `=html-directory=${folder}`,
        ];
        if (loginBy) args.push(`=login-by=${loginBy}`);
        return channel.write("/ip/hotspot/profile/add", args);
    }

    async updateHotspotServerProfile(channel, id, updates) {
        const params = Object.entries(updates).map(([key, value]) => `=${key}=${value}`);
        return channel.write("/ip/hotspot/profile/set", [
            `=.id=${id}`,
            ...params,
        ]);
    }

    async addHotspotServer(
        channel,
        {
            name,
            intf,
            profile,
            addressPool
        }
    ) {
        return channel.write("/ip/hotspot/add", [
            `=name=${name}`,
            `=interface=${intf}`,
            `=profile=${profile}`,
            `=disabled=no`,
            `=address-pool=${addressPool}`
        ]);
    }

    async deleteFile(channel, path) {
        return channel.write('/file/remove', [
            `=numbers=${path}`,
        ]);
    }

    async deleteFileByID(channel, id) {
        return channel.write('/file/remove', [
            `=.id=${id}`,
        ]);
    }

    async listFiles(channel) {
        return channel.write('/file/print');
    }

    async fetchFile(channel, options) {
        const params = Object.entries(options).map(([key, value]) => {
            const formattedKey = key.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
            return `=${formattedKey}=${value}`;
        });

        return channel.write("/tool/fetch", params);
    }


    async saveBackUpFile(channel, name) {
        return channel.write("/system/backup/save", [
            `=name=${name}`,
        ])
    }

    async listPPPActiveUsers(channel) {
        return channel.write('/ppp/active/print');
    }

    async listHotspotCookies(channel) {
        return channel.write('/ip/hotspot/cookie/print');
    }

    async reboot(channel) {
        await channel.write('/system/reboot', { '=delay': '0' });
    }
}

module.exports = { Mikrotik }
