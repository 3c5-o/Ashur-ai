const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "openrouter/free";

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
    const apiKey = String(process.env.OPENROUTER_API_KEY || "").trim();

    if (!apiKey) {
      return res.status(500).json({
        status: false,
        error: "OPENROUTER_API_KEY غير موجود داخل إعدادات Vercel"
      });
    }

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

    const history = Array.isArray(body.history)
      ? body.history
          .filter(
            item =>
              item &&
              (item.role === "user" || item.role === "assistant") &&
              typeof item.content === "string"
          )
          .slice(-16)
          .map(item => ({
            role: item.role,
            content: item.content.slice(0, 12000)
          }))
      : [];

    const messages = [
      {
        role: "system",
        content:
          "أنت Ashur AI، مساعد عربي واضح ومفيد. أجب باللغة التي يستخدمها المستخدم، وبالعربية العراقية عند ملاءمة السياق."
      },
      ...history,
      {
        role: "user",
        content: text
      }
    ];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55000);

    let upstream;

    try {
      upstream = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Accept": "application/json",
          "HTTP-Referer": "https://ashur-ai1.vercel.app",
          "X-Title": "Ashur AI"
        },
        body: JSON.stringify({
          model: MODEL,
          messages,
          temperature
        }),
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
        error: "OpenRouter أرجع استجابة غير صالحة",
        upstream_status: upstream.status,
        preview: raw.slice(0, 500)
      });
    }

    if (!upstream.ok) {
      const message =
        data?.error?.message ||
        data?.message ||
        `OpenRouter أعاد HTTP ${upstream.status}`;

      return res.status(upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502).json({
        status: false,
        error: message,
        upstream_status: upstream.status
      });
    }

    const answer = data?.choices?.[0]?.message?.content;

    if (!answer) {
      return res.status(502).json({
        status: false,
        error: "تم الاتصال بـ OpenRouter لكن لم يصل نص الرد",
        upstream: data
      });
    }

    return res.status(200).json({
      status: true,
      response: String(answer),
      model: data.model || MODEL,
      provider: "OpenRouter"
    });

  } catch (error) {
    if (error?.name === "AbortError") {
      return res.status(504).json({
        status: false,
        error: "انتهت مهلة انتظار OpenRouter"
      });
    }

    console.error("OpenRouter proxy error:", error);

    return res.status(500).json({
      status: false,
      error: "تعذر الاتصال بـ OpenRouter",
      details: error?.message || "Unknown error"
    });
  }
};
