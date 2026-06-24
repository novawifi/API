const net = require("net");

const isEnabled = (value) => ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());

const validAddressPrefix = (value) => {
    const prefix = String(value || "").trim();
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(prefix)) return false;
    return prefix.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255);
};

const validServer = (value) => {
    const server = String(value || "").trim().toLowerCase();
    if (!server || server.includes("://") || server.includes("/") || /[\s"\\]/.test(server)) return false;
    return net.isIP(server) !== 0 || /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(server);
};

const escapeRouterOsString = (value) => String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/[\r\n\0]/g, "");

const escapeRouterOsSchedulerEvent = (value) => String(value || "").replace(/\$/g, "\\$");

const getMikrotikRescueConfig = (routerHost, env = process.env) => {
    if (!isEnabled(env.MIKROTIK_RESCUE_SSTP_ENABLED)) {
        return { enabled: false, reason: "disabled" };
    }

    const host = String(routerHost || "").trim();
    const hostParts = host.split(".");
    const routerId = Number(hostParts[3]);
    const addressPrefix = String(env.MIKROTIK_RESCUE_ADDRESS_PREFIX || "10.250.0").trim();
    const server = String(env.MIKROTIK_RESCUE_SSTP_SERVER || "").trim().toLowerCase();
    const password = String(env.MIKROTIK_RESCUE_SSTP_PASSWORD || "");
    const usernameTemplate = String(env.MIKROTIK_RESCUE_SSTP_USERNAME_TEMPLATE || "nova-rescue-{router_id}");
    const port = Number(env.MIKROTIK_RESCUE_SSTP_PORT || 4443);

    if (net.isIP(host) !== 4 || !Number.isInteger(routerId) || routerId < 2 || routerId > 254) {
        return { enabled: false, reason: "invalid_router_host" };
    }
    if (!validAddressPrefix(addressPrefix) || !validServer(server) || !password) {
        return { enabled: false, reason: "incomplete_configuration" };
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { enabled: false, reason: "invalid_port" };
    }

    const username = usernameTemplate
        .replaceAll("{router_id}", String(routerId))
        .replaceAll("{router_ip}", host.replace(/\./g, "-"))
        .trim();
    if (!username || /[\r\n\0]/.test(username)) {
        return { enabled: false, reason: "invalid_username" };
    }

    return {
        enabled: true,
        interfaceName: "nova-rescue-sstp",
        watchdogName: "nova-rescue-watchdog",
        server,
        port,
        username,
        password,
        rescueAddress: `${addressPrefix}.${routerId}`,
        rescueGateway: `${addressPrefix}.1`,
        rescueSubnet: `${addressPrefix}.0/24`,
        managementPorts: "22,8291,8728,8729",
    };
};

const buildMikrotikRescueScript = (config) => {
    if (!config?.enabled) return [];

    const name = escapeRouterOsString(config.interfaceName);
    const watchdog = escapeRouterOsString(config.watchdogName);
    const server = escapeRouterOsString(config.server);
    const username = escapeRouterOsString(config.username);
    const password = escapeRouterOsString(config.password);
    const gateway = escapeRouterOsString(config.rescueGateway);
    const subnet = escapeRouterOsString(config.rescueSubnet);
    const ports = escapeRouterOsString(config.managementPorts);
    const bootstrap = `${watchdog}-bootstrap`;
    const eventName = (value) => String(value || "").replace(/[^a-zA-Z0-9._-]/g, "");
    const eventInterfaceName = eventName(name);
    const eventWatchdogName = eventName(watchdog);
    const eventBootstrapName = eventName(bootstrap);
    const watchdogEvent = escapeRouterOsSchedulerEvent([
        `:local rescue [/interface/sstp-client/find name=${eventInterfaceName}];`,
        `:if ([:len $rescue] > 0) do={`,
        `:local restart false;`,
        `:if ([/interface/sstp-client/get $rescue running] = false) do={ :set restart true };`,
        `:if (!$restart) do={ :if ([/ping address=${gateway} interface=${eventInterfaceName} count=3 interval=1s] = 0) do={ :set restart true } };`,
        `:if ($restart) do={ /interface/sstp-client disable $rescue; :delay 5s; /interface/sstp-client enable $rescue }`,
        `}`,
    ].join(" "));
    const bootstrapEvent = escapeRouterOsSchedulerEvent([
        `:local rescue [/interface/sstp-client/find name=${eventInterfaceName}];`,
        `:if ([:len $rescue] > 0) do={ /interface/sstp-client enable $rescue };`,
        `:do { /system/scheduler remove [find name=${eventBootstrapName}] } on-error={}`,
    ].join(" "));

    return [
        `:do { /interface/sstp-client remove [find name="${name}"] } on-error={}`,
        `/interface/sstp-client add name="${name}" connect-to="${server}" port=${config.port} user="${username}" password="${password}" authentication=mschap2 profile=default-encryption add-default-route=no dial-on-demand=no keepalive-timeout=30 tls-version=only-1.2 ciphers=aes256-sha add-sni=yes verify-server-certificate=no verify-server-address-from-certificate=no disabled=no comment="Nova emergency rescue tunnel"`,
        `:do { /interface/sstp-client enable [find name="${name}"] } on-error={}`,
        `:do { /ip/firewall/filter remove [find comment="Nova rescue management"] } on-error={}`,
        `/ip/firewall/filter add chain=input in-interface="${name}" src-address="${subnet}" protocol=tcp dst-port="${ports}" action=accept comment="Nova rescue management" place-before=0`,
        `:do { /system/scheduler remove [find name="${watchdog}"] } on-error={}`,
        `/system/scheduler add name="${watchdog}" interval=2m start-time=startup on-event="${watchdogEvent}" policy=read,write,test`,
        `:do { /system/scheduler remove [find name="${bootstrap}"] } on-error={}`,
        `/system/scheduler add name="${bootstrap}" interval=10s start-time=startup on-event="${bootstrapEvent}" policy=read,write,test disabled=no`,
    ];
};

module.exports = {
    buildMikrotikRescueScript,
    escapeRouterOsString,
    getMikrotikRescueConfig,
};
