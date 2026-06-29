
const { execFile } = require("child_process");
const fsp = require("fs").promises;

const runSudo = (args = []) =>
  new Promise((resolve, reject) => {
    execFile("sudo", ["-n", ...args], (err, stdout, stderr) => {
      if (err) return reject(stderr || err.message);
      resolve(stdout);
    });
  });

const getClientsConfCandidates = () => {
  if (process.env.RADIUS_CLIENTS_CONF_PATH) {
    return [process.env.RADIUS_CLIENTS_CONF_PATH];
  }
  return [
    "/etc/freeradius/3.0/clients.conf",
    "/etc/freeradius/clients.conf",
    "/etc/raddb/clients.conf",
  ];
};

const getRadiusServiceName = () =>
  process.env.RADIUS_SERVICE_NAME || "freeradius";

const getRadiusServerIp = () =>
  (
    process.env.RADIUS_SERVER_PUBLIC_IP ||
    process.env.RADIUS_SERVER_IP ||
    ""
  ).toString().split(":")[0];

const getRadiusClientSecret = (fallbackSecret = "") =>
  String(process.env.RADIUS_SHARED_SECRET || fallbackSecret || "").trim();

const getRadiusCatchAllCidr = () =>
  String(process.env.RADIUS_CLIENT_CIDR || "").trim();

const getRadiusCatchAllClientName = () =>
  sanitizeToken(process.env.RADIUS_CATCH_ALL_CLIENT_NAME || "nova-any-ip");

const normalizeRequireMessageAuthenticator = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (["yes", "true", "1"].includes(normalized)) return "yes";
  if (["auto"].includes(normalized)) return "auto";
  return "no";
};

const getRadiusRequireMessageAuthenticator = () =>
  normalizeRequireMessageAuthenticator(process.env.RADIUS_REQUIRE_MESSAGE_AUTHENTICATOR || "no");

const getRadiusClientIp = (stationOrHost, fallbackIp = "") => {
  const configuredClientIp = typeof stationOrHost === "object"
    ? stationOrHost?.radiusClientIp
    : "";
  if (configuredClientIp) return String(configuredClientIp).trim();
  return String(fallbackIp || "").trim();
};

const isWireGuardMikrotikIp = (value) =>
  /^10\.10\.10\.(?:[1-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-4])$/.test(String(value || "").trim());

const sanitizeToken = (value) =>
  String(value || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");

const escapeRegex = (value) =>
  String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildClientBlock = ({ name, ip, secret, shortname, description }) => {
  const safeName = sanitizeToken(name);
  const safeShortname = shortname ? sanitizeToken(shortname) : "";
  const safeDescription = description ? sanitizeToken(description) : "";
  const lines = [
    `client ${safeName} {`,
    `    ipaddr = ${ip}`,
    `    secret = ${secret}`,
    `    require_message_authenticator = ${getRadiusRequireMessageAuthenticator()}`,
  ];
  if (safeShortname) lines.push(`    shortname = ${safeShortname}`);
  if (safeDescription) lines.push(`    description = ${safeDescription}`);
  lines.push("}");
  return lines.join("\n");
};

const hasClient = (content, { name, ip }) => {
  const nameRegex = new RegExp(`\\bclient\\s+${escapeRegex(sanitizeToken(name))}\\b`, "i");
  const ipRegex = new RegExp(`\\bipaddr\\s*=\\s*${escapeRegex(ip)}\\b`, "i");
  return nameRegex.test(content) || ipRegex.test(content);
};

const findClientBlock = (content, name) => {
  const regex = new RegExp(`client\\s+${escapeRegex(sanitizeToken(name))}\\s*\\{[\\s\\S]*?\\}`, "i");
  const match = content.match(regex);
  if (!match) return null;
  return { block: match[0], start: match.index, end: match.index + match[0].length };
};

const findClientBlockByIp = (content, ip) => {
  if (!ip) return null;
  const blockRegex = /client\s+[^\s{]+\s*\{[\s\S]*?\}/gi;
  let match;
  while ((match = blockRegex.exec(content)) !== null) {
    const block = match[0];
    const ipRegex = new RegExp(`\\bipaddr\\s*=\\s*${escapeRegex(ip)}\\b`, "i");
    if (ipRegex.test(block)) {
      return { block, start: match.index, end: match.index + block.length };
    }
  }
  return null;
};

const extractIpaddr = (block) => {
  const match = block.match(/ipaddr\s*=\s*([^\s#]+)/i);
  return match ? match[1].trim() : null;
};

const extractSecret = (block) => {
  const match = String(block || "").match(/secret\s*=\s*([^\n#]+)/i);
  return match ? match[1].trim().replace(/^["']|["']$/g, "") : "";
};

const readClientsConf = async () => {
  const candidates = getClientsConfCandidates();
  let lastError = null;
  for (const confPath of candidates) {
    try {
      const content = (await runSudo(["/bin/cat", confPath])).toString();
      return { success: true, confPath, content };
    } catch (error) {
      lastError = error;
    }
  }
  return { success: false, message: "Failed to read RADIUS clients.conf", error: lastError };
};

const writeClientsConf = async (confPath, updatedContent) => {
  const timestamp = Date.now();
  const tmpPath = `/tmp/clients-${timestamp}.conf`;
  const backupPath = `/tmp/clients-${timestamp}.backup`;
  await fsp.writeFile(tmpPath, updatedContent, "utf8");
  try {
    await runSudo(["/bin/cp", confPath, backupPath]);
    await runSudo(["/usr/bin/install", "-m", "640", "-o", "root", "-g", "freerad", tmpPath, confPath]);
    await runSudo(["/usr/sbin/freeradius", "-XC"]);
    await runSudo(["-u", "freerad", "/usr/sbin/freeradius", "-XC"]);
    await runSudo(["/usr/bin/systemctl", "restart", getRadiusServiceName()]);
    await runSudo(["/usr/bin/systemctl", "is-active", "--quiet", getRadiusServiceName()]);
  } catch (error) {
    try {
      await runSudo(["/usr/bin/install", "-m", "640", "-o", "root", "-g", "freerad", backupPath, confPath]);
      await runSudo(["-u", "freerad", "/usr/sbin/freeradius", "-XC"]);
      await runSudo(["/usr/bin/systemctl", "restart", getRadiusServiceName()]);
      await runSudo(["/usr/bin/systemctl", "is-active", "--quiet", getRadiusServiceName()]);
    } catch (restoreError) {
      throw new Error(`RADIUS configuration failed and rollback failed: ${restoreError}`);
    }
    throw error;
  } finally {
    await fsp.unlink(tmpPath).catch(() => {});
    await runSudo(["/bin/rm", "-f", backupPath]).catch(() => {});
  }
};

const updateClientIp = async ({ name, ip }) => {
  if (!name || !ip) return { success: false, message: "Missing client name or ip" };
  const readResult = await readClientsConf();
  if (!readResult.success) return readResult;
  const { confPath, content } = readResult;

  const found = findClientBlock(content, name);
  if (!found) {
    return { success: false, message: "RADIUS client not found" };
  }

  const currentIp = extractIpaddr(found.block);
  if (currentIp === ip) {
    return { success: true, message: "RADIUS client IP unchanged", updated: false, currentIp };
  }

  const updatedBlock = found.block.replace(/ipaddr\s*=\s*([^\s#]+)/i, `ipaddr = ${ip}`);
  const updatedContent =
    content.slice(0, found.start) + updatedBlock + content.slice(found.end);
  try {
    await writeClientsConf(confPath, updatedContent);
    return { success: true, message: "RADIUS client IP updated", updated: true, currentIp, newIp: ip };
  } catch (error) {
    return { success: false, message: "Failed to update RADIUS clients.conf", error };
  }
};

const ensureExactRadiusClient = async ({
  name,
  ip,
  secret,
  shortname,
  server,
  description,
}) => {
  if (!name || !ip || !secret) {
    return { success: false, message: "Missing RADIUS exact client data" };
  }

  const readResult = await readClientsConf();
  if (!readResult.success) return readResult;
  const { confPath, content } = readResult;

  const block = buildClientBlock({ name, ip, secret, shortname, server, description });
  const found = findClientBlock(content, name) || findClientBlockByIp(content, ip);

  if (found) {
    if (found.block.trim() === block.trim()) {
      return { success: true, message: "RADIUS exact client already exists", updated: false };
    }

    const updatedContent = content.slice(0, found.start) + block + content.slice(found.end);
    try {
      await writeClientsConf(confPath, updatedContent);
      return { success: true, message: "RADIUS exact client updated", updated: true };
    } catch (error) {
      return { success: false, message: "Failed to update RADIUS exact client", error };
    }
  }

  const updated = `${content.trim()}\n\n${block}\n`;
  try {
    await writeClientsConf(confPath, updated);
    return { success: true, message: "RADIUS exact client added", updated: true };
  } catch (error) {
    return { success: false, message: "Failed to write RADIUS exact client", error };
  }
};

const ensureRadiusClient = async ({
  name,
  ip,
  secret,
  shortname,
  server,
  description,
}) => {
  const catchAllCidr = getRadiusCatchAllCidr();
  if (catchAllCidr) {
    const readResult = await readClientsConf();
    if (!readResult.success) return readResult;
    const { confPath, content } = readResult;
    const catchAllName = getRadiusCatchAllClientName();
    const found = findClientBlock(content, catchAllName) || findClientBlockByIp(content, catchAllCidr);
    const explicitSharedSecret = String(process.env.RADIUS_SHARED_SECRET || "").trim();
    const existingCatchAllSecret = found ? extractSecret(found.block) : "";
    const catchAllSecret = explicitSharedSecret || existingCatchAllSecret || String(secret || "").trim();
    if (!catchAllSecret) {
      return { success: false, message: "Missing RADIUS shared secret for catch-all client" };
    }

    const block = buildClientBlock({
      name: catchAllName,
      ip: catchAllCidr,
      secret: catchAllSecret,
      shortname: catchAllName,
      description: "Nova catch-all RADIUS client",
    });

    if (found) {
      if (found.block.trim() === block.trim()) {
        return {
          success: true,
          message: `RADIUS clients are managed by catch-all ${catchAllCidr}`,
          updated: false,
          catchAll: true,
          sharedSecret: catchAllSecret,
        };
      }

      const updatedContent = content.slice(0, found.start) + block + content.slice(found.end);
      try {
        await writeClientsConf(confPath, updatedContent);
        return {
          success: true,
          message: `RADIUS catch-all client updated for ${catchAllCidr}`,
          updated: true,
          catchAll: true,
          sharedSecret: catchAllSecret,
        };
      } catch (error) {
        return { success: false, message: "Failed to update RADIUS catch-all client", error };
      }
    }

    const updated = `${content.trim()}\n\n${block}\n`;
    try {
      await writeClientsConf(confPath, updated);
      return {
        success: true,
        message: `RADIUS catch-all client added for ${catchAllCidr}`,
        updated: true,
        catchAll: true,
        sharedSecret: catchAllSecret,
      };
    } catch (error) {
      return { success: false, message: "Failed to write RADIUS catch-all client", error };
    }
  }

  if (!name || !ip || !secret) {
    return { success: false, message: "Missing RADIUS client data" };
  }

  return ensureExactRadiusClient({ name, ip, secret, shortname, server, description });
};

const removeRadiusClient = async ({ name }) => {
  if (!name) return { success: false, message: "Missing client name" };
  const readResult = await readClientsConf();
  if (!readResult.success) return readResult;
  const { confPath, content } = readResult;

  const found = findClientBlock(content, name);
  if (!found) {
    return { success: true, message: "RADIUS client not found", removed: false };
  }

  const before = content.slice(0, found.start).trimEnd();
  const after = content.slice(found.end).trimStart();
  const updated = `${before}\n\n${after}\n`.replace(/\n{3,}/g, "\n\n").trim() + "\n";
  try {
    await writeClientsConf(confPath, updated);
    return { success: true, message: "RADIUS client removed", removed: true };
  } catch (error) {
    return { success: false, message: "Failed to update RADIUS clients.conf", error };
  }
};

module.exports = {
  ensureExactRadiusClient,
  ensureRadiusClient,
  getRadiusCatchAllCidr,
  getRadiusCatchAllClientName,
  getRadiusClientIp,
  getRadiusClientSecret,
  getRadiusRequireMessageAuthenticator,
  getRadiusServerIp,
  isWireGuardMikrotikIp,
  updateClientIp,
  removeRadiusClient,
};
