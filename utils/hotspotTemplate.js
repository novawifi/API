const fs = require("fs");
const path = require("path");
const appRoot = require("app-root-path").path;
const { Utils } = require("./Functions");

function cleanBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function resolveApiBaseUrl(req) {
  const configured = cleanBaseUrl(
    process.env.ROUTER_PUBLIC_BASE_URL ||
    process.env.PUBLIC_API_BASE_URL ||
    process.env.NEXT_PUBLIC_SERVER_URL ||
    process.env.API_BASE_URL
  );
  if (configured) return configured;

  if (req) {
    const proto = req.headers?.["x-forwarded-proto"] || req.protocol || "https";
    const host = req.headers?.["x-forwarded-host"] || req.headers?.host;
    if (host) return cleanBaseUrl(`${proto}://${host}`);
  }

  return "https://api.novawifi.co.ke";
}

function readTemplate() {
  const candidates = [
    process.env.HOTSPOT_LOGIN_TEMPLATE_PATH,
    path.resolve(appRoot, "../client/public/login-template.html"),
    path.resolve(appRoot, "client/public/login-template.html"),
    path.resolve(appRoot, "public/login-template.html"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, "utf8");
    }
  }

  throw new Error("Offline hotspot template not found");
}

function replaceJsVar(html, name, value) {
  const literal = JSON.stringify(value ?? "");
  const pattern = new RegExp(`var\\s+${name}\\s*=\\s*[\\s\\S]*?;`);
  return html.replace(pattern, `var ${name} = ${literal};`);
}

function escapeHtmlText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[char]));
}

function replaceElementText(html, id, value) {
  const safeId = String(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(<([a-zA-Z][\\w:-]*)\\b[^>]*\\bid=["']${safeId}["'][^>]*>)[\\s\\S]*?(</\\2>)`);
  return html.replace(pattern, `$1${escapeHtmlText(value)}$3`);
}

function normalizePackage(pkg) {
  return {
    id: String(pkg?.id || ""),
    name: String(pkg?.name || "WiFi Package"),
    price: Number(pkg?.price || 0),
    period: String(pkg?.period || ""),
    usage: String(pkg?.usage || ""),
    speed: String(pkg?.speed || ""),
    devices: pkg?.devices || pkg?.device || "",
    category: String(pkg?.category || ""),
    accountNumber: String(pkg?.accountNumber || ""),
    routerHost: String(pkg?.routerHost || ""),
  };
}

function normalizePackages(packages) {
  return (Array.isArray(packages) ? packages : [])
    .filter((pkg) => pkg && pkg.status !== "hidden")
    .filter((pkg) => String(pkg.category || "").toLowerCase() !== "homefibre")
    .map(normalizePackage);
}

function getHotspotHash(host) {
  const value = String(host || "").trim();
  if (!value || !Utils.isValidIP(value) || !value.startsWith("10.10.10.")) return "";
  try {
    return Utils.hashInternalIP(value);
  } catch (error) {
    return "";
  }
}

function renderOfflineBoxLoginTemplate(options = {}) {
  const platform = options.platform || {};
  const config = options.config || {};
  const brandName = String(
    platform.name || platform.brandName || platform.url || config.brandName || "WIFI"
  ).toUpperCase();
  const supportPhone = String(
    config.supportPhone || platform.supportPhone || platform.admin_phone || platform.phone || ""
  );

  let html = readTemplate();
  html = replaceJsVar(html, "API_BASE_URL", resolveApiBaseUrl(options.req));
  html = replaceJsVar(html, "PLATFORM_ID", options.platformID || platform.platformID || "");
  html = replaceJsVar(html, "HASH", options.hash || getHotspotHash(options.host));
  html = replaceJsVar(html, "MAC", "$(mac)");
  html = replaceJsVar(html, "BRAND_NAME", brandName);
  html = replaceElementText(html, "footerBrandName", brandName);
  html = replaceJsVar(html, "SUPPORT_PHONE", supportPhone);
  html = replaceJsVar(html, "PACKAGES", normalizePackages(options.packages));
  html = replaceJsVar(html, "PREVIEW_MODE", Boolean(options.preview));
  return html;
}

module.exports = {
  getHotspotHash,
  normalizePackages,
  renderOfflineBoxLoginTemplate,
  resolveApiBaseUrl,
};
