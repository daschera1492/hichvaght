'use strict';

/**
 * preload.cjs — لایهٔ «اثرانگشت تصادفی» برای GmailDuck، بدون دست‌زدن به کد آن.
 *
 * چطور وصل می‌شود؟
 *   NODE_OPTIONS="--require <abs>/fingerprint/preload.cjs" node scripts/run-batch.js
 * یعنی قبل از هر ماژولی این فایل اجرا می‌شود و `puppeteer-core` را در جا
 * می‌پیچد: هر `launch()`، `browser.newPage()` و `browserContext.newPage()`
 * خودکار اثرانگشت مخصوص خودش را می‌گیرد.
 *
 * چرا این‌طوری و نه با پچ کردن GmailDuck؟
 *   چون GmailDuck یک مخزن جدا و خصوصی است؛ هر بار که آپدیت شود، پچِ دستی
 *   می‌شکند. این لایه فقط از API عمومیِ puppeteer استفاده می‌کند و با
 *   نسخه‌های ۲۰ تا ۲۵ سازگار است (CDP مستقیم، بدون API جدید).
 *
 * هر «دستگاه» از (seed اجرا) + (نام پوشهٔ پروفایل) مشتق می‌شود:
 *   gsa-profile-0 … gsa-profile-5  →  ۶ اثرانگشت متفاوت در یک اجرا
 *   اجرای بعدی، seed دیگری دارد    →  اثرانگشت‌های کاملاً متفاوت در اجرای بعد
 * پس در یک دسته، هر worker یک «کامپیوتر» ثابت است (که رفتار انسان است) ولی
 * از یک run به run بعدی هیچ‌چیز تکرار نمی‌شود.
 *
 * خطاها عمداً همه بلعیده می‌شوند: این لایه هرگز نباید ثبت‌نام را بشکند.
 */

const Module = require('module');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PATCHED = Symbol.for('gmailduck.fingerprint.patched');
const FP_KEY = Symbol.for('gmailduck.fingerprint.value');
const CTX_KEY = Symbol.for('gmailduck.fingerprint.context');

/** The seed: per workflow run (workflow sets GSA_FP_SEED), else per process. */
const SEED = String(
  process.env.GSA_FP_SEED || `local-${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
);

/** Master switch: GSA_FP=0 leaves the browser exactly as it is. */
const ENABLED = String(process.env.GSA_FP || '1').trim() !== '0';

const REPORT = process.env.GSA_FP_REPORT || '';

/**
 * «گرم‌کردن» مرورگر — پیش‌فرض روشن (GSA_WARMUP=0 خاموشش می‌کند).
 *
 * چرا: روی رانر گیت‌هاب، پروفایل Chrome لحظه‌ای ساخته می‌شود و یک ثانیه بعد
 * مرورگر مستقیم می‌رود روی `accounts.cloud.google.com/signup`. هیچ آدمی این
 * کار را نمی‌کند؛ هیچ کوکی گوگل، هیچ بازدید قبلی، هیچ نشانه‌ای از یک مرورگرِ
 * استفاده‌شده وجود ندارد. گوگل توکن reCAPTCHA را از همین جلسه می‌سازد و
 * امتیازش پایین می‌آید → `?error=BAD_REQUEST` در POST نهایی.
 *
 * پس قبل از اولین صفحهٔ گوگل، دو صفحهٔ بی‌ضرر (همان دامنه‌ای که پروکسی در آن
 * کشور است) باز می‌شود تا کوکی NID/CONSENT ساخته شود و جلسه «سابقه» پیدا کند.
 */
const WARMUP = String(process.env.GSA_WARMUP || '1').trim() !== '0';
const WARMUP_MS = Math.max(0, Math.min(120000, Number(process.env.GSA_WARMUP_MS || 30000) || 0));

const WARM = Symbol.for('gmailduck.fingerprint.warmed');
const NET = Symbol.for('gmailduck.fingerprint.net');
const NET_WARMED = Symbol.for('gmailduck.fingerprint.net-warmed');

// --------------------------------------------------------------------- tables

/**
 * کارت‌های گرافیک واقعیِ ویندوز. رانرهای گیت‌هاب GPU ندارند و WebGL آن‌ها
 * SwiftShader است — یکی از واضح‌ترین نشانه‌های «این ماشین واقعی نیست».
 * هر جفت vendor/renderer عیناً همان چیزی است که Chrome روی آن سخت‌افزار
 * برمی‌گرداند (شکل ANGLE/D3D11).
 *
 * `tier` و `arch` عمداً این‌جا هستند:
 *   • هسته/حافظه با کلاس کارت هم‌خوان می‌شود (RTX 3060 با ۴ هسته/۴ گیگ
 *     ترکیبی است که در دنیای واقعی وجود ندارد؛ UHD 630 با ۱۶ هسته هم همین‌طور).
 *   • WebGPU هم باید همان کارت را گزارش کند، وگرنه یک WebGL با کارت NVIDIA
 *     و یک `navigator.gpu` خالی روی هم یک تناقض قابل‌مشاهده‌اند.
 */
const GPU_TABLE = [
  {
    vendor: 'Google Inc. (Intel)',
    renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E9B) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    tier: 'integrated',
    arch: 'gen-9'
  },
  {
    vendor: 'Google Inc. (Intel)',
    renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    tier: 'integrated',
    arch: 'gen-12lp'
  },
  {
    vendor: 'Google Inc. (NVIDIA)',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)',
    tier: 'discrete-mid',
    arch: 'turing'
  },
  {
    vendor: 'Google Inc. (NVIDIA)',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    tier: 'discrete-high',
    arch: 'ampere'
  },
  {
    vendor: 'Google Inc. (AMD)',
    renderer: 'ANGLE (AMD, AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)',
    tier: 'discrete-mid',
    arch: 'gcn-4'
  },
  {
    vendor: 'Google Inc. (AMD)',
    renderer: 'ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    tier: 'integrated',
    arch: 'rdna-2'
  }
];

/** هسته/حافظهٔ محتمل برای هر کلاس کارت — نه یک عدد دلبخواه. */
const TIER_HW = {
  integrated: { cores: [4, 8], memory: [4, 8] },
  'discrete-mid': { cores: [6, 8, 12], memory: [8, 16] },
  'discrete-high': { cores: [8, 12, 16], memory: [8, 16] }
};

const WEBGPU_VENDOR = {
  'Google Inc. (Intel)': 'intel',
  'Google Inc. (NVIDIA)': 'nvidia',
  'Google Inc. (AMD)': 'amd'
};

/** قالب‌های GREASE که Chrome در sec-ch-ua می‌فرستد (بسته به نسخه عوض می‌شود). */
const GREASE_BRANDS = [
  'Not_A Brand',
  'Not)A;Brand',
  'Not?A_Brand',
  'Not;A=Brand',
  'Not.A/Brand',
  'Not A(Brand'
];

/**
 * Chrome نسخهٔ ویندوز را این‌طور گزارش می‌کند (Client Hints):
 *   Win10 (build < 22000) → 10.0.0   ·   Win11 21H2 → 13.0.0
 *   Win11 22H2 → 14.0.0              ·   Win11 23H2/24H2 → 15.0.0
 * پس مقدار درست از build خودِ ماشین خوانده می‌شود، نه با تاس انداختن.
 */
function platformVersionFor(release) {
  const build = Number(String(release || '10.0.0').split('.')[2] || 0) || 0;
  if (build >= 22631) return '15.0.0';
  if (build >= 22621) return '14.0.0';
  if (build >= 22000) return '13.0.0';
  return '10.0.0';
}

// ----------------------------------------------------------------- derivation

function derive(key) {
  const buf = crypto.createHmac('sha256', SEED).update(String(key)).digest('hex');
  const u = (i) => parseInt(buf.slice((i * 8) % 56, ((i * 8) % 56) + 8), 16) >>> 0;
  return {
    u,
    at: (i, arr) => arr[u(i) % arr.length],
    between: (i, lo, hi) => lo + (u(i) % (hi - lo + 1))
  };
}

function rotate3(list, n) {
  const out = list.slice();
  for (let i = 0; i < n % 3; i++) out.push(out.shift());
  return out;
}

/**
 * اثرانگشت یک «دستگاه» = تابعی از (seed اجرا, نام پوشهٔ پروفایل).
 *
 * چیزهایی که عمداً از ماشین واقعی خوانده می‌شوند (نه تصادفی):
 *   • نسخهٔ اصلی Chrome — ادعای ۵ نسخه عقب‌تر از موتور واقعی، خودش یک
 *     تناقضِ قابل‌کشف است (موتور ۱۵۶ چیزی را دارد که ۱۵۱ ندارد).
 *   • platformVersion — از build ویندوز.
 *   • هسته/حافظه — هم‌خوان با کلاس کارت گرافیک.
 * «متفاوت بودن» از canvas/audio/GPU/هسته/حافظه و seed اجرا می‌آید، نه از
 * دروغ گفتن دربارهٔ چیزی که خود مرورگر لو می‌دهد.
 */
function fingerprintFor(key, actualMajor, osInfo) {
  const d = derive(key);
  const gpu = d.at(0, GPU_TABLE);
  const hw = TIER_HW[gpu.tier] || TIER_HW.integrated;

  // ۰ یا ۱ نسخه عقب‌تر: چیزی که در دنیای واقعی هر روز دیده می‌شود، و
  // چیزی که موتورِ واقعی هم نمی‌تواند تکذیبش کند.
  const major = Math.max(100, actualMajor - d.between(1, 0, 1));
  const full = `${major}.0.${d.between(2, 6200, 7800)}.${d.between(3, 0, 240)}`;
  const grease = d.at(4, GREASE_BRANDS);
  const greaseVersion = d.at(5, ['8', '24', '99']);

  const brands = rotate3(
    [
      { brand: 'Chromium', version: String(major) },
      { brand: 'Google Chrome', version: String(major) },
      { brand: grease, version: greaseVersion }
    ],
    d.between(6, 0, 2)
  );

  const fullVersionList = rotate3(
    [
      { brand: 'Chromium', version: full },
      { brand: 'Google Chrome', version: full },
      { brand: grease, version: `${greaseVersion}.0.0.0` }
    ],
    d.between(7, 0, 2)
  );

  const hardwareConcurrency = d.at(8, hw.cores);
  const deviceMemory = d.at(9, hw.memory);
  const canvasSeed = d.u(10);
  const audioSeed = d.u(11);
  const platformVersion =
    osInfo && osInfo.platformVersion
      ? osInfo.platformVersion
      : platformVersionFor(osInfo && osInfo.release);

  return {
    key,
    seed: crypto.createHmac('sha256', SEED).update(String(key)).digest('hex').slice(0, 12),
    chrome: { actual: actualMajor, claimed: major, full },
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Safari/537.36`,
    platform: 'Win32',
    metadata: {
      brands,
      fullVersionList,
      fullVersion: full,
      platform: 'Windows',
      platformVersion,
      architecture: 'x86',
      model: '',
      mobile: false,
      bitness: '64',
      wow64: false
    },
    hardwareConcurrency,
    deviceMemory,
    webglVendor: gpu.vendor,
    webglRenderer: gpu.renderer,
    webgpuVendor: WEBGPU_VENDOR[gpu.vendor] || 'intel',
    webgpuArch: gpu.arch,
    canvasSeed,
    audioSeed
  };
}

/** فقط چیزهایی که باید داخل صفحه تزریق شوند (همه سریال‌پذیر). */
function pageData(fp) {
  return {
    hardwareConcurrency: fp.hardwareConcurrency,
    deviceMemory: fp.deviceMemory,
    webglVendor: fp.webglVendor,
    webglRenderer: fp.webglRenderer,
    webgpuVendor: fp.webgpuVendor,
    webgpuArch: fp.webgpuArch,
    canvasSeed: fp.canvasSeed,
    audioSeed: fp.audioSeed
  };
}

// -------------------------------------------------------------------- reporting

function report(fp) {
  const line = {
    at: new Date().toISOString(),
    run: process.env.GSA_FP_SEED || '',
    slot: fp.key,
    seed: fp.seed,
    actualChrome: fp.chrome.actual,
    claimedChrome: fp.chrome.full,
    ua: fp.userAgent,
    platformVersion: fp.metadata.platformVersion,
    hardwareConcurrency: fp.hardwareConcurrency,
    deviceMemory: fp.deviceMemory,
    webgl: fp.webglRenderer,
    canvasSeed: fp.canvasSeed,
    audioSeed: fp.audioSeed
  };
  try {
    console.log(
      `[fp] slot=${fp.key} chrome=${fp.chrome.full} (installed ${fp.chrome.actual}) ` +
        `hw=${fp.hardwareConcurrency} mem=${fp.deviceMemory} gpu=${fp.webglVendor}`
    );
  } catch (e) {}
  if (!REPORT) return;
  try {
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    fs.appendFileSync(REPORT, JSON.stringify(line) + '\n', 'utf8');
  } catch (e) {
    /* گزارش نباید اجرا را بشکند */
  }
}

// ------------------------------------------------------------------ injection

async function injectPage(page, fp, depth) {
  if (!page || page[FP_KEY]) return page;
  try {
    Object.defineProperty(page, FP_KEY, { value: fp, configurable: true });
  } catch (e) {}

  // ۱) UA + Client Hints + navigator.platform — با CDP، چون هم‌زمان
  //    سرصفحه‌های sec-ch-ua را هم می‌سازد (تناقض UA و Client Hints = لو رفتن).
  try {
    const cdp = await page.createCDPSession();
    await cdp.send('Emulation.setUserAgentOverride', {
      userAgent: fp.userAgent,
      platform: fp.platform,
      userAgentMetadata: fp.metadata
    });
  } catch (e) {
    if (!depth) console.log(`[fp] UA override failed (${e.message}) — continuing`);
  }

  // ۲) اثرانگشت داخل هر سند، قبل از هر اسکریپت سایت.
  try {
    // eslint-disable-next-line global-require
    const installFp = require('./page-fp.cjs');
    await page.evaluateOnNewDocument(installFp, pageData(fp));
  } catch (e) {
    if (!depth) console.log(`[fp] in-page injection failed (${e.message}) — continuing`);
  }

  // ۳) هوک‌های رفتاری/تشخیصی (گرم‌کردن + رصد درخواست نهایی گوگل).
  installPageHooks(page);
  return page;
}

// ------------------------------------------------------------------- warm-up

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** دامنهٔ گوگلِ همان کشوری که پروکسی در آن است. */
const GOOGLE_TLD = {
  fr: 'fr',
  de: 'de',
  gb: 'co.uk',
  uk: 'co.uk',
  us: 'com',
  ca: 'ca',
  nl: 'nl',
  es: 'es',
  it: 'it',
  se: 'se',
  pl: 'pl',
  tr: 'com.tr',
  ae: 'ae',
  au: 'com.au',
  jp: 'co.jp',
  kr: 'co.kr',
  in: 'co.in',
  br: 'com.br',
  mx: 'com.mx'
};

function googleTld() {
  const c = String(process.env.GSA_PROXY_COUNTRY || '').trim().toLowerCase();
  return GOOGLE_TLD[c] || 'com';
}

/** دکمهٔ «همه را قبول کن» صفحهٔ رضایت گوگل، به زبان‌های ممکن. */
const CONSENT_BUTTON =
  'tout accepter|j\u2019accepte|accept all|alle akzeptieren|accetta tutto|aceptar todo|aceitar tudo|alles accepteren|godta alle|acceptera alla';

/** چند جستجوی بی‌آزار و متداول. */
const WARM_QUERIES = [
  'meteo',
  'actualites',
  'recette crepe',
  'horaires train',
  'traduction anglais',
  'boulangerie pres de moi'
];

/**
 * یک کلیک با ماوس واقعی روی عنصری که متنش با الگو می‌خواند.
 * (کلیک مصنوعی روی صفحهٔ رضایت گوگل هم می‌تواند مشکل بسازد؛ ماوس ارزان است.)
 */
async function clickByText(page, pattern) {
  let box = null;
  try {
    box = await page.evaluate((src) => {
      const rx = new RegExp('^(?:' + src + ')$', 'i');
      const nodes = Array.prototype.slice.call(
        document.querySelectorAll('button, div[role="button"], a[role="button"], span[role="button"]')
      );
      for (let i = 0; i < nodes.length; i++) {
        const t = (nodes[i].innerText || nodes[i].textContent || '').trim();
        if (!rx.test(t)) continue;
        const r = nodes[i].getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      return null;
    }, pattern);
  } catch (e) {
    return false;
  }
  if (!box) return false;
  try {
    await page.mouse.click(box.x, box.y);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * پیش‌درآمد انسانی: یک بازدید کوتاه از گوگلِ همان کشور، قبول صفحهٔ رضایت،
 * یک جستجوی معمولی، کمی حرکت ماوس و اسکرول. بعد از آن، همان صفحه به
 * `accounts.cloud.google.com/signup/...` می‌رود.
 *
 * کل بودجه با GSA_WARMUP_MS محدود است (پیش‌فرض ۲۰ ثانیه) و مهلتِ خودِ
 * GmailDuck روی این goto ۶۰ ثانیه است، پس هرگز باعث تایم‌اوت نمی‌شود.
 */
async function warmUp(page) {
  const t0 = Date.now();
  const deadline = t0 + WARMUP_MS;
  const tld = googleTld();
  const left = () => deadline - Date.now();

  // هر ناوبری سقف سخت دارد؛ و اگر اولی خطا داد، کل گرم‌کردن همان‌جا تمام
  // می‌شود. (در اجرای US، پروکسی تونل www.gstatic.com را ۵۰۲ داد و این
  // مرحله ۷۲ ثانیه از وقت را خورد — نباید تکرار شود.)
  const go = async (url) => {
    const budget = left();
    if (budget < 2500) return { ok: false, reason: 'budget' };
    try {
      const res = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: Math.min(15000, budget)
      });
      if (!res) return { ok: false, reason: 'no-response' };
      return { ok: true, status: res.status() };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  };

  try {
    // ۱) دامنهٔ کشوریِ همان IP (فرانسه → google.fr) — برای هم‌خوانی زبان/منطقه.
    const first = await go(`https://www.google.${tld}/`);
    if (!first.ok) {
      console.log(`[warm] aborted after ${((Date.now() - t0) / 1000).toFixed(1)}s (${first.reason})`);
      return;
    }
    await sleep(900 + Math.random() * 1400);
    const accepted = await clickByText(page, CONSENT_BUTTON);
    await sleep(700 + Math.random() * 1200);

    // ۲) خودِ google.com — چون کوکی NID را روی `.google.com` می‌گذارد و
    //    `accounts.cloud.google.com` فقط همین را می‌بیند. بدون این، «گرم‌کردن»
    //    عملاً هیچ کوکی‌ای به صفحهٔ ثبت‌نام نمی‌رساند.
    if (tld !== 'com' && left() > 6000) {
      const second = await go('https://www.google.com/');
      if (second.ok) {
        await sleep(800 + Math.random() * 1000);
        await clickByText(page, CONSENT_BUTTON);
        await sleep(500 + Math.random() * 800);
      }
    }

    if (left() > 4000) {
      const q = WARM_QUERIES[Math.floor(Math.random() * WARM_QUERIES.length)];
      const third = await go(`https://www.google.${tld}/search?q=${encodeURIComponent(q)}`);
      if (third.ok) {
        await sleep(900 + Math.random() * 1200);
        // کمی حرکت ماوس و اسکرول، مثل کسی که نتایج را نگاه می‌کند.
        try {
          const size = await page.evaluate(() => ({
            w: window.innerWidth || 1000,
            h: window.innerHeight || 700
          }));
          for (let i = 0; i < 3; i++) {
            await page.mouse.move(
              size.w * (0.25 + Math.random() * 0.5),
              size.h * (0.2 + Math.random() * 0.5),
              { steps: 6 + Math.floor(Math.random() * 8) }
            );
            await sleep(150 + Math.random() * 250);
          }
          await page.mouse.wheel({ deltaY: 180 + Math.floor(Math.random() * 260) });
          await sleep(250 + Math.random() * 400);
        } catch (e) {
          /* حرکت ماوس اختیاری است */
        }
      }
    }

    console.log(
      `[warm] ${page.url().replace(/^https?:\/\//, '').split('/')[0]} — ` +
        `${((Date.now() - t0) / 1000).toFixed(1)}s · consent=${accepted ? 'clicked' : 'n/a'}`
    );
  } catch (e) {
    console.log(`[warm] skipped after ${((Date.now() - t0) / 1000).toFixed(1)}s (${e.message})`);
  }
}

/**
 * رصد درخواست نهاییِ گوگل. اگر `bgResponse` (توکن reCAPTCHA) خالی/کوتاه بود،
 * مشکل «امتیاز ریسک» نیست — توکن اصلاً ساخته نشده، و آن یک باگ جداگانه است.
 * این خط‌ها فقط لاگ می‌کنند و هیچ‌چیز را عوض نمی‌کنند.
 */
function installNetworkWatch(page) {
  if (!page || page[NET]) return;
  try {
    Object.defineProperty(page, NET, { value: true, configurable: true });
  } catch (e) {}
  try {
    page.on('request', (req) => {
      try {
        const url = req.url();
        if (!/accounts\.cloud\.google\.com\/signup\/create-account/.test(url)) return;
        const body = req.postData() || '';
        const field = (name) => {
          const m = new RegExp('(?:^|&)' + name + '=([^&]*)').exec(body);
          return m ? decodeURIComponent(m[1]) : '';
        };
        const tos = field('tosIdList');
        const bg = field('bgResponse');
        const at = field('at');
        console.log(
          `[net] POST create-account · region=${field('region') || '?'} · tos=${tos ? 'yes' : 'MISSING'} · ` +
            `at=${at.length}B · bgResponse=${bg.length}B · body=${body.length}B`
        );
        if (!bg) console.log('[net] ⚠️ bgResponse خالی است — توکن reCAPTCHA ساخته نشده.');
      } catch (e) {}
    });
  } catch (e) {}
  try {
    page.on('response', (res) => {
      try {
        const url = res.url();
        if (!/accounts\.cloud\.google\.com\/signup\//.test(url)) return;
        const headers = res.headers() || {};
        const loc = headers.location ? ` → ${headers.location}` : '';
        console.log(`[net] ${res.status()} ${res.request().method()} ${url.replace(/^https?:\/\//, '')}${loc}`);
      } catch (e) {}
    });
  } catch (e) {}
}

/**
 * هوک‌های هر صفحه: رصد شبکه، و یک پیش‌درآمد انسانی قبل از اولین صفحهٔ
 * ثبت‌نام گوگل (فقط یک بار برای هر صفحه).
 */
function installPageHooks(page) {
  installNetworkWatch(page);
  if (!WARMUP || !page || page[WARM]) return;
  try {
    Object.defineProperty(page, WARM, { value: true, configurable: true });
  } catch (e) {
    return;
  }
  let orig;
  try {
    orig = page.goto.bind(page);
  } catch (e) {
    return;
  }
  page.goto = async function (url, options) {
    const target = String(url || '');
    if (!page[NET_WARMED] && /^https:\/\/accounts\.cloud\.google\.com\/signup\//.test(target)) {
      try {
        Object.defineProperty(page, NET_WARMED, { value: true, configurable: true });
      } catch (e) {}
      try {
        await warmUp(page);
      } catch (e) {
        console.log(`[warm] failed (${e.message}) — continuing`);
      }
    }
    return orig(url, options);
  };
}

function instrumentBrowser(browser, fp) {
  const wrap = (page, quiet) =>
    page && !page[FP_KEY] ? injectPage(page, fp, quiet ? 1 : 0) : Promise.resolve(page);

  try {
    const origNewPage = browser.newPage;
    if (typeof origNewPage === 'function') {
      browser.newPage = async function () {
        return wrap(await origNewPage.apply(browser, arguments));
      };
    }
  } catch (e) {}

  for (const name of ['createBrowserContext', 'createIncognitoBrowserContext']) {
    try {
      const orig = browser[name];
      if (typeof orig !== 'function') continue;
      browser[name] = async function () {
        const ctx = await orig.apply(browser, arguments);
        if (ctx && !ctx[CTX_KEY]) {
          try {
            Object.defineProperty(ctx, CTX_KEY, { value: true });
          } catch (e) {}
          const origCtxNewPage = ctx.newPage;
          if (typeof origCtxNewPage === 'function') {
            ctx.newPage = async function () {
              return wrap(await origCtxNewPage.apply(ctx, arguments));
            };
          }
        }
        return ctx;
      };
    } catch (e) {}
  }

  // صفحاتی که پیش از پیچیدن براوزر ساخته شده‌اند (about:blank اولیه) — بی‌صدا،
  // چون ممکن است همان لحظه بسته شوند و خطایشان معنایی ندارد.
  Promise.resolve()
    .then(() => browser.pages())
    .then((pages) => Promise.all((pages || []).map((p) => wrap(p, 1))))
    .catch(() => {});
}

// --------------------------------------------------------------------- puppeteer

/**
 * خروجیِ puppeteer-core در نسخه‌های جدید یک «module namespace» واقعی است:
 * non-extensible و با bindingهای فقط‌خواندنی. پس نمی‌شود `launch` را روی خودش
 * عوض کرد؛ به‌جایش یک facade از همان شیء می‌سازیم که فقط `launch` عوض شده
 * باشد. هر require بعدی همان facade را می‌گیرد.
 */
const facades = new WeakMap();

function patchPuppeteer(ns) {
  if (!ns || (typeof ns !== 'object' && typeof ns !== 'function')) return ns;
  if (facades.has(ns)) return facades.get(ns);
  if (typeof ns.launch !== 'function') return ns; // ماژول داخلی، نه پکیج اصلی

  const facade = {};
  for (const key of Reflect.ownKeys(ns)) {
    try {
      facade[key] = ns[key];
    } catch (e) {
      /* یک binding خوانده‌نشده */
    }
  }

  let anonymous = 0;
  facade.launch = async function (options) {
    const opts = Object.assign({}, options || {});
    const args = Array.isArray(opts.args) ? opts.args.slice() : [];

    // WebRTC: هیچ کاندید UDP غیرپروکسی بیرون نرود (لو دادن IP واقعی رانر).
    if (!args.some((a) => /webrtc-ip-handling-policy/i.test(String(a)))) {
      args.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
    }
    opts.args = args;

    const browser = await ns.launch(opts);

    if (ENABLED) {
      const key = opts.userDataDir
        ? path.basename(String(opts.userDataDir))
        : `anonymous-${++anonymous}`;
      try {
        const raw = String((await browser.version()) || '');
        const m = /Chrome\/(\d+)\./.exec(raw);
        const actualMajor = m ? Number(m[1]) : 140;
        // نسخهٔ ویندوز هم از خودِ ماشین خوانده می‌شود، نه با تاس انداختن.
        const fp = fingerprintFor(key, actualMajor, {
          release: os.release(),
          platformVersion: platformVersionFor(os.release())
        });
        try {
          Object.defineProperty(browser, FP_KEY, { value: fp, configurable: true });
        } catch (e) {}
        instrumentBrowser(browser, fp);
        report(fp);
      } catch (e) {
        console.log(`[fp] could not derive a fingerprint for ${key}: ${e.message}`);
      }
    }
    return browser;
  };

  try {
    Object.defineProperty(facade, PATCHED, { value: true });
  } catch (e) {}

  facades.set(ns, facade);
  return facade;
}

// ------------------------------------------------------------------ require hook

// هر مسیری که به خودِ پکیج puppeteer-core اشاره کند (چه با نام، چه با مسیر
// مطلق) پیچیده می‌شود؛ patchPuppeteer خودش تشخیص می‌دهد که `launch` دارد یا نه.
const looksLikePuppeteer = (request) =>
  typeof request === 'string' && /(^|[\\/])puppeteer-core([\\/]|$)/.test(request);

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const exported = origLoad.apply(this, arguments);
  try {
    if (looksLikePuppeteer(request)) return patchPuppeteer(exported);
  } catch (e) {
    /* هرگز جلوی لود شدن ماژول را نگیر */
  }
  return exported;
};

module.exports = { SEED, ENABLED, fingerprintFor, patchPuppeteer };
