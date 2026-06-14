const toBytes = (value) => {
    if (typeof value === "bigint") return value >= 0n ? value : 0n;
    const text = String(value ?? "0").trim();
    if (!/^\d+$/.test(text)) return 0n;
    try {
        return BigInt(text);
    } catch {
        return 0n;
    }
};

const readBytes = (row, direction) => {
    const fields = direction === "rx"
        ? ["bytes-in", "acctinputoctets"]
        : ["bytes-out", "acctoutputoctets"];
    for (const field of fields) {
        if (row?.[field] !== undefined && row?.[field] !== null) return toBytes(row[field]);
    }
    return 0n;
};

const counterDelta = (current, previous) => {
    const next = toBytes(current);
    const prior = toBytes(previous);
    return next >= prior ? next - prior : next;
};

const apiCounterKey = (service, row) => {
    const pppIdentity = row?.name
        ? `${row.name}:${row["caller-id"] || row.address || row[".id"] || "session"}`
        : row?.[".id"] || row?.sessionId;
    const stableId = service === "hotspot" ? row?.name || row?.[".id"] : pppIdentity;
    return stableId ? `api:${service}:${String(stableId).trim()}` : "";
};

const radiusCounterKey = (row) => {
    const stableId = row?.acctuniqueid || row?.acctsessionid || row?.radacctid;
    return stableId ? `radius:${String(stableId).trim()}` : "";
};

module.exports = { apiCounterKey, counterDelta, radiusCounterKey, readBytes, toBytes };
