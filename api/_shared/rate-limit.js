const memoryBuckets = new Map();

function getClientIp(req) {
  return String(
    req.headers["x-forwarded-for"] ||
    req.headers["x-real-ip"] ||
    "unknown"
  ).split(",")[0].trim();
}

function memoryLimit(key, limit, windowSeconds) {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const current = memoryBuckets.get(key);

  if (!current || now - current.startedAt > windowMs) {
    memoryBuckets.set(key, { startedAt: now, count: 1 });
    return false;
  }

  current.count += 1;
  return current.count > limit;
}

async function upstashLimit(key, limit, windowSeconds) {
  const base = String(process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
  const token = String(process.env.UPSTASH_REDIS_REST_TOKEN || "");

  if (!base || !token) return null;

  try {
    const response = await fetch(base + "/pipeline", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify([
        ["INCR", key],
        ["EXPIRE", key, String(windowSeconds), "NX"]
      ])
    });

    if (!response.ok) return null;

    const data = await response.json();
    const count = Number(data?.[0]?.result || 0);
    return count > limit;
  } catch {
    return null;
  }
}

async function isRateLimited(key, limit, windowSeconds) {
  const central = await upstashLimit(key, limit, windowSeconds);
  if (typeof central === "boolean") return central;
  return memoryLimit(key, limit, windowSeconds);
}

module.exports = {
  getClientIp,
  isRateLimited
};
