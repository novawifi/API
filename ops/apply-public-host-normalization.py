from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


main_path = Path("/home/kyan/apps/nova-server/controllers/maincontroller.js")
main = main_path.read_text()
main = replace_once(
    main,
    '''      data.platformID = platformID;
      data.adminID = adminID;
      data.mikrotikDDNS = "";''',
    '''      data.platformID = platformID;
      data.adminID = adminID;
      data.mikrotikDDNS = "";
      const normalizedPublicHost = Utils.normalizeMikrotikPublicHost(mikrotikPublicHost || mikrotikDDNS);
      if (!normalizedPublicHost) {
        return res.json({ success: false, message: "Public router host must be a valid DDNS hostname or IP address." });
      }
      data.mikrotikPublicHost = normalizedPublicHost;''',
    "manual normalization",
)
main = replace_once(
    main,
    '''      const endpointHost = mikrotikPublicHost;
      if (!endpointHost) {
        return res.json({ success: false, message: "Public router host or DDNS is required." });
      }''',
    '''      const endpointHost = normalizedPublicHost;''',
    "manual endpoint",
)
main = replace_once(
    main,
    '''        const radiusHost = getRadiusClientIp(stationResult, mikrotikPublicHost && Utils.isValidIP(mikrotikPublicHost)
          ? mikrotikPublicHost
          : resolvedIp);''',
    '''        const radiusHost = getRadiusClientIp(stationResult, Utils.isValidIP(normalizedPublicHost)
          ? normalizedPublicHost
          : resolvedIp);''',
    "radius endpoint",
)
main_path.write_text(main)


mik_path = Path("/home/kyan/apps/nova-server/controllers/mikrotikController.js")
mik = mik_path.read_text()
mik = replace_once(
    mik,
    '''            const endpointHost = payload.ddns || payload.publicIp;''',
    '''            const endpointHost = Utils.normalizeMikrotikPublicHost(payload.ddns || payload.publicIp);''',
    "auto endpoint",
)
mik = replace_once(
    mik,
    '''                if (payload.ddns) {
                    const existingDnsName = stations.find(s =>
                        s.mikrotikPublicHost?.trim() === payload.ddns?.trim() ||
                        s.mikrotikDDNS?.trim() === payload.ddns?.trim()
                    );''',
    '''                const normalizedDdns = Utils.normalizeMikrotikPublicHost(payload.ddns);
                if (normalizedDdns && !Utils.isValidIP(normalizedDdns)) {
                    const existingDnsName = stations.find(s =>
                        Utils.normalizeMikrotikPublicHost(s.mikrotikPublicHost) === normalizedDdns ||
                        Utils.normalizeMikrotikPublicHost(s.mikrotikDDNS) === normalizedDdns
                    );''',
    "auto duplicate DDNS",
)
mik = mik.replace(
    '''                    mikrotikPublicHost: payload.ddns || payload.publicIp || "",''',
    '''                    mikrotikPublicHost: endpointHost,''',
)
if mik.count('''                    mikrotikPublicHost: endpointHost,''') < 2:
    raise RuntimeError("auto storage: expected create and update replacements")
mik_path.write_text(mik)
