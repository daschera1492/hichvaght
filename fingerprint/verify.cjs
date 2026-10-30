'use strict';

/**
 * verify.cjs — اثبات اینکه لایهٔ اثرانگشت واقعاً کار می‌کند.
 *
 *   NODE_OPTIONS="--require <abs>/fingerprint/preload.cjs" \
 *   node fingerprint/verify.cjs --slots 2
 *
 * چند «کاربر» با چند پروفایل (مثل چند worker در همان run) باز می‌کند و هر چه
 * صفحه واقعاً می‌بیند را چاپ می‌کند: UA، Client Hints (سرصفحهٔ sec-ch-ua از
 * یک سرور محلی)، هسته/حافظه، WebGL، هش canvas.
 *
 * صفحه از http://127.0.0.1 سرو می‌شود چون فقط context امن است که
 * `navigator.userAgentData` را در دسترس می‌گذارد؛ همان‌جا هم هدرهای واقعی
 * درخواست را برمی‌گردانیم تا معلوم شود UA و Client Hints با هم می‌خوانند
 * (تناقض این دو، خودش یک اثرانگشتِ «ربات» است).
 *
 * اگر اسلات‌ها اثرانگشت یکسان داشتند یا sec-ch-ua با UA هم‌خوان نبود، با
 * کد ۱ خارج می‌شود — پس ورک‌فلو قبل از claim کردن حتی یک ایمیل، شکست را
 * می‌بیند. خروجی ماشین‌خوان: --json
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// ------------------------------------------------------------ puppeteer lookup

function resolvePuppeteer() {
  const bases = [
    process.cwd(),
    process.env.GSA_APP_DIR || '',
    path.join(__dirname, '..'),
    path.join(__dirname, '..', '..', 'GmailDuck')
  ].filter(Boolean);
  for (const base of bases) {
    try {
      return require.resolve('puppeteer-core', { paths: [base] });
    } catch (e) {
      /* next */
    }
  }
  throw new Error('puppeteer-core پیدا نشد — اول npm ci را در پوشهٔ GmailDuck اجرا کن.');
}

function detectChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(
      process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)',
      'Google\\Chrome\\Application\\chrome.exe'
    ),
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (e) {}
  }
  throw new Error('chrome.exe پیدا نشد — CHROME_PATH را تنظیم کن.');
}

// ------------------------------------------------------------ local echo server

function startEcho() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(req.headers, null, 2));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ------------------------------------------------------------- in-page probe

/** Runs in the page. Must be self-contained. */
function probe() {
  const fnv = (str) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  };

  let canvas = 'error';
  try {
    const c = document.createElement('canvas');
    c.width = 260;
    c.height = 60;
    const ctx = c.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = '16px "Arial"';
    ctx.fillStyle = '#f60';
    ctx.fillRect(10, 10, 120, 30);
    ctx.fillStyle = '#069';
    ctx.fillText('GmailDuck fingerprint', 12, 12);
    ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
    ctx.fillText('GmailDuck fingerprint', 14, 14);
    canvas = fnv(c.toDataURL());
  } catch (e) {}

  let webgl = { vendor: '', renderer: '' };
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    if (gl && ext) {
      webgl = {
        vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL),
        renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
      };
    }
  } catch (e) {}

  return {
    ua: navigator.userAgent,
    uaData:
      navigator.userAgentData && navigator.userAgentData.getHighEntropyValues
        ? navigator.userAgentData.getHighEntropyValues([
            'platformVersion',
            'fullVersionList',
            'architecture',
            'bitness'
          ])
        : null,
    platform: navigator.platform,
    webdriver: navigator.webdriver,
    language: navigator.language,
    languages: (navigator.languages || []).join(','),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory || null,
    screen: `${screen.width}x${screen.height}@${window.devicePixelRatio}`,
    outer: `${window.outerWidth}x${window.outerHeight}`,
    inner: `${window.innerWidth}x${window.innerHeight}`,
    webgl,
    canvas
  };
}

// ------------------------------------------------------------------- helpers

function parseArgs(argv) {
  const out = { slots: 2, json: false, headless: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--headed') out.headless = false;
    else if (a === '--slots') out.slots = Math.max(1, Math.min(10, Number(argv[++i]) || 2));
  }
  return out;
}

function chromeMajor(ua) {
  const m = /(?:Headless)?Chrome\/(\d+)\./.exec(String(ua || ''));
  return m ? m[1] : '';
}

/** sec-ch-ua: `"Chromium";v="154", "Google Chrome";v="154", "Not_A Brand";v="99"` */
function chMajor(secChUa) {
  const m = /"Google Chrome";v="(\d+)"/.exec(String(secChUa || ''));
  return m ? m[1] : '';
}

async function measure(puppeteer, chromePath, slot, headless, port) {
  const dir = path.join(os.tmpdir(), `gsa-profile-${slot}`);
  fs.mkdirSync(dir, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless,
    userDataDir: dir,
    defaultViewport: { width: 1280, height: 800 },
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--lang=en-US'
    ]
  });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
    const headers = JSON.parse((await page.evaluate(() => document.body.innerText)) || '{}');
    const data = await page.evaluate(probe);
    if (data.uaData && typeof data.uaData.then === 'function') data.uaData = await data.uaData;
    const fp = browser[Symbol.for('gmailduck.fingerprint.value')] || null;
    return {
      slot: `gsa-profile-${slot}`,
      headers: {
        'sec-ch-ua': headers['sec-ch-ua'] || '',
        'sec-ch-ua-platform': headers['sec-ch-ua-platform'] || '',
        'accept-language': headers['accept-language'] || '',
        'user-agent': headers['user-agent'] || ''
      },
      data,
      planned: fp
    };
  } finally {
    await browser.close().catch(() => {});
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (e) {}
  }
}

// ---------------------------------------------------------------------- main

(async function main() {
  const args = parseArgs(process.argv.slice(2));
  const puppeteer = require(resolvePuppeteer());
  const chromePath = detectChrome();
  const { server, port } = await startEcho();

  const results = [];
  try {
    for (let i = 0; i < args.slots; i++) {
      results.push(await measure(puppeteer, chromePath, i, args.headless, port));
    }
  } finally {
    server.close();
  }

  const uas = new Set(results.map((r) => r.data.ua));
  const canvases = new Set(results.map((r) => r.data.canvas));
  const gpus = new Set(results.map((r) => r.data.webgl.renderer));
  const cores = new Set(results.map((r) => r.data.hardwareConcurrency));
  const distinct = uas.size === results.length && canvases.size === results.length;
  // UA و Client Hints باید یک نسخه را بگویند، وگرنه تناقض خودش لو می‌دهد.
  const hintsMatch = results.every(
    (r) => !r.headers['sec-ch-ua'] || chMajor(r.headers['sec-ch-ua']) === chromeMajor(r.data.ua)
  );

  if (!args.json) {
    console.log(`\nchrome: ${chromePath}`);
    console.log(`seed: ${process.env.GSA_FP_SEED || '(random per process)'}\n`);
    for (const r of results) {
      const d = r.data;
      console.log(`── ${r.slot} ─────────────────────────────────────────`);
      console.log(`  UA            ${d.ua}`);
      console.log(`  sec-ch-ua     ${r.headers['sec-ch-ua'] || '(none)'}  ${hintsMatch ? '' : '⚠️'}`);
      console.log(`  ch-platform   ${r.headers['sec-ch-ua-platform'] || '-'} | platform=${d.platform}`);
      console.log(`  accept-lang   ${r.headers['accept-language'] || '-'}`);
      console.log(`  webdriver     ${d.webdriver}`);
      console.log(`  lang / tz     ${d.languages} / ${d.timezone}`);
      console.log(`  cores / mem   ${d.hardwareConcurrency} / ${d.deviceMemory}`);
      console.log(`  screen        ${d.screen} (outer ${d.outer}, inner ${d.inner})`);
      console.log(`  WebGL         ${d.webgl.vendor} | ${d.webgl.renderer}`);
      console.log(`  canvas hash   ${d.canvas}`);
      console.log('');
    }
    console.log(
      `${distinct && hintsMatch ? '✅' : '❌'} ` +
        `UA=${uas.size}/${results.length} · canvas=${canvases.size}/${results.length} · ` +
        `GPU=${gpus.size} · cores=${cores.size} · UA↔CH=${hintsMatch ? 'هم‌خوان' : 'تناقض'}`
    );
  }

  if (args.json) {
    console.log(JSON.stringify({ chrome: chromePath, distinct, hintsMatch, results }));
  }

  process.exit(distinct && hintsMatch ? 0 : 1);
})().catch((e) => {
  console.error(`❌ تست اثرانگشت شکست خورد: ${e && e.message ? e.message : e}`);
  process.exit(2);
});
