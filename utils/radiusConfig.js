// @ts-check

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

const isWireGuardMikrotikIp = (value) =>
  /^10\.10\.10\.(?:[1-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-4])$/.test(String(value || "").trim());

const getRadiusServerIp = () =>
  (
    process.env.RADIUS_SERVER_WIREGUARD_IP ||
    process.env.RADIUS_INTERNAL_SERVER_IP ||
    process.env.WIREGUARD_SERVER_IP ||
    "10.10.10.1"
  ).toString().split(":")[0];

const getRadiusClientIp = (stationOrHost, fallbackIp = "") => {
  const host = typeof stationOrHost === "string"
    ? stationOrHost
    : stationOrHost?.mikrotikHost;
  if (isWireGuardMikrotikIp(host)) return String(host).trim();
  return String(fallbackIp || "").trim();
};

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
    `    require_message_authenticator = auto`,
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
    await runSudo(["/usr/bin/systemctl", "reload", getRadiusServiceName()]);
  } catch (error) {
    try {
      await runSudo(["/usr/bin/install", "-m", "640", "-o", "root", "-g", "freerad", backupPath, confPath]);
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

const ensureRadiusClient = async ({
  name,
  ip,
  secret,
  shortname,
  server,
  description,
}) => {
  if (!name || !ip || !secret) {
    return { success: false, message: "Missing RADIUS client data" };
  }

  const readResult = await readClientsConf();
  if (!readResult.success) return readResult;
  const { confPath, content } = readResult;

  const block = buildClientBlock({ name, ip, secret, shortname, server, description });
  const found = findClientBlock(content, name) || findClientBlockByIp(content, ip);

  if (found) {
    if (found.block.trim() === block.trim()) {
      return { success: true, message: "RADIUS client already exists", updated: false };
    }

    const updatedContent = content.slice(0, found.start) + block + content.slice(found.end);
    try {
      await writeClientsConf(confPath, updatedContent);
      return { success: true, message: "RADIUS client updated", updated: true };
    } catch (error) {
      return { success: false, message: "Failed to update RADIUS clients.conf", error };
    }
  }

  const updated = `${content.trim()}\n\n${block}\n`;
  try {
    await writeClientsConf(confPath, updated);
    return { success: true, message: "RADIUS client added" };
  } catch (error) {
    return { success: false, message: "Failed to write RADIUS clients.conf", error };
  }
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
  ensureRadiusClient,
  getRadiusClientIp,
  getRadiusServerIp,
  isWireGuardMikrotikIp,
  updateClientIp,
  removeRadiusClient,
};
