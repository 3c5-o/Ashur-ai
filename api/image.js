const { getClientIp, isRateLimited } = require("./_shared/rate-limit");
const IMAGE_ENDPOINT = "https://camillecyrm.serv00.net/v1/images/generations";
const DIRECT_FLUX_ENDPOINT = "https://camillecyrm.serv00.net/Image-Flux/api.php";
const ALLOWED_MODELS = new Set(["auto","flux","flux-realism","flux-anime","sana"]);
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

function autoModel(prompt) {
  const p = String(prompt || "").toLowerCase();

  if (
    /(^|\s)(anime|manga|cartoon)(\s|$)/i.test(p) ||
    /انمي|أنمي|كرتون|كرتوني/.test(p)
  ) {
    return "flux-anime";
  }

  if (
    /realistic|photoreal|portrait|photograph|photo/i.test(p) ||
    /واقعي|واقعية|فوتوغرافي|بورتريه|صورة شخصية/.test(p)
  ) {
    return "flux-realism";
  }

  if (
    /cinematic|poster|4k|8k|ultra detail|high detail/i.test(p) ||
    /سينمائي|بوستر|ملصق|تفاصيل عالية|دقة عالية/.test(p)
  ) {
    return "sana";
  }

  return "flux";
}

function buildModelChain(prompt, requestedModel) {
  const normalized = ALLOWED_MODELS.has(requestedModel) ? requestedModel : "auto";
  const primary = normalized === "auto" ? autoModel(prompt) : normalized;

  const order = [primary, "flux", "sana", "flux-realism", "flux-anime"];
  return [...new Set(order)].filter(model => model !== "auto");
}

function extractImage(data) {
  const first = Array.isArray(data?.data) ? data.data[0] : null;

  const url =
    first?.url ||
    data?.url ||
    data?.image ||
    data?.image_url ||
    data?.result?.url ||
    null;

  const b64 =
    first?.b64_json ||
    data?.b64_json ||
    data?.base64 ||
    null;

  if (url) return String(url);
  if (b64) return `data:image/png;base64,${b64}`;
  return null;
}

async function callImagesEndpoint({ key, prompt, model, signal }) {
  const response = await fetch(IMAGE_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      model,
      prompt,
      size: "1024x1024"
    }),
    signal
  });

  let data = {};
  try {
    data = await response.json();
  } catch {
    const raw = await response.text().catch(() => "");
    data = { message: raw.slice(0, 500) };
  }

  return { response, data, image: extractImage(data) };
}

async function callDirectFlux({ key, prompt, signal }) {
  const url = new URL(DIRECT_FLUX_ENDPOINT);
  url.searchParams.set("text", prompt);
  url.searchParams.set("key", key);
  url.searchParams.set("view", "1");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json, image/*;q=0.9, */*;q=0.8"
    },
    redirect: "follow",
    signal
  });

  const type = response.headers.get("content-type") || "";

  if (type.startsWith("image/")) {
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      response,
      data: {},
      image: `data:${type};base64,${bytes.toString("base64")}`
    };
  }

  let data = {};
  try {
    data = await response.json();
  } catch {
    const raw = await response.text().catch(() => "");
    data = { message: raw.slice(0, 500) };
  }

  return { response, data, image: extractImage(data) };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method !== "POST") {
    return res.status(405).json({
      status: false,
      error: "الطريقة غير مدعومة."
    });
  }

  if (!validateOrigin(req)) {
    return res.status(403).json({
      status: false,
      error: "الطلب غير مسموح."
    });
  }

  const ip = getClientIp(req);

  if (await isRateLimited("image:" + ip, 15, 600)) {
    return res.status(429).json({
      status: false,
      error: "تم إرسال طلبات صور كثيرة خلال فترة قصيرة. حاول لاحقاً."
    });
  }

  try {
    let body = req.body || {};

    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(400).json({
          status: false,
          error: "بيانات الطلب غير صالحة."
        });
      }
    }

    const prompt = String(body.prompt || "").trim().slice(0, 5000);
    const requestedModel = String(body.model || "auto").trim();
    const key = String(process.env.AIGATE_API_KEY || "").trim();

    if (!prompt) {
      return res.status(400).json({
        status: false,
        error: "اكتب وصف الصورة أولاً."
      });
    }

    if (!key) {
      return res.status(401).json({
        status: false,
        error: "إعداد إنشاء الصور غير مكتمل على الخادم."
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55000);

    let lastStatus = 502;
    let lastDetail = "";

    try {
      const chain = buildModelChain(prompt, requestedModel);

      for (const model of chain) {
        const result = await callImagesEndpoint({
          key,
          prompt,
          model,
          signal: controller.signal
        });

        if (result.response.ok && result.image) {
          return res.status(200).json({
            status: true,
            image: result.image
          });
        }

        lastStatus = result.response.status || 502;
        lastDetail = String(
          result.data?.error?.message ||
          result.data?.error ||
          result.data?.message ||
          ""
        );

        if (lastStatus === 401 || /key|access|مفتاح|unauthorized/i.test(lastDetail)) {
          return res.status(401).json({
            status: false,
            error: "تم رفض مفتاح إنشاء الصور."
          });
        }
      }

      // Documented direct image endpoint as a final fallback.
      const direct = await callDirectFlux({
        key,
        prompt,
        signal: controller.signal
      });

      if (direct.response.ok && direct.image) {
        return res.status(200).json({
          status: true,
          image: direct.image
        });
      }

      lastStatus = direct.response.status || lastStatus;
      lastDetail = String(
        direct.data?.error?.message ||
        direct.data?.error ||
        direct.data?.message ||
        lastDetail
      );

      console.error("Image generation failed:", lastStatus, lastDetail);

      return res.status(lastStatus >= 400 && lastStatus < 600 ? lastStatus : 502).json({
        status: false,
        error: "تعذر إنشاء الصورة حالياً. جرّب وصفاً مختلفاً أو أعد المحاولة."
      });

    } finally {
      clearTimeout(timeout);
    }

  } catch (error) {
    if (error?.name === "AbortError") {
      return res.status(504).json({
        status: false,
        error: "استغرق إنشاء الصورة وقتاً أطول من المتوقع."
      });
    }

    console.error("Ashur image error:", error);

    return res.status(500).json({
      status: false,
      error: "حدث خطأ مؤقت أثناء إنشاء الصورة."
    });
  }
};
