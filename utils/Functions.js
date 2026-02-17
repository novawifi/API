const crypto = require("crypto");

const SECRET_KEY = crypto
  .createHash("sha256")
  .update(process.env.ENCRYPTION_KEY)
  .digest();
const ALGORITHM = "aes-256-cbc";

class Utils {
  static encryptPassword(password) {
    if (typeof password !== "string") {
      throw new Error("Password must be a string");
    }
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, SECRET_KEY, iv);
    let encrypted = cipher.update(password, "utf8", "hex");
    encrypted += cipher.final("hex");
    return iv.toString("hex") + ":" + encrypted;
  }

  static decryptPassword(encryptedData) {
    if (typeof encryptedData !== "string" || !encryptedData.includes(":")) {
      throw new Error("Invalid encrypted data format");
    }

    const [ivHex, encrypted] = encryptedData.split(":");
    const iv = Buffer.from(ivHex, "hex");

    if (iv.length !== 16) throw new Error("Invalid IV length");

    const decipher = crypto.createDecipheriv(ALGORITHM, SECRET_KEY, iv);
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  }

  static decryptPasswordSafe(encryptedData) {
    if (typeof encryptedData !== "string") return "";
    try {
      return Utils.decryptPassword(encryptedData);
    } catch (error) {
      return encryptedData;
    }
  }

  static validateDdnsHost(host) {
    if (typeof host !== "string" || host.trim() === "") return false;
    const ddnsRegex = /^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/;
    return ddnsRegex.test(host.trim());
  }

  static isValidIP(ip) {
    const ipv4 =
      /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/;
    const ipv6 =
      /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|::|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4})$/;
    return ipv4.test(ip) || ipv6.test(ip);
  }

  static decodeHashedIP(hash) {
    const buffer = Buffer.from(hash, "base64");
    const lastOctet = buffer[0];
    return `10.10.10.${lastOctet}`;
  }

  static ipToNumber(ip) {
    return ip.split(".").reduce((acc, oct) => acc * 256 + Number(oct), 0);
  }

  static getRangeBounds(range) {
    const cidrRegex =
      /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\/([0-9]|[1-2]\d|3[0-2])$/;
    const rangeRegex =
      /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})-(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;

    if (cidrRegex.test(range)) {
      const [base, prefix] = range.split("/");
      const baseNum = this.ipToNumber(base);
      const maskBits = parseInt(prefix, 10);
      const hostBits = 32 - maskBits;
      const start = baseNum & (~((1 << hostBits) - 1));
      const end = start + (1 << hostBits) - 1;
      return { start, end };
    }

    if (rangeRegex.test(range)) {
      const [startIP, endIP] = range.split("-");
      return { start: this.ipToNumber(startIP), end: this.ipToNumber(endIP) };
    }

    throw new Error("Invalid range format. Must be CIDR or IP-IP.");
  }

  static rangesOverlap(a, b) {
    return a.start <= b.end && a.end >= b.start;
  }

  static hashInternalIP(ip) {
    const parts = ip.split(".");
    if (
      parts.length !== 4 ||
      parts[0] !== "10" ||
      parts[1] !== "10" ||
      parts[2] !== "10"
    ) {
      throw new Error("Invalid IP format. Expected format: 10.10.10.X");
    }

    const lastOctet = parseInt(parts[3]);
    if (isNaN(lastOctet) || lastOctet < 0 || lastOctet > 255) {
      throw new Error("Invalid last octet");
    }

    const buffer = Buffer.from([lastOctet]);
    return buffer.toString("base64");
  }

  static addPeriod(base, value, unit) {
    switch (unit) {
      case "minute":
        return new Date(base.getTime() + value * 60000);
      case "hour":
        return new Date(base.getTime() + value * 3600000);
      case "day":
        return new Date(base.getTime() + value * 86400000);
      case "month":
        return new Date(base.setMonth(base.getMonth() + value));
      case "year":
        return new Date(base.setFullYear(base.getFullYear() + value));
      default:
        return base;
    }
  }

  static getClientIp(req) {
    let ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.connection?.remoteAddress ||
      req.socket?.remoteAddress ||
      req.connection?.socket?.remoteAddress;

    if (ip === "::1") ip = "127.0.0.1";
    if (ip.startsWith("::ffff:")) ip = ip.replace("::ffff:", "");
    return ip;
  }

  static formatMessage(template, values) {
    return template.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? `{${key}}`);
  }

  static generateRandomString() {
    const length = 12;
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  static generateUsername() {
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const length = 8;
    let result = '';

    for (let i = 0; i < length; i++) {
      result += letters.charAt(Math.floor(Math.random() * letters.length));
    }

    return result;
  }

  static validatePhoneNumber(phone) {
    if (!phone) {
      return { valid: false, reason: "Phone number is required" };
    }

    let number = phone.trim().replace(/[\s-]/g, "");

    if (number.startsWith("+")) {
      number = number.slice(1);
    }

    if (number.startsWith("254")) {
      number = "0" + number.slice(3);
    }

    if (!/^\d+$/.test(number)) {
      return { valid: false, reason: "Phone number must contain only digits" };
    }

    if (number.length !== 10) {
      return { valid: false, reason: "Phone number must be 10 digits long" };
    }

    if (!number.startsWith("07") && !number.startsWith("01")) {
      return { valid: false, reason: "Phone number must start with 07 or 01" };
    }

    return { valid: true, phone: number };
  };

  static formatPhoneNumber(phone) {
    const { valid } = this.validatePhoneNumber(phone);
    if (!valid) return null;

    return phone.startsWith("0") ? "254" + phone.substring(1) : phone;
  };
}

module.exports = { Utils };
