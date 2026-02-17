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

const sanitizeToken = (value) =>
  String(value || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");

const buildClientBlock = ({ name, ip, secret, shortname, description }) => {
  const safeName = sanitizeToken(name);
  const safeShortname = shortname ? sanitizeToken(shortname) : "";
  const safeDescription = description ? sanitizeToken(description) : "";
  const lines = [
    `client ${safeName} {`,
    `    ipaddr = ${ip}`,
    `    secret = ${secret}`,
    `    require_message_authenticator = yes`,
  ];
  if (safeShortname) lines.push(`    shortname = ${safeShortname}`);
  if (safeDescription) lines.push(`    description = ${safeDescription}`);
  lines.push("}");
  return lines.join("\n");
};

const hasClient = (content, { name, ip }) => {
  const nameRegex = new RegExp(`\\bclient\\s+${name}\\b`, "i");
  const ipRegex = new RegExp(`\\bipaddr\\s*=\\s*${ip.replace(/\./g, "\\.")}\\b`, "i");
  return nameRegex.test(content) || ipRegex.test(content);
};

const findClientBlock = (content, name) => {
  const regex = new RegExp(`client\\s+${name}\\s*\\{[\\s\\S]*?\\}`, "i");
  const match = content.match(regex);
  if (!match) return null;
  return { block: match[0], start: match.index, end: match.index + match[0].length };
};

const extractIpaddr = (block) => {
  const match = block.match(/ipaddr\\s*=\\s*([^\\s#]+)/i);
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
  const tmpPath = `/tmp/clients-${Date.now()}.conf`;
  await fsp.writeFile(tmpPath, updatedContent, "utf8");
  try {
    await runSudo(["/usr/bin/install", "-m", "640", tmpPath, confPath]);
  } catch (error) {
    await runSudo(["/bin/cp", tmpPath, confPath]);
  }
  return runSudo(["/usr/bin/systemctl", "reload", getRadiusServiceName()]);
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

  const updatedBlock = found.block.replace(/ipaddr\\s*=\\s*([^\\s#]+)/i, `ipaddr = ${ip}`);
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

  if (hasClient(content, { name, ip })) {
    return { success: true, message: "RADIUS client already exists" };
  }

  const block = buildClientBlock({ name, ip, secret, shortname, server, description });
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
  updateClientIp,
  removeRadiusClient,
};
