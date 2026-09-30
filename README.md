# Ashur AI

نسخة تجريبية لواجهة محادثة مرتبطة بـ OpenRouter عبر Vercel Serverless Function.

## البنية

- `index.html` — واجهة المحادثة.
- `api/chat.js` — البروكسي الآمن الذي يتصل بـ OpenRouter.
- `vercel.json` — إعدادات دالة Vercel.

## متغير البيئة المطلوب في Vercel

أضف Secret باسم:

```
OPENROUTER_API_KEY
```

ولا تضع المفتاح داخل GitHub لأن المستودع عام.

## المزود

```
POST https://openrouter.ai/api/v1/chat/completions
```

الموديل المستخدم حاليًا:

```
openrouter/free
```

## النشر

المشروع مربوط بفرع `main`. أي Push جديد على `main` يفترض أن ينشئ Deployment جديدًا تلقائيًا على Vercel إذا كان Git Integration مفعّلًا.
