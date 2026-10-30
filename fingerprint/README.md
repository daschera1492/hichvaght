# لایهٔ اثرانگشت (Fingerprint) — نسخهٔ ۲

این پوشه به `GmailDuck` **دست نمی‌زند**. فقط قبل از اجرای اسکریپت‌هایش با
`NODE_OPTIONS=--require …/preload.cjs` بار می‌شود و `puppeteer-core` را در جا
می‌پیچد؛ از آن لحظه هر مرورگری که GmailDuck بالا می‌آورد، اثرانگشت مخصوص خودش
را می‌گیرد.

```
fingerprint/
  preload.cjs     ← هوکِ Node: launch / newPage / newBrowserContext را می‌پیچد
  page-fp.cjs     ← اسکریپتی که داخل هر صفحه، قبل از هر اسکریپت سایت، اجرا می‌شود
  verify.cjs      ← تست: دو «کاربر» را بالا می‌آورد و ثابت می‌کند فرق دارند
```

## چطور وصل می‌شود

```powershell
$env:NODE_OPTIONS = "--require D:/a/hichvaght/hichvaght/fingerprint/preload.cjs"
$env:GSA_FP_SEED  = "1234567890-1-48392"   # یکتا برای هر اجرا
node scripts/run-batch.js
```

ورک‌فلوی `signup-G-v2.yml` همین کار را می‌کند (فقط روی قدم‌هایی که مرورگر
بالا می‌آورند، تا `npm ci` آلوده نشود).

## هر اجرا چقدر «متفاوت» است؟

اثرانگشت از دو چیز مشتق می‌شود: **seed اجرا** و **نام پوشهٔ پروفایل**:

| سطح | چه چیزی عوض می‌شود |
| --- | --- |
| هر اجرا (`run_id` + salt) | کل مجموعه: نسخهٔ Chrome، پلتفرم‌ورژن، GPU، هسته، حافظه، seed نویز canvas/صدا، ایمیج ویندوز (2025/2022)، IP خروجی، تأخیر بین ثبت‌نام‌ها |
| هر worker در یک اجرا | `gsa-profile-0 … 5` هر کدام یک «دستگاه» جدا |
| هر ثبت‌نام در یک worker | فقط هویت مرورگر (کوکی/storage) پاک می‌شود؛ دستگاه ثابت می‌ماند — که رفتار یک انسان است |

خروجی واقعی روی همین دستگاه (seed ثابت، ۳ اسلات):

| اسلات | Chrome | هسته | حافظه | GPU |
| --- | --- | --- | --- | --- |
| 0 | 154.0.7740.45 | 8 | 16 | RTX 3060 |
| 1 | 153.0.6862.92 | 12 | 8 | GTX 1660 SUPER |
| 2 | 156.0.6880.75 | 6 | 16 | RTX 3060 |

## چه چیزی تصادفی می‌شود؟

- `navigator.userAgent` + `sec-ch-ua` + `navigator.userAgentData` — **هم‌خوان**
  (نسخهٔ ادعاشده ۰ تا ۵ نسخه عقب‌تر از Chrome نصب‌شده، با GREASE brand تصادفی).
  اگر UA از Client Hints جدا شود، خودش یک بنر «ربات» است؛ `verify.cjs` این را
  چک می‌کند.
- `navigator.hardwareConcurrency` ∈ {4,6,8,12,16} و `deviceMemory` ∈ {4,8,16}.
- WebGL `UNMASKED_VENDOR/RENDERER` از شش ترکیب واقعی Intel/NVIDIA/AMD. رانرهای
  گیت‌هاب GPU ندارند و مقدار واقعی‌شان `SwiftShader` است — یعنی یک پرچم قرمز
  ثابت در هر اجرا.
- نویز canvas (‎±۳ روی RGB، روی یک **کپی**) و نویز `AudioBuffer.getChannelData`
  (‎2e-7). هش canvas/audio هر اجرا عوض می‌شود ولی بوم اصلی دست‌نخورده می‌ماند.
- `navigator.webdriver = false` و `Function.prototype.toString` برای توابع
  پچ‌شده `[native code]` برمی‌گرداند.
- WebRTC: `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` تا IP
  واقعی رانر از طریق کاندیدهای STUN لو نرود.

## چه چیزی تصادفی **نمی‌شود** و چرا

- **زبان و منطقهٔ زمانی.** `GmailDuck` این دو را عمداً روی کشور پروکسی قفل
  می‌کند و در `verifyBrowserGeo` سخت‌گیرانه چک می‌کند؛ تصادفی کردنشان یعنی
  `BAD_REQUEST` تضمینی.
- **رزولوشن و اندازهٔ پنجره.** موتور چیدمان GmailDuck (دکمهٔ Agree در
  `contentHeight` پنجره) به همین اعداد وابسته است.
- **پروفایل بین اجراها.** روی رانر گیت‌هاب `%TEMP%` بین jobها پاک می‌شود؛
  طراحیِ «یک دستگاه ثابت برای همیشه» این‌جا اصلاً قابل پیاده‌سازی نیست.

## اجرای تست

```powershell
cd GmailDuck              # چون puppeteer-core این‌جاست
$env:NODE_OPTIONS = "--require ../hichvaght/fingerprint/preload.cjs"
$env:GSA_FP_SEED  = "local-test"
node ../hichvaght/fingerprint/verify.cjs --slots 3
```

- `--slots N` تعداد اسلات‌ها (پیش‌فرض ۲)
- `--headed` پنجرهٔ واقعی (پیش‌فرض headless)
- `--json` خروجی ماشین‌خوان
- کد خروج: `0` = همه‌چیز متفاوت و هم‌خوان، `1` = اسلات‌های یکسان یا تناقض
  UA↔Client Hints، `2` = خطا (puppeteer/Chrome پیدا نشد).

خاموش کردن کامل لایه: `GSA_FP=0`.

## نکتهٔ صادقانه دربارهٔ ریسک

`src/automation.js` خودش توضیح می‌دهد که «هر ثبت‌نام یک دستگاه نو» همان الگویی
است که سیستم ریسک گوگل دنبالش است؛ به همین دلیل `fresh_profile` پیش‌فرض `0`
است (دستگاه ثابت در طول یک دسته). نسخهٔ ۲ همان پیش‌فرضِ درست را نگه می‌دارد و
«تفاوت» را به سطح **run** می‌برد، نه سطح **signup**. اگر واقعاً
`fresh_profile = 1` می‌خواهی، ورودی‌اش در ورک‌فلو هست — ولی انتظار نرخ موفقیت
کمتر داشته باش.
