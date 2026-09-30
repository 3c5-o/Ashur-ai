const AI_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const AI_MODEL = "openrouter/free";

const EXPERIMENTAL_HOST = "camillecyrm.serv00.net";
const DEFAULT_EXPERIMENTAL_URL = "https://camillecyrm.serv00.net/v1/chat/completions";
const ALLOWED_EXPERIMENTAL_MODELS = new Set([
  "auto",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5-6",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4.1-nano",
  "o1",
  "o1-mini",
  "o3-mini",
  "deepseek-v3.2",
  "qwen-30b",
  "llama-3.3-70b-instruct",
  "gemma-4",
  "doubao-seed-2.0-code",
  "doubao-seed-2.0-pro",
  "doubao-seed-2.0-lite",
  "doubao-seed-2.0-mini",
  "deepai-standard",
  "deepai-online",
  "gemini-web",
  "claude-3-5-sonnet"
]);

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

function buildSystemPrompt(mode) {
  return [
    "أنت Ashur AI، مساعد ذكي سريع وواضح.",
    "أجب باللغة التي يستخدمها المستخدم، واستخدم العربية العراقية عندما يلائم السياق.",
    "لا تذكر اسم مزود النموذج أو المنصة الخلفية أو اسم النموذج أو أي تفاصيل تقنية داخلية.",
    "لا تضف عبارة من قبيل: المصدر، المزود، النموذج المستخدم، أو معلومات النظام.",
    "استخدم Markdown عند الحاجة، ونسق الأكواد داخل كتل كود.",
    MODE_PROMPTS[mode] || MODE_PROMPTS.general
  ].join(" ");
}

function validateExperimentalUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl || DEFAULT_EXPERIMENTAL_URL);

    if (parsed.protocol !== "https:") return null;
    if (parsed.hostname !== EXPERIMENTAL_HOST) return null;
    if (parsed.pathname !== "/v1/chat/completions") return null;

    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

async function streamOpenAICompatibleResponse(upstream, res) {
  if (!upstream.body) {
    res.write("تعذر بدء الرد حالياً.");
    return;
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let wroteContent = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
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

  if (!wroteContent) {
    res.write("تعذر إنشاء الرد حالياً. أعد المحاولة.");
  }
}

async function handleExperimentalSource({
  res,
  body,
  text,
  attachments,
  temperature,
  mode,
  history
}) {
  const experimental = body.experimental || {};
  const endpoint = validateExperimentalUrl(experimental.url);

  if (!endpoint) {
    return res.status(400).json({
      status: false,
      error: "رابط المصدر التجريبي غير مسموح."
    });
  }

  const key = String(
    process.env.AIGATE_API_KEY ||
    experimental.key ||
    ""
  ).trim();

  if (!key) {
    return res.status(401).json({
      status: false,
      error: "المصدر التجريبي يحتاج مفتاح وصول."
    });
  }

  const requestedModel = String(experimental.model || "gpt-5-6").trim();
  const model = ALLOWED_EXPERIMENTAL_MODELS.has(requestedModel)
    ? requestedModel
    : "gpt-5-6";

  const training = String(experimental.training || "").slice(0, 30000);
  const markdown = String(experimental.md || "").slice(0, 30000);

  const imageAttachments = attachments.filter(item => item.kind === "image");
  if (imageAttachments.length) {
    return res.status(400).json({
      status: false,
      error: "رفع الصور غير مفعّل بعد على المصدر التجريبي."
    });
  }

  const combinedText = buildCombinedText(text, attachments).trim();

  if (!combinedText) {
    return res.status(400).json({
      status: false,
      error: "المصدر التجريبي يحتاج نصاً للإرسال."
    });
  }

  const messages = [
    { role: "system", content: buildSystemPrompt(mode) },
    ...history,
    { role: "user", content: combinedText }
  ];

  const requestBody = {
    model,
    messages,
    temperature,
    stream: true
  };

  if (training) requestBody.training = training;
  if (markdown) requestBody.md = markdown;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000);

  let upstream;

  try {
    upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream"
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }

  if (!upstream.ok) {
    clearTimeout(timeout);

    let detail = "";
    try {
      const data = await upstream.json();
      detail = String(
        data?.error?.message ||
        data?.error ||
        data?.message ||
        ""
      );
    } catch {}

    console.error("Experimental AI error:", upstream.status, detail);

    if (upstream.status === 401 || /مفتاح|key|access|unauthorized/i.test(detail)) {
      return res.status(401).json({
        status: false,
        error: "المصدر التجريبي رفض مفتاح الوصول."
      });
    }

    return res.status(upstream.status).json({
      status: false,
      error: publicError(upstream.status)
    });
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("X-Accel-Buffering", "no");

  try {
    await streamOpenAICompatibleResponse(upstream, res);
  } finally {
    clearTimeout(timeout);
  }

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

    const mode = MODE_PROMPTS[body.mode] ? body.mode : "general";
    const history = cleanHistory(body.history);

    if (body.source === "experimental") {
      return await handleExperimentalSource({
        res,
        body,
        text,
        attachments,
        temperature,
        mode,
        history
      });
    }

    const apiKey = String(process.env.OPENROUTER_API_KEY || "").trim();

    if (!apiKey) {
      return res.status(500).json({
        status: false,
        error: "إعداد الخدمة غير مكتمل."
      });
    }

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
      { role: "system", content: buildSystemPrompt(mode) },
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

    try {
      await streamOpenAICompatibleResponse(upstream, res);
    } finally {
      clearTimeout(timeout);
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
