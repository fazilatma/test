# سپهر — مرورگر وب و پروکسی برای Cloudflare Workers

یک برنامهٔ یکپارچه و سبک شامل رابط مرورگر فارسیِ چندبرگه‌ای، نسخهٔ نصب‌شدنی موبایل (PWA)، ورود با Google OAuth و دروازهٔ پروکسی HTTP/HTTPS است. برنامه با Cloudflare Workers و Assets اجرا می‌شود و به سرور جداگانه یا پایگاه‌داده نیاز ندارد.

> **نکتهٔ فنی مهم:** این پروژه یک پوستهٔ مرورگر وب با محتوای داخل iframe ایزوله است؛ موتور Chromium یا مرورگر کاملِ قابل‌میزبانی در Worker نیست. نسخهٔ موبایل یک PWA است، نه فایل APK یا VPN سیستمی. مقصدهای مجاز برای سایت‌های ساده و بسیاری از صفحات معمولی کار می‌کنند، اما برنامه‌های وب پیچیده، سرویس‌هایی که سیاست iframe/CSP یا ورود خاص دارند و بعضی روش‌های جاوااسکریپت ممکن است درست کار نکنند. WebSocket با handshake ارتقا به‌صورت عبوری پشتیبانی می‌شود؛ این Worker تونل عمومی TCP، `CONNECT` یا UDP نمی‌سازد.

## اجرا و استقرار

پیش‌نیاز: Node.js 20+ و حساب Cloudflare با دسترسی Workers.

```bash
npm install
npm run dev
```

### نصب روی موبایل

این پروژه به‌صورت **PWA نصب‌شدنی** ارائه می‌شود؛ برای نصب به APK جداگانه نیاز نیست:

- **Android:** Worker را پس از استقرار روی نشانی HTTPS در Chrome باز کنید و دکمهٔ نصب سپهر یا منوی مرورگر → **Install app / Add to Home screen** را بزنید.
- **iPhone/iPad:** نشانی HTTPS را در Safari باز کنید، **Share** را بزنید و **Add to Home Screen** را انتخاب کنید.

PWA فقط پوستهٔ خود برنامه را برای دسترسی آفلاین cache می‌کند؛ درخواست‌های ورود، API و صفحات مقصد cache نمی‌شوند. صفحه‌هایی که داخل سپهر باز می‌کنید از مسیر `/proxy` همین Worker عبور می‌کنند، اما ترافیک برنامه‌های دیگر گوشی را نمی‌گیرد و VPN سیستمی نیست.

### نصب‌کنندهٔ GitHub برای VPS و Termux

نصب‌کنندهٔ `scripts/install.sh` سورس را با `curl` از شاخهٔ منتشرشده در GitHub دریافت می‌کند، وابستگی‌ها را نصب می‌کند و به‌صورت پیش‌فرض Worker را deploy می‌کند. نیازمندی‌ها: Node.js 20+، npm، `curl` و `tar`.

**Termux** (ابتدا Node و ابزارهای لازم را نصب کنید):

```bash
pkg install -y nodejs-lts curl tar
curl -fsSL "https://raw.githubusercontent.com/fazilatma/test/arena/b1e2952d-test/scripts/install.sh" -o "$HOME/sepehr-install.sh" && bash "$HOME/sepehr-install.sh" deploy
```

**Linux VPS** (با Node.js 20+ از قبل نصب‌شده):

```bash
curl -fsSL "https://raw.githubusercontent.com/fazilatma/test/arena/b1e2952d-test/scripts/install.sh" -o /tmp/sepehr-install.sh && bash /tmp/sepehr-install.sh deploy
```

نصب‌کننده در صورت نیاز ورود تعاملی به Wrangler را اجرا می‌کند. برای فقط دریافت سورس و وابستگی‌ها، آرگومان `install` و برای پیش‌نمایش محلی در Linux VPS، آرگومان `dev` بدهید. اجرای محلی Wrangler برای Termux پشتیبانی مطمئنی ندارد؛ حالت `deploy` توصیه می‌شود. نسخهٔ `dev` برای آزمایش است، نه سرویس production.

**امنیت:** تنظیم پیش‌فرض ورود Google را اجباری نگه می‌دارد و نصب‌کننده secret یا کلید OAuth نمی‌سازد. پیش از استفاده از پروکسی، OAuth و ایمیل مجاز را طبق بخش راه‌اندازی تنظیم کنید؛ allowlist دامنه‌ها را هم محدود نگه دارید.

پروژه برای Arena آماده شده و allowlist پیش‌فرض آن `arena.ai,*.arena.ai,www.google.com,www.gstatic.com` است تا منابع متداول صفحه و reCAPTCHA نیز قابل دریافت باشند. رابط مرورگر عمومی است، اما برای سایت‌های دیگر باید دامنهٔ مورداعتماد را به `PROXY_ALLOWED_HOSTS` در `wrangler.toml` اضافه و Worker را دوباره مستقر کنید. اگر Arena از دامنه‌های وابستهٔ دیگری استفاده کرد، فقط پس از بررسی آن‌ها را اضافه کنید.

الگوهای دقیق و `*.domain.tld` پشتیبانی می‌شوند؛ `*.domain.tld` فقط زیر‌دامنه‌ها را شامل می‌شود و خود `domain.tld` را شامل نمی‌شود. برای جست‌وجوی عبارت‌ها نیز `www.google.com` را به allowlist اضافه کنید. allowlist را محدود نگه دارید؛ استفاده از `*` پشتیبانی نمی‌شود.

### راه‌اندازی ورود Google

1. در Google Cloud یک OAuth Client از نوع **Web application** ایجاد کنید.
2. نشانی callback دقیق Worker را به **Authorized redirect URIs** اضافه کنید:
   `https://<نام-worker>.<حساب>.workers.dev/auth/callback`
3. نشانی اصلی را در `[vars]` قرار دهید (در دامنهٔ سفارشی، همان دامنهٔ نهایی را وارد کنید):
   ```toml
   APP_BASE_URL = "https://<دامنهٔ نهایی>"
   ```
4. مقادیر محرمانه را با Wrangler تنظیم کنید؛ آن‌ها را در Git یا گفت‌وگو قرار ندهید:
   ```bash
   npx wrangler secret put SESSION_SECRET
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```
   `SESSION_SECRET` باید حداقل ۳۲ بایت تصادفی و مستقل از کلیدهای Google باشد. نمونهٔ محلی را در فایل محلیِ نادیده‌گرفته‌شدهٔ `.dev.vars` نگه دارید.
5. برای جلوگیری از ثبت‌نام عمومی، دست‌کم یکی از این سیاست‌ها را تنظیم کنید:
   - `GOOGLE_ALLOWED_EMAILS`: ایمیل‌های دقیق، جداشده با کاما.
   - `GOOGLE_ALLOWED_DOMAIN`: دامنه‌های ایمیل، جداشده با کاما.

بدون allowlist حساب، ورود Google عمداً غیرفعال می‌ماند.

پس از تنظیمات:

```bash
npm run typecheck
npm test
npm run deploy
```

پیش‌فرض `AUTH_REQUIRED = "true"` است. بدون OAuth کامل، کاربر رابط را می‌بیند ولی نمی‌تواند از پروکسی استفاده کند. خاموش‌کردن آن با `AUTH_REQUIRED = "false"` فقط ورود را اختیاری می‌کند؛ allowlist همچنان اجباری است و سرویس به پروکسی باز تبدیل نمی‌شود.

## قابلیت‌ها

- رابط RTL و واکنش‌گرا، چند برگه (تا ۲۰ برگه در نشست جاری)، بازگشت/جلو، بارگذاری مجدد، نشانی، میان‌برها، نشانک و تاریخچهٔ محلی.
- PWA نصب‌شدنی برای Android و iOS، با آیکون‌های سازگار و cache محدود به پوستهٔ برنامه؛ درخواست‌های مقصد و نشست هرگز در cache آفلاین ذخیره نمی‌شوند.
- ورود Google OAuth با بررسی `state` و `nonce`، نشست HMAC امضاشده و کوکی `HttpOnly`, `SameSite=Lax`؛ امکان محدودسازی ایمیل/دامنه.
- عبور روش‌های HTTP استاندارد و بدنهٔ stream‌شده، از جمله `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS` و روش‌های سفارشیِ معتبر، به‌علاوهٔ WebSocket upgrade. کوکی نشست سپهر هیچ‌وقت به مقصد نمی‌رود؛ `Authorization` فقط روی HTTPS و در صورت ارسال صریحِ `X-Proxy-Authorization-Origin` برابر با مبدأ دقیق مقصد عبور می‌کند تا روی ریدایرکت به مبدأ دیگری افشا نشود.
- بازنویسی متداول لینک‌ها، فرم‌ها، منابع و بخشی از CSS برای عبور از مسیر پروکسی. پاسخ HTML داخل iframe با sandbox بارگذاری می‌شود.
- allowlist مقصد، رد نشانی‌های خصوصی/محلی، فقط پورت‌های استاندارد، مدیریت امن ریدایرکت، سقف بدنهٔ درخواست و مهلت اتصال.

## تنظیمات قابل‌استفاده در Worker

| متغیر | توضیح |
|---|---|
| `PROXY_ALLOWED_HOSTS` | ضروری برای درخواست‌های پروکسی؛ فهرست دامنه‌های مجاز با کاما. |
| `AUTH_REQUIRED` | پیش‌فرض `true`. |
| `APP_BASE_URL` | نشانی HTTPS نهایی برنامه؛ در Google OAuth باید با دامنهٔ مجاز و callback هماهنگ باشد. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | اطلاعات OAuth؛ ترجیحاً به‌صورت secret تنظیم شوند. |
| `SESSION_SECRET` | کلید HMAC با حداقل ۳۲ بایت؛ secret. |
| `GOOGLE_ALLOWED_EMAILS`, `GOOGLE_ALLOWED_DOMAIN` | allowlist کاربران؛ برای فعال‌شدن ورود گوگل دست‌کم یکی الزامی است. |
| `PROXY_MAX_BODY_BYTES` | سقف بدنه؛ پیش‌فرض ۱۰ MiB و حداکثر قابل‌تنظیم ۱۰۰ MiB. |
| `PROXY_TIMEOUT_MS` | مهلت اتصال؛ پیش‌فرض ۲۵ ثانیه و سقف ۶۰ ثانیه. |

### مسیرهای API

- `GET /api/session` — وضعیت ورود و پیکربندی، بدون افشای secretها.
- `POST /api/logout` — خروج از نشست با بررسی Origin.
- `GET /auth/google` و `GET /auth/callback` — جریان Google OAuth.
- `/proxy?url=https%3A%2F%2Fexample.com` — پروکسی؛ روش و بدنهٔ HTTP ورودی تا حد پشتیبانی Worker عبور می‌کنند و همان مسیر upgrade مربوط به WebSocket را نیز می‌پذیرد.
- `GET /healthz` — بررسی سلامت سرویس.

برای درخواست API که به credential مقصد نیاز دارد، `Authorization` را همراه با `X-Proxy-Authorization-Origin: https://api.example.com` بفرستید. Worker این header کنترلی را حذف می‌کند و فقط وقتی مقدار Origin با مقصد فعلی یکسان باشد `Authorization` را عبور می‌دهد؛ بنابراین credential روی redirect به host یا scheme دیگر منتقل نمی‌شود. کوکی‌های نشست برنامه هرگز forward نمی‌شوند.

## محدودیت‌ها و امنیت

- این سرویس **forward proxy محدودشده** است، نه مرورگر دسکتاپ، VPN یا تونل خام. WebSocket به‌صورت passthrough ارتقا عبور می‌کند، اما CONNECT/TCP/UDP پشتیبانی نمی‌شود.
- برای ایزوله‌کردن سایت‌های مقصد، محتوای آن‌ها در sandbox اجرا می‌شود؛ دسترسی به ذخیره‌سازی/کوکی‌های خود سایت‌ها و ورود درون‌سایتی تضمین نمی‌شود. Google OAuth در این پروژه ورود به **خود سپهر** است، نه ورود به حساب Arena یا دورزدن سیاست ورود سایت‌های داخل قاب.
- میان‌بر Arena.ai و allowlist آن از پیش اضافه شده‌اند. بااین‌حال، ورود Arena و آزمون‌های CAPTCHA ممکن است به کوکی‌ها، popupها و مبدأهای Google وابسته باشند؛ این Worker تضمین نمی‌کند آن جریان‌ها در iframe پروکسی کار کنند. اگر این بخش‌ها لازم‌اند، Arena را مستقیماً در مرورگر عادی باز کنید؛ این برنامه CAPTCHA یا محدودیت‌های سایت را دور نمی‌زند.
- بعضی سایت‌ها قاب تعبیه‌شده را ممنوع می‌کنند یا روی URL اصلی، service worker، WebSocket، جاوااسکریپت پویا، CAPTCHA و کوکی‌های third-party تکیه دارند؛ بازنویسی HTML یک مرورگر کامل را شبیه‌سازی نمی‌کند.
- فقط دامنه‌های تحت کنترل یا مورداعتماد خود را در allowlist بگذارید. اگر ورود را اختیاری می‌کنید، هر بازدیدکننده می‌تواند همان دامنه‌های مجاز را از Worker شما درخواست کند. دامنه‌های allowlist‌شده‌ای را انتخاب نکنید که بتوانند به سرویس‌های خصوصی یا حساس شما resolve شوند.
- پاسخ `Set-Cookie` و headerهای امنیتی iframe از مبدأ حذف می‌شوند تا از نشست برنامه و sandbox محافظت شود؛ در نتیجه سازگاری برخی سایت‌ها محدود است.
- به‌دلیل محدودیت Cloudflare Workers، این برنامه برای دانلودهای بسیار بزرگ، اتصال‌های دائمی یا بارهای حجیم جایگزین پراکسی شبکهٔ اختصاصی نیست.
