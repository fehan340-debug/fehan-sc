# إعداد تنبيهات Telegram

1. افتح Telegram وابحث عن `@BotFather` ثم نفّذ `/newbot` واختر اسمًا وusername للبوت.
2. ضع القيم التالية في Netlify Environment Variables / GitHub Secrets حسب مكان التشغيل:
   - `TELEGRAM_BOT_TOKEN` = التوكن الذي يعطيك BotFather.
   - `TELEGRAM_BOT_USERNAME` = username للبوت بدون @.
   - `TELEGRAM_WEBHOOK_SECRET` = قيمة سرية عشوائية اختيارية لحماية Webhook.
   - `SITE_URL` = الدومين الرئيسي للموقع، مثل `https://example.com`.
3. من لوحة المدير اضغط «تفعيل ربط بوت تليجرام». هذا يرسل `setWebhook` إلى:
   `/.netlify/functions/telegram-webhook`
4. العميل يدخل «معلومات الحساب» ويضغط «ربط التنبيهات عبر تليجرام»، ثم يضغط Start داخل البوت. يتم ربط `telegramChatId` بحساب العميل في سجل المستخدمين داخل Supabase (`app_users_store`).
5. عند حفظ أي تنبيه، يتم حفظ الشروط في `user_alerts`. عند تحقق الشرط يسجل الحدث في `stock_alerts` ويُرسل رسالة Telegram إذا كان الحساب مربوطًا. الجرس الداخلي لا يعتمد على Telegram ويستمر حتى لو كانت خدمة Telegram غير متاحة.
6. قسم Telegram Broadcast في لوحة المدير يرسل الرسالة لكل حساب نشط لديه `telegramChatId`. فشل مستخدم لا يوقف بقية الإرسال.

## متغيرات البيئة المطلوبة

```text
TELEGRAM_BOT_TOKEN=
TELEGRAM_BOT_USERNAME=
TELEGRAM_WEBHOOK_SECRET=
SITE_URL=
```

لا تضع التوكن داخل ملفات JavaScript أو GitHub repository.
