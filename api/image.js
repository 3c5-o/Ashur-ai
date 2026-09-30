const IMAGE_ENDPOINT = "https://camillecyrm.serv00.net/v1/images/generations";
const ALLOWED_MODELS = new Set(["flux","flux-realism","flux-anime","sana"]);
const buckets = new Map();

function getClientIp(req) {
  return String(
    req.headers["x-forwarded-for"] ||
    req.headers["x-real-ip"] ||
    "unknown"
  ).split(",")[0].trim();
}

function isRateLimited(ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const maxRequests = 12;
  const current = buckets.get(ip);

  if (!current || now - current.startedAt > windowMs) {
    buckets.set(ip, { startedAt: now, count: 1 });
    return false;
  }

  current.count += 1;
  return current.count > maxRequests;
}

function validateOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;

  try {
    const originUrl = new URL(origin);
    return originUrl.host === req.headers.host;
  } catch {
    return false;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method !== "POST") {
    return res.status(405).json({ status:false, error:"الطريقة غير مدعومة." });
  }

  if (!validateOrigin(req)) {
    return res.status(403).json({ status:false, error:"الطلب غير مسموح." });
  }

  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    return res.status(429).json({
      status:false,
      error:"تم إرسال طلبات صور كثيرة خلال فترة قصيرة. حاول لاحقاً."
    });
  }

  try {
    let body = req.body || {};
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch {
        return res.status(400).json({status:false,error:"بيانات الطلب غير صالحة."});
      }
    }

    const prompt = String(body.prompt || "").trim().slice(0, 5000);
    const requestedModel = String(body.model || "flux").trim();
    const model = ALLOWED_MODELS.has(requestedModel) ? requestedModel : "flux";
    const key = String(process.env.AIGATE_API_KEY || body.key || "").trim();

    if (!prompt) {
      return res.status(400).json({status:false,error:"اكتب وصف الصورة أولاً."});
    }

    if (!key) {
      return res.status(401).json({
        status:false,
        error:"ميزة إنشاء الصور تحتاج مفتاح وصول للخادم التجريبي."
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55000);

    let upstream;
    try {
      upstream = await fetch(IMAGE_ENDPOINT, {
        method:"POST",
        headers:{
          Authorization:`Bearer ${key}`,
          "Content-Type":"application/json",
          Accept:"application/json"
        },
        body:JSON.stringify({
          model,
          prompt,
          size:"1024x1024"
        }),
        signal:controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    let data = {};
    try { data = await upstream.json(); } catch {}

    if (!upstream.ok) {
      const detail = String(
        data?.error?.message ||
        data?.error ||
        data?.message ||
        ""
      );
      console.error("Image generation error:", upstream.status, detail);

      if (upstream.status === 401 || /key|access|مفتاح|unauthorized/i.test(detail)) {
        return res.status(401).json({
          status:false,
          error:"تم رفض مفتاح إنشاء الصور."
        });
      }

      return res.status(upstream.status).json({
        status:false,
        error:"تعذر إنشاء الصورة حالياً."
      });
    }

    const first = Array.isArray(data?.data) ? data.data[0] : null;
    const url = first?.url || null;
    const b64 = first?.b64_json || null;

    if (!url && !b64) {
      return res.status(502).json({
        status:false,
        error:"تم إنشاء الطلب لكن لم يصل ملف الصورة."
      });
    }

    return res.status(200).json({
      status:true,
      image:url || `data:image/png;base64,${b64}`
    });

  } catch (error) {
    if (error?.name === "AbortError") {
      return res.status(504).json({
        status:false,
        error:"استغرق إنشاء الصورة وقتاً أطول من المتوقع."
      });
    }

    console.error("Ashur image error:", error);
    return res.status(500).json({
      status:false,
      error:"حدث خطأ مؤقت أثناء إنشاء الصورة."
    });
  }
};
