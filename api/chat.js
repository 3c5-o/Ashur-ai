const UPSTREAM_API = "https://camillecyrm.serv00.net/GPT-5-6/api";

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      status: false,
      error: "Method Not Allowed"
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
          error: "JSON غير صالح"
        });
      }
    }

    const text = String(body.text || "").trim();

    if (!text) {
      return res.status(400).json({
        status: false,
        error: "يرجى كتابة رسالة أولاً"
      });
    }

    if (text.length > 12000) {
      return res.status(400).json({
        status: false,
        error: "النص طويل جدًا لهذه النسخة التجريبية"
      });
    }

    let temperature = Number(body.temperature ?? 0.7);

    if (!Number.isFinite(temperature)) {
      temperature = 0.7;
    }

    temperature = Math.max(0, Math.min(2, temperature));

    const conversationId = String(
      body.conversation_id ||
      body.chat_id ||
      ""
    ).trim();

    const params = new URLSearchParams();
    params.set("text", text);
    params.set("temperature", String(temperature));

    if (conversationId) {
      params.set("conversation_id", conversationId);
    }

    if (body.link) {
      params.set("link", String(body.link));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55000);

    let upstream;

    try {
      upstream = await fetch(`${UPSTREAM_API}?${params.toString()}`, {
        method: "GET",
        headers: {
          Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
          "User-Agent": "Ashur-AI-Test/1.0"
        },
        redirect: "follow",
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    const raw = await upstream.text();

    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      return res.status(502).json({
        status: false,
        error: "الخدمة الخارجية لم ترجع JSON صالح",
        http_status: upstream.status,
        preview: raw.slice(0, 700)
      });
    }

    if (!upstream.ok) {
      return res.status(502).json({
        status: false,
        error: data.error || `الخدمة الخارجية أعادت HTTP ${upstream.status}`,
        upstream_status: upstream.status
      });
    }

    const answer =
      data.response ??
      data.answer ??
      data.message ??
      data.result ??
      null;

    if (!answer) {
      return res.status(502).json({
        status: false,
        error: data.error || "تم الاتصال بالخدمة لكن لم يتم العثور على نص الرد",
        upstream_status: upstream.status,
        upstream: data
      });
    }

    return res.status(200).json({
      status: true,
      response: String(answer),
      model: data.model || "GPT-5.6",
      conversation_id:
        data.conversation_id ||
        data.chat_id ||
        conversationId ||
        null
    });

  } catch (error) {
    if (error?.name === "AbortError") {
      return res.status(504).json({
        status: false,
        error: "انتهت مهلة انتظار الخدمة الخارجية"
      });
    }

    console.error("Proxy error:", error);

    return res.status(500).json({
      status: false,
      error: "تعذر الاتصال بالخدمة الخارجية",
      details: error?.message || "Unknown error"
    });
  }
};
