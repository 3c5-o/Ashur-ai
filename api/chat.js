const AI_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const AI_MODEL = "openrouter/free";

const EXPERIMENTAL_HOST = "camillecyrm.serv00.net";
const DEFAULT_EXPERIMENTAL_URL = "https://camillecyrm.serv00.net/GPT-5-6/api";

const MODE_PROMPTS = {
  general: "كن مساعداً عاماً دقيقاً ومباشراً، ونظم الإجابة بحسب حاجة المستخدم.",
  writing: "ركز على الكتابة والصياغة والتحرير. قدم نصوصاً طبيعية ومتماسكة وبالأسلوب الذي يطلبه المستخدم.",
  coding: "تصرف كمساعد برمجي. قدم حلولاً عملية وكوداً منظماً، واشرح الأخطاء والخطوات عند الحاجة.",
  study: "ساعد في التعلم والفهم. اشرح بوضوح وعلى مراحل، واستخدم أمثلة قصيرة عند فائدتها.",
  summary: "ركز على التلخيص واستخراج النقاط المهمة مع الحفاظ على المعنى وعدم اختراع معلومات.",
  translate: "ركز على الترجمة الطبيعية الدقيقة، واحفظ المعنى والنبرة ولا تضف شرحاً إلا إذا طُلب."
};

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
  const maxRequests = 30;
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

function cleanHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .filter(
      item =>
        item &&
        (item.role === "user" || item.role === "assistant") &&
        typeof item.content === "string"
    )
    .slice(-18)
    .map(item => ({
      role: item.role,
      content: item.content.slice(0, 14000)
    }));
}

function cleanAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];

  return attachments
    .filter(item => item && typeof item === "object")
    .slice(0, 4)
    .map(item => ({
      kind: item.kind === "image" ? "image" : "text",
      name: String(item.name || "ملف").slice(0, 120),
      data: typeof item.data === "string" ? item.data : "",
      text: typeof item.text === "string" ? item.text.slice(0, 22000) : ""
    }));
}

function publicError(status) {
  if (status === 401 || status === 403) {
    return "خدمة الذكاء الاصطناعي غير متاحة حالياً.";
  }
  if (status === 402) {
    return "الخدمة وصلت إلى حد الاستخدام الحالي. جرّب لاحقاً.";
  }
  if (status === 429) {
    return "تم بلوغ الحد المؤقت للطلبات. انتظر قليلاً ثم أعد المحاولة.";
  }
  return "تعذر إكمال الطلب حالياً. أعد المحاولة بعد قليل.";
}

function buildCombinedText(text, attachments) {
  let combinedText = text;

  const textAttachments = attachments.filter(
    item => item.kind === "text" && item.text
  );

  if (textAttachments.length) {
    combinedText += "\n\n--- الملفات المرفقة ---\n";
    for (const file of textAttachments) {
      combinedText += `\n[ملف: ${file.name}]\n${file.text}\n`;
    }
  }

  return combinedText;
}

function validateExperimentalUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl || DEFAULT_EXPERIMENTAL_URL);

    if (parsed.protocol !== "https:") return null;
    if (parsed.hostname !== EXPERIMENTAL_HOST) return null;
    if (!parsed.pathname.endsWith("/api")) return null;

    parsed.search = "";
    parsed.hash = "";
    return parsed;
  } catch {
    return null;
  }
}

async function handleExperimentalSource({
  res,
  body,
  text,
  attachments,
  temperature
}) {
  const experimental = body.experimental || {};
  const url = validateExperimentalUrl(experimental.url);

  if (!url) {
    return res.status(400).json({
      status: false,
      error: "رابط المصدر التجريبي غير مسموح."
    });
  }

  const combinedText = buildCombinedText(text, attachments).trim();

  if (!combinedText) {
    return res.status(400).json({
      status: false,
      error: "المصدر التجريبي يحتاج نصاً للإرسال."
    });
  }

  const key = String(experimental.key || "").trim();
  const conversationId = String(body.conversation_id || "").trim();

  url.searchParams.set("text", combinedText);
  url.searchParams.set("temperature", String(temperature));

  if (key) {
    url.searchParams.set("key", key);
  }

  if (conversationId) {
    url.searchParams.set("conversation_id", conversationId);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000);

  let upstream;

  try {
    upstream = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
        "User-Agent": "Ashur-AI-Experimental/1.0"
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
    console.error("Experimental source invalid response:", upstream.status, raw.slice(0, 300));
    return res.status(502).json({
      status: false,
      error: "المصدر التجريبي رجّع استجابة غير صالحة."
    });
  }

  if (!upstream.ok || data.status === false) {
    const detail = String(
      data.error ||
      data.message ||
      ""
    );

    console.error("Experimental source error:", upstream.status, detail);

    if (/مفتاح|key|access/i.test(detail)) {
      return res.status(401).json({
        status: false,
        error: "المصدر التجريبي يحتاج مفتاح وصول صالح."
      });
    }

    return res.status(502).json({
      status: false,
      error: "تعذر استخدام المصدر التجريبي حالياً."
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
      error: "المصدر التجريبي لم يرجّع نصاً."
    });
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("X-Accel-Buffering", "no");
  res.write(String(answer));
  return res.end();
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

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
  if (isRateLimited(ip)) {
    return res.status(429).json({
      status: false,
      error: "تم إرسال طلبات كثيرة خلال فترة قصيرة. انتظر قليلاً ثم حاول مجدداً."
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

    const text = String(body.text || "").trim();
    const attachments = cleanAttachments(body.attachments);

    if (!text && attachments.length === 0) {
      return res.status(400).json({
        status: false,
        error: "اكتب رسالة أو أرفق ملفاً أولاً."
      });
    }

    if (text.length > 16000) {
      return res.status(400).json({
        status: false,
        error: "الرسالة طويلة جداً. اختصرها ثم أعد المحاولة."
      });
    }

    let temperature = Number(body.temperature ?? 0.7);
    if (!Number.isFinite(temperature)) temperature = 0.7;
    temperature = Math.max(0, Math.min(1.5, temperature));

    if (body.source === "experimental") {
      return await handleExperimentalSource({
        res,
        body,
        text,
        attachments,
        temperature
      });
    }

    const apiKey = String(process.env.OPENROUTER_API_KEY || "").trim();

    if (!apiKey) {
      return res.status(500).json({
        status: false,
        error: "إعداد الخدمة غير مكتمل."
      });
    }

    const mode = MODE_PROMPTS[body.mode] ? body.mode : "general";
    const history = cleanHistory(body.history);

    const systemPrompt = [
      "أنت Ashur AI، مساعد ذكي سريع وواضح.",
      "أجب باللغة التي يستخدمها المستخدم، واستخدم العربية العراقية عندما يلائم السياق.",
      "لا تذكر اسم مزود النموذج أو المنصة الخلفية أو اسم النموذج أو أي تفاصيل تقنية داخلية.",
      "لا تضف عبارة من قبيل: المصدر، المزود، النموذج المستخدم، أو معلومات النظام.",
      "استخدم Markdown عند الحاجة، ونسق الأكواد داخل كتل كود.",
      MODE_PROMPTS[mode]
    ].join(" ");

    const combinedText = buildCombinedText(text, attachments);

    const imageAttachments = attachments.filter(
      item =>
        item.kind === "image" &&
        /^data:image\/(png|jpe?g|webp);base64,/i.test(item.data) &&
        item.data.length <= 3_000_000
    );

    let userContent;

    if (imageAttachments.length) {
      userContent = [
        {
          type: "text",
          text: combinedText || "حلل الصور المرفقة وساعدني بما هو مناسب."
        },
        ...imageAttachments.map(item => ({
          type: "image_url",
          image_url: { url: item.data }
        }))
      ];
    } else {
      userContent = combinedText;
    }

    const messages = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: userContent }
    ];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55000);

    let upstream;

    try {
      upstream = await fetch(AI_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "HTTP-Referer": "https://ashur-ai1.vercel.app",
          "X-Title": "Ashur AI"
        },
        body: JSON.stringify({
          model: AI_MODEL,
          messages,
          temperature,
          stream: true
        }),
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timeout);
      throw error;
    }

    if (!upstream.ok) {
      clearTimeout(timeout);

      let details = "";
      try {
        const data = await upstream.json();
        details = data?.error?.message || data?.message || "";
      } catch {}

      console.error("AI upstream error:", upstream.status, details);

      return res.status(upstream.status).json({
        status: false,
        error: publicError(upstream.status)
      });
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("X-Accel-Buffering", "no");

    if (!upstream.body) {
      clearTimeout(timeout);
      res.write("تعذر بدء الرد حالياً.");
      return res.end();
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let wroteContent = false;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split("\n");
        buffer = parts.pop() || "";

        for (const line of parts) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;

          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;

          try {
            const data = JSON.parse(payload);
            const chunk = data?.choices?.[0]?.delta?.content;

            if (typeof chunk === "string" && chunk) {
              wroteContent = true;
              res.write(chunk);
            }
          } catch {}
        }
      }
    } finally {
      clearTimeout(timeout);
    }

    if (!wroteContent) {
      res.write("تعذر إنشاء الرد حالياً. أعد المحاولة.");
    }

    return res.end();

  } catch (error) {
    if (error?.name === "AbortError") {
      if (!res.headersSent) {
        return res.status(504).json({
          status: false,
          error: "استغرق الرد وقتاً أطول من المتوقع. أعد المحاولة."
        });
      }
      return res.end();
    }

    console.error("Ashur AI error:", error);

    if (!res.headersSent) {
      return res.status(500).json({
        status: false,
        error: "حدث خطأ مؤقت. أعد المحاولة بعد قليل."
      });
    }

    return res.end();
  }
};
