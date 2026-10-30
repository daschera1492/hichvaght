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

// --------------------------------------------------------------------- tables

/**
 * کارت‌های گرافیک واقعیِ ویندوز. رانرهای گیت‌هاب GPU ندارند و WebGL آن‌ها
 * SwiftShader است — یکی از واضح‌ترین نشانه‌های «این ماشین واقعی نیست».
 * هر جفت vendor/renderer عیناً همان چیزی است که Chrome روی آن سخت‌افزار
 * برمی‌گرداند (شکل ANGLE/D3D11).
 */
const GPU_TABLE = [
  [
    'Google Inc. (Intel)',
    'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E9B) Direct3D11 vs_5_0 ps_5_0, D3D11)'
  ],
  [
    'Google Inc. (Intel)',
    'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)'
  ],
  [
    'Google Inc. (NVIDIA)',
    'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)'
  ],
  [
    'Google Inc. (NVIDIA)',
    'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'
  ],
  [
    'Google Inc. (AMD)',
    'ANGLE (AMD, AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)'
  ],
  [
    'Google Inc. (AMD)',
    'ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 vs_5_0 ps_5_0, D3D11)'
  ]
];

/** قالب‌های GREASE که Chrome در sec-ch-ua می‌فرستد (بسته به نسخه عوض می‌شود). */
const GREASE_BRANDS = [
  'Not_A Brand',
  'Not)A;Brand',
  'Not?A_Brand',
  'Not;A=Brand',
  'Not.A/Brand',
  'Not A(Brand'
];

/** Chrome روی Win10 = 10.0.0 و روی Win11 = 13/14/15.0.0 گزارش می‌کند. */
const PLATFORM_VERSIONS = ['10.0.0', '13.0.0', '14.0.0', '15.0.0'];
const CORES = [4, 6, 8, 12, 16];
const MEMORY = [4, 8, 16];

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
 * `actualMajor` از نسخهٔ واقعیِ Chrome خوانده می‌شود تا UA ادعای نسخه‌ای
 * خیلی دور از واقعیت نکند (۳ تا ۵ نسخه عقب‌تر = کاملاً عادی).
 */
function fingerprintFor(key, actualMajor) {
  const d = derive(key);
  const gpu = d.at(0, GPU_TABLE);

  // A browser that is a few versions behind is the most common real case.
  const major = Math.max(100, actualMajor - d.between(1, 0, 5));
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

  const hardwareConcurrency = d.at(8, CORES);
  const deviceMemory = d.at(9, MEMORY);
  const canvasSeed = d.u(10);
  const audioSeed = d.u(11);

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
      platformVersion: d.at(12, PLATFORM_VERSIONS),
      architecture: 'x86',
      model: '',
      mobile: false,
      bitness: '64',
      wow64: false
    },
    hardwareConcurrency,
    deviceMemory,
    webglVendor: gpu[0],
    webglRenderer: gpu[1],
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

  // ۲) اث اثرانگشت داخل هر سند، قبل از هر اسکریپت سایت.
  try {
    // eslint-disable-next-line global-require
    const installFp = require('./page-fp.cjs');
    await page.evaluateOnNewDocument(installFp, pageData(fp));
  } catch (e) {
    if (!depth) console.log(`[fp] in-page injection failed (${e.message}) — continuing`);
  }
  return page;
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
        const fp = fingerprintFor(key, actualMajor);
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
