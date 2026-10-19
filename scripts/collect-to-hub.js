#!/usr/bin/env node
// Duck collector → DuckMail Hub (headless, GitHub-Actions friendly).
//
// Round-robins a pool of DuckDuckGo account tokens: ONE address request per
// token per round, with a configurable rest in between. Every fresh address
// is registered into the WordPress DuckMail Hub (POST /pool/emails) and
// appended to the used-addresses state file.
//
// The "duplicate" that retires a token is a DuckDuckGo-side signal:
// when an account exhausts its daily quota, DDG starts re-emitting an
// address that was already generated before (possibly in an earlier run —
// hence the persistent used-addresses file). That request is NOT sent to
// the hub; the token is retired and the round-robin moves on to the rest.
//
// Token state machine (per DuckDuckGo account):
//   401/403                      → invalid token      → retired
//   201 + fresh address          → pushed to the hub  → stays in the pool
//   201 + already-known address  → DDG quota reached  → retired (تکراری)
//   429                          → rate limited       → cooldown, comes back later
//   network / 5xx / hub error    → transient          → stays in the pool
//
// Required env:
//   HUB_URL              base of the WP site (or the full …/wp-json/duckmail/v1)
//   HUB_KEY              DuckMail Hub API key (dhk_…) with pool permission
//   DUCK_TOKENS          DDG token pool — newline / comma / semicolon separated
//
// Optional env:
//   INTERVAL_SECONDS     rest between each duck address request   (default 45)
//   MAX_ADDRESSES        stop after N successful addresses        (default 0 = unlimited)
//   COOLDOWN_SECONDS     park time after a 429 without Retry-After (default 600)
//   MAX_RUNTIME_MINUTES  graceful stop before the CI job timeout  (default 320)
//   USED_FILE            persistent known-addresses file          (default ./used-addresses.txt)
//   DDG_BASE_URL         DuckDuckGo API root                      (default https://quack.duckduckgo.com)
//   DD_DOMAIN            domain appended to bare local-parts      (default duck.com)
//
// No external dependencies.

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const DDG_PATH = '/api/email/addresses';
const ADDRESS_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const LOCAL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{1,62}[A-Za-z0-9])?$/;
const KNOWN_KEYS = ['address', 'duck_address', 'email', 'private_address', 'forwarder', 'local_part', 'mailbox'];

// ---------------------------------------------------------------- helpers

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(obj) {
  const line = typeof obj === 'string' ? obj
    : Object.entries(obj).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
  process.stdout.write(`[${new Date().toISOString()}] ${line}\n`);
}

function rawRequest(urlString, { method = 'GET', headers = {}, body = null, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const client = url.protocol === 'http:' ? http : https;
    const payload = body === null || body === undefined
      ? null
      : (typeof body === 'string' ? body : JSON.stringify(body));
    const finalHeaders = { ...headers };
    if (payload !== null) finalHeaders['Content-Length'] = Buffer.byteLength(payload);

    const req = client.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: url.pathname + url.search,
      method,
      headers: finalHeaders,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (e) { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers || {}, body: text, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error(`timeout after ${timeout}ms`)));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** Extract an email out of whatever DDG returned. */
function extractAddress(json, raw, domain) {
  const full = (v) => {
    if (v.includes('@')) return ADDRESS_RE.test(v) ? v : null;
    return LOCAL_RE.test(v) ? `${v}@${domain}` : null;
  };
  if (typeof json === 'string') return full(json.trim());
  if (json && typeof json === 'object') {
    for (const key of KNOWN_KEYS) {
      const v = typeof json[key] === 'string' ? json[key].trim() : '';
      if (v && full(v)) return full(v);
    }
  }
  const m = raw && ADDRESS_RE.exec(String(raw));
  return m ? m[0] : null;
}

function normalizeHubUrl(v) {
  let base = String(v || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('HUB_URL خالی است (Variable یا Secret با نام HUB_URL بسازید)');
  if (!/^https?:\/\//i.test(base)) throw new Error(`HUB_URL باید با http:// یا https:// شروع شود: "${base}"`);
  if (!base.includes('/wp-json')) base += '/wp-json/duckmail/v1';
  return base;
}

function parseTokens(raw) {
  return String(raw || '')
    .split(/[\r\n,;]+/)
    .map((t) => t.trim().replace(/^Bearer\s+/i, ''))
    .filter(Boolean)
    .filter((t, i, a) => a.indexOf(t) === i);
}

function envInt(name, def, min) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n >= min ? n : def;
}

/** Every address mentioned in a text file, lower-cased and unique. */
function knownAddressesFromText(raw) {
  const seen = new Set();
  for (const rawLine of String(raw || '').split(/\r?\n/)) {
    for (const token of rawLine.trim().split(/[\s,;]+/)) {
      const m = token && ADDRESS_RE.exec(token);
      if (m) seen.add(m[0].trim().toLowerCase());
    }
  }
  return seen;
}

// ---------------------------------------------------------------- config

const problems = [];

let HUB_URL = '';
try { HUB_URL = normalizeHubUrl(process.env.HUB_URL); } catch (e) { problems.push(e.message); }

const HUB_KEY = String(process.env.HUB_KEY || '').trim();
if (!HUB_KEY) problems.push('HUB_KEY خالی است (Variable یا Secret با نام HUB_API_KEY بسازید)');

const TOKENS = parseTokens(process.env.DUCK_TOKENS);
if (!TOKENS.length) problems.push('DUCK_TOKENS خالی است (Secret با نام DDG_TOKENS بسازید یا هنگام اجرا وارد کنید)');

if (problems.length) {
  for (const p of problems) process.stdout.write(`::error::${p}\n`);
  process.stderr.write(`FATAL: ${problems.join(' | ')}\n`);
  process.exit(1);
}

const DDG_BASE = (process.env.DDG_BASE_URL || 'https://quack.duckduckgo.com').replace(/\/+$/, '');
const DOMAIN = process.env.DD_DOMAIN || 'duck.com';
const INTERVAL = envInt('INTERVAL_SECONDS', 45, 1);
const MAX_ADDRESSES = envInt('MAX_ADDRESSES', 0, 0);
const COOLDOWN_MS = envInt('COOLDOWN_SECONDS', 600, 1) * 1000;
const MAX_RUNTIME_MS = envInt('MAX_RUNTIME_MINUTES', 320, 1) * 60 * 1000;
const USED_FILE = process.env.USED_FILE || path.join(process.cwd(), 'used-addresses.txt');
const STARTED_AT = Date.now();
const DEADLINE = STARTED_AT + MAX_RUNTIME_MS;

// Never let secrets show up in the Actions log.
process.stdout.write(`::add-mask::${HUB_KEY}\n`);
for (const t of TOKENS) process.stdout.write(`::add-mask::${t}\n`);

// Persistent known set: everything DDG ever made for us (all previous runs).
const known = new Set();
try {
  for (const a of knownAddressesFromText(fs.readFileSync(USED_FILE, 'utf8'))) known.add(a);
  log({ used_file: USED_FILE, known_addresses: known.size });
} catch (e) {
  log(`used-addresses file not found, it will be created on first save (${e.code || e.message})`);
}

// ---------------------------------------------------------------- pool state

const pool = TOKENS.map((token, i) => ({
  token,
  url: DDG_BASE + DDG_PATH,
  index: i + 1,
  total: TOKENS.length,
  state: 'active', // active | retired | cooldown
  reason: '',
  cooldownUntil: 0,
  ok: 0,
  dup: 0,
  fail: 0,
  lastError: '',
}));

let totalOk = 0;
let totalDup = 0;
let hubFatal = false;
const summary = [];

const timeUp = () => Date.now() >= DEADLINE;
const sleepCapped = (ms) => sleep(Math.max(0, Math.min(ms, DEADLINE - Date.now())));
const tag = (t) => `${t.index}/${t.total}`;

// ---------------------------------------------------------------- hub + state file

async function registerInHub(email) {
  const res = await rawRequest(`${HUB_URL}/pool/emails`, {
    method: 'POST',
    headers: {
      'X-Duck-Key': HUB_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ emails: [email], source: 'gh-collector' }),
    timeout: 25000,
  });
  if (res.status === 401 || res.status === 403) {
    const err = new Error(`hub auth failed (${res.status}) — کلید HUB_API_KEY را بررسی کنید`);
    err.isHubAuth = true;
    throw err;
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`hub error ${res.status}: ${(res.body || '').slice(0, 120)}`);
  }
  const j = res.json || {};
  return { added: Number(j.added || 0), dups: Number(j.duplicates || 0) };
}

/** Called only after the hub accepted the address. */
function rememberAddress(email) {
  const key = email.toLowerCase();
  if (known.has(key)) return;
  known.add(key);
  try {
    fs.mkdirSync(path.dirname(USED_FILE), { recursive: true });
    fs.appendFileSync(USED_FILE, `${key}\t${new Date().toISOString()}\n`, 'utf8');
  } catch (e) {
    log(`warn: cannot append to ${USED_FILE}: ${e.message}`);
  }
}

// ---------------------------------------------------------------- one request

async function collectOnce(t) {
  log(`token ${tag(t)} → درخواست آدرس جدید از DDG…`);
  let res;
  try {
    res = await rawRequest(t.url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${t.token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'zdola-duckmail/1.0 (+github-actions collector)',
      },
      body: '{}',
    });
  } catch (err) {
    t.fail += 1;
    t.lastError = err.message;
    log({ token: tag(t), event: 'network-error', error: err.message });
    return 'error';
  }

  // Invalid / expired account token
  if (res.status === 401 || res.status === 403) {
    t.state = 'retired';
    t.reason = 'invalid-token';
    t.lastError = `DDG ${res.status}`;
    log({ token: tag(t), event: 'retired', reason: 'invalid-token', status: res.status });
    summary.push(`| ${tag(t)} | — | توکن نامعتبر — بازنشسته شد |`);
    return 'retired-invalid';
  }

  // Rate limited — park it; it comes back on a later round
  if (res.status === 429) {
    const ra = parseInt(String(res.headers['retry-after'] || '0'), 10) || 0;
    const waitMs = ra > 0 ? Math.min(ra, 3600) * 1000 : COOLDOWN_MS;
    t.state = 'cooldown';
    t.cooldownUntil = Date.now() + waitMs;
    t.lastError = `DDG 429${ra ? ` (retry-after ${ra}s)` : ''}`;
    log({ token: tag(t), event: 'cooldown', seconds: Math.round(waitMs / 1000) });
    return 'cooldown';
  }

  if (res.status < 200 || res.status >= 300) {
    t.fail += 1;
    t.lastError = `DDG ${res.status}: ${(res.body || '').slice(0, 120)}`;
    log({ token: tag(t), event: 'ddg-error', status: res.status });
    return 'error';
  }

  const email = extractAddress(res.json, res.body, DOMAIN);
  if (!email) {
    t.fail += 1;
    t.lastError = 'no address in DDG response';
    log({ token: tag(t), event: 'no-address' });
    return 'error';
  }

  // DuckDuckGo-side duplicate: the daily quota is exhausted and DDG re-emitted
  // an address it already gave us. Retire the token. NOT sent to the hub.
  const key = email.toLowerCase();
  if (known.has(key)) {
    t.dup += 1;
    totalDup += 1;
    t.state = 'retired';
    t.reason = 'duplicate';
    log({ token: tag(t), email, event: 'retired', reason: 'ddg-duplicate' });
    summary.push(`| ${tag(t)} | \`${email}\` | تکراری — توکن بازنشسته شد |`);
    return 'retired-duplicate';
  }

  // Fresh address → register in the hub, and only then persist it.
  try {
    const hub = await registerInHub(email);
    t.ok += 1;
    totalOk += 1;
    rememberAddress(email);
    log({ token: tag(t), email, event: 'registered', hub_added: hub.added, hub_dups: hub.dups, total_ok: totalOk });
    summary.push(`| ${tag(t)} | \`${email}\` | ثبت شد |`);
    return 'ok';
  } catch (err) {
    t.fail += 1;
    t.lastError = err.message;
    log({ token: tag(t), email, event: 'hub-error', error: err.message });
    summary.push(`| ${tag(t)} | \`${email}\` | ⚠ ثبت در هاب ناموفق (در فایل ذخیره نشد) |`);
    if (err.isHubAuth) {
      // کلید/مجوز هاب خراب است: ادامه دادن فقط توکن‌ها را خالی می‌کند — فتال.
      hubFatal = true;
      for (const other of pool) {
        if (other.state !== 'retired') {
          other.state = 'retired';
          other.reason = 'hub-auth';
        }
      }
      log({ event: 'fatal', error: err.message });
    }
    return 'error';
  }
}

function activeTokens() {
  const now = Date.now();
  for (const t of pool) {
    if (t.state === 'cooldown' && now >= t.cooldownUntil) {
      t.state = 'active';
      t.cooldownUntil = 0;
      log(`token ${tag(t)} → از استراحت برگشت`);
    }
  }
  return pool.filter((t) => t.state === 'active');
}

// ---------------------------------------------------------------- main

(async () => {
  log({
    start: true,
    tokens: TOKENS.length,
    interval_s: INTERVAL,
    max_addresses: MAX_ADDRESSES || 'unlimited',
    max_runtime_min: Math.round(MAX_RUNTIME_MS / 60000),
    hub: HUB_URL,
  });

  let round = 0;
  let stopReason = 'all-retired';

  while (true) {
    if (hubFatal) { stopReason = 'hub-auth-failed'; break; }
    if (timeUp()) { stopReason = 'max-runtime'; log('زمان مجاز اجرا تمام شد — توقف تمیز.'); break; }
    if (MAX_ADDRESSES && totalOk >= MAX_ADDRESSES) { stopReason = 'max-addresses'; break; }

    const active = activeTokens();
    if (!active.length) {
      const cooling = pool.filter((t) => t.state === 'cooldown');
      if (!cooling.length) {
        log('همه‌ی توکن‌ها بازنشسته شدند (سهمیه/اعتبار) — پایان.');
        break;
      }
      const wait = Math.max(1000, Math.min(...cooling.map((t) => t.cooldownUntil)) - Date.now());
      log(`همه‌ی توکن‌های باقی‌مانده در استراحت‌اند — ${Math.ceil(wait / 1000)} ثانیه صبر`);
      await sleepCapped(wait);
      continue;
    }

    round += 1;
    log(`── round ${round} — توکن‌های فعال: ${active.map((t) => t.index).join(', ')}`);

    for (const t of active) {
      if (hubFatal || timeUp() || (MAX_ADDRESSES && totalOk >= MAX_ADDRESSES)) break;
      await collectOnce(t); // exactly one DDG request per token per round
      if (hubFatal || (MAX_ADDRESSES && totalOk >= MAX_ADDRESSES)) break;
      await sleepCapped(INTERVAL * 1000); // فاصله بین هر دریافت ایمیل داک
    }
  }

  // ---------- run summary (visible on the Actions page) ----------
  const out = [];
  out.push('## جمع‌آوری آدرس داک → DuckMail Hub');
  out.push('');
  out.push(`- ثبت موفق در هاب: **${totalOk}**`);
  out.push(`- تکراری سمت داک‌داک‌گو (توکن بازنشسته): ${totalDup}`);
  out.push(`- راند‌ها: ${round}`);
  out.push(`- دلیل توقف: \`${stopReason}\``);
  out.push(`- مدت اجرا: ${Math.round((Date.now() - STARTED_AT) / 60000)} دقیقه`);
  out.push('');
  out.push('| توکن | آدرس | نتیجه |');
  out.push('|---|---|---|');
  for (const row of summary) out.push(row);
  out.push('');
  out.push('### وضعیت نهایی توکن‌ها');
  out.push('');
  out.push('| # | وضعیت | دلیل | ok | dup | fail | آخرین خطا |');
  out.push('|---|---|---|---|---|---|---|');
  for (const t of pool) {
    const err = (t.lastError || '—').replace(/\|/g, '/').slice(0, 80);
    out.push(`| ${tag(t)} | ${t.state} | ${t.reason || '—'} | ${t.ok} | ${t.dup} | ${t.fail} | ${err} |`);
  }
  const text = out.join('\n') + '\n';
  process.stdout.write(`\n${text}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text); } catch (e) { /* ignore */ }
  }

  log({ done: true, total_ok: totalOk, total_dup: totalDup, stop: stopReason });
  process.exit(hubFatal ? 1 : 0);
})().catch((err) => {
  process.stderr.write(`FATAL: ${err.message}\n`);
  process.exit(1);
});
