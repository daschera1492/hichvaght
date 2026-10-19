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
//   429                          → rate limited       → cooldown, stays
//
// Env:
//   HUB_URL            base of the WP site (or the full …/wp-json/duckmail/v1)
//   HUB_KEY            DuckMail Hub API key (dhk_…) with pool permission
//   DUCK_TOKENS        the DDG token pool — newline / comma / semicolon separated
//   INTERVAL_SECONDS   rest between each duck address request (default 45)
//   MAX_ADDRESSES      stop after N successful addresses (0 = until all retire)
//   USED_FILE          persistent known-addresses file (default used-addresses.txt)
//   DDG_BASE_URL       override the DuckDuckGo API root (default quack.duckduckgo.com)
//
// No external dependencies (same style as src/mail/duckmail.js).

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const DDG_BASE = process.env.DDG_BASE_URL || 'https://quack.duckduckgo.com';
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

/** Extract an email out of whatever DDG returned (mirrors duckmail.js). */
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
  if (!base) throw new Error('HUB_URL is empty');
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

/** Every address mentioned in a text file, lower-cased and unique. */
function knownAddressesFromText(raw) {
  const seen = new Set();
  const out = [];
  for (const rawLine of String(raw || '').split(/\r?\n/)) {
    for (const token of rawLine.trim().split(/[\s,;]+/)) {
      const m = token && ADDRESS_RE.exec(token);
      if (m) {
        const key = m[0].trim().toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          out.push(key);
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- config

const HUB_URL = normalizeHubUrl(process.env.HUB_URL);
const HUB_KEY = String(process.env.HUB_KEY || '').trim();
const TOKENS = parseTokens(process.env.DUCK_TOKENS);
const INTERVAL = Math.max(1, parseInt(process.env.INTERVAL_SECONDS || '45', 10) || 45);
const MAX_ADDRESSES = parseInt(process.env.MAX_ADDRESSES || '0', 10) || 0; // 0 = until all retire
const USED_FILE = process.env.USED_FILE || path.join(process.cwd(), 'used-addresses.txt');
const DOMAIN = process.env.DD_DOMAIN || 'duck.com';
const COOLDOWN_429_MS = 10 * 60 * 1000; // parked until this elapses

if (!HUB_KEY) throw new Error('HUB_KEY is empty (repository variable HUB_API_KEY?)');
if (!TOKENS.length) throw new Error('DUCK_TOKENS is empty');

// Persistent known set: everything DDG ever made for us (all previous runs).
let known = new Set();
try {
  known = new Set(knownAddressesFromText(fs.readFileSync(USED_FILE, 'utf8')));
  log({ used_file: path.relative(process.cwd() || '.', USED_FILE) || USED_FILE, known_addresses: known.size });
} catch (e) {
  log(`used-addresses file exists? (creating on first save) — ${e.message}`);
}

// ---------------------------------------------------------------- pool state

const pool = TOKENS.map((token, i) => ({
  token,
  url: DDG_BASE.replace(/\/+$/, '') + DDG_PATH,
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

const seenThisRun = new Set(); // fresh addresses from this run
let totalOk = 0;
let totalDup = 0;
const summary = [];

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
    const err = new Error(`hub auth failed (${res.status}) — check the HUB_API_KEY repository variable`);
    err.isHubAuth = true;
    throw err;
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`hub error ${res.status}: ${(res.body || '').slice(0, 120)}`);
  }
  const j = res.json || {};
  return { added: Number(j.added || 0), dups: Number(j.duplicates || 0) };
}

function saveUsedFile() {
  try {
    const stamps = new Map(); // keep timestamps of fresh entries
    for (const email of seenThisRun) stamps.set(email, new Date().toISOString());
    try {
      for (const line of fs.readFileSync(USED_FILE, 'utf8').split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        if (parts[0] && ADDRESS_RE.test(parts[0])) stamps.set(parts[0].toLowerCase(), parts[1] || '');
      }
    } catch (e) { /* first write */ }
    const rows = [...stamps.entries()].map(([email, ts]) => `${email}${ts ? `\t${ts}` : ''}`);
    fs.writeFileSync(USED_FILE, rows.join('\n') + '\n', 'utf8');
  } catch (e) {
    log(`warn: cannot write ${USED_FILE}: ${e.message}`);
  }
}

async function collectOnce(t) {
  log(`token ${t.index}/${t.total} → درخواست آدرس جدید از DDG…`);
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
    log({ token: `${t.index}/${t.total}`, event: 'network-error', error: err.message });
    return 'error'; // transient → keep the token
  }

  // Invalid / expired account token
  if (res.status === 401 || res.status === 403) {
    t.state = 'retired';
    t.reason = 'invalid-token';
    t.lastError = `DDG ${res.status}`;
    log({ token: `${t.index}/${t.total}`, event: 'retired', reason: 'invalid-token', status: res.status });
    return 'retired-invalid';
  }

  // Rate limited — park it for a while; it comes back on a later round
  if (res.status === 429) {
    const ra = parseInt(String(res.headers['retry-after'] || '0'), 10) || 0;
    t.state = 'cooldown';
    t.cooldownUntil = Date.now() + (ra > 0 ? Math.min(ra, 30) * 1000 : COOLDOWN_429_MS);
    t.lastError = `DDG 429${ra ? ` (retry-after ${ra}s)` : ''}`;
    log({ token: `${t.index}/${t.total}`, event: 'cooldown', retry_after: ra });
    return 'cooldown';
  }

  if (res.status < 200 || res.status >= 300) {
    t.fail += 1;
    t.lastError = `DDG ${res.status}: ${(res.body || '').slice(0, 120)}`;
    log({ token: `${t.index}/${t.total}`, event: 'ddg-error', status: res.status });
    return 'error';
  }

  const email = extractAddress(res.json, res.body, DOMAIN);
  if (!email) {
    t.fail += 1;
    t.lastError = 'no address in DDG response';
    log({ token: `${t.index}/${t.total}`, event: 'no-address' });
    return 'error'; // transient shape issue, keep the token
  }

  // ---- DuckDuckGo-side duplicate: the daily quota is exhausted and DDG
  // re-emitted an address it already gave us before. Retire the token and
  // move on with the rest of the pool. NOT sent to the hub.
  const key = email.toLowerCase();
  if (known.has(key) || seenThisRun.has(key)) {
    t.dup += 1;
    totalDup += 1;
    t.state = 'retired';
    t.reason = 'duplicate'; // DDG quota reached (تکراری سمت داک‌داک‌گو)
    log({ token: `${t.index}/${t.total}`, email, event: 'retired', reason: 'ddg-duplicate' });
    summary.push(`| ${t.index}/${t.total} | \`${email}\` | تکراری — توکن بازنشسته شد |`);
    return 'retired-duplicate';
  }

  // Fresh address → register in the hub + persist
  seenThisRun.add(key);
  try {
    const hub = await registerInHub(email);
    t.ok += 1;
    totalOk += 1;
    appendUsed(email);
    log({ token: `${t.index}/${t.total}`, email, event: 'registered', hub_added: hub.added, total_ok: totalOk });
    summary.push(`| ${t.index}/${t.total} | \`${email}\` | ثبت شد |`);
    return 'ok';
  } catch (err) {
    t.fail += 1;
    t.lastError = err.message;
    log({ token: `${t.index}/${t.total}`, event: 'hub-error', error: err.message });
    if (err.isHubAuth) {
      // کلید/مجوز هاب خراب است: ادامه دادن فقط توکن‌ها را خالی می‌کند — فتال.
      for (const other of pool) {
        other.state = 'retired';
        other.reason = 'hub-auth';
      }
      log({ event: 'fatal', error: err.message });
    }
    return 'error';
  }
}

function appendUsed(email) {
  try {
    const lines = fs.existsSync(USED_FILE) ? fs.readFileSync(USED_FILE, 'utf8') : '';
    if (!knownAddressesFromText(lines).includes(email.toLowerCase())) {
      fs.appendFileSync(USED_FILE, `${email}\t${new Date().toISOString()}\n`, 'utf8');
    }
  } catch (e) {
    log(`warn: cannot append to ${USED_FILE}: ${e.message}`);
  }
}

function activeTokens() {
  const now = Date.now();
  for (const t of pool) {
    if (t.state === 'cooldown' && now >= t.cooldownUntil) {
      t.state = 'active';
      t.cooldownUntil = 0;
      log(`token ${t.index}/${t.total} → از استراحت برگشت`);
    }
  }
  return pool.filter((t) => t.state === 'active');
}

(async () => {
  log({
    start: true,
    tokens: TOKENS.length,
    interval_s: INTERVAL,
    max_addresses: MAX_ADDRESSES || 'unlimited',
    hub: HUB_URL,
  });

  let round = 0;
  while (true) {
    const active = pool.filter((t) => t.state === 'active');
    if (!active.length) {
      log('همه‌ی توکن‌ها بازنشسته شدند (سهمیه/اعتبار) — پایان.');
      break;
    }
    if (MAX_ADDRESSES && totalOk >= MAX_ADDRESSES) {
      log({ stop: 'max-addresses-reached', total_ok: totalOk });
      break;
    }

    round += 1;
    log(`── round ${round} — توکن‌های فعال: ${active.map((t) => t.index).join(', ')}`);

    for (const t of active.slice()) {
      if (MAX_ADDRESSES && totalOk >= MAX_ADDRESSES) break;
      await collectOnce(t); // exactly one DDG request per token per round
      saveUsedFile();       // persist after every request
      await sleep(INTERVAL * 1000); // فاصله بین هر دریافت ایمیل داک
    }
  }

  saveUsedFile();

  // ---------- run summary (visible on the Actions page) ----------
  const out = [];
  out.push('## جمع‌آوری آدرس داک → DuckMail Hub');
  out.push('');
  out.push(`- ثبت موفق در هاب: **${totalOk}**`);
  out.push(`- تکراری سمت داک‌داک‌گو (توکن بازنشسته): ${totalDup}`);
  out.push(`- راند‌ها: ${round}`);
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
    out.push(`| ${t.index}/${t.total} | ${t.state} | ${t.reason || '—'} | ${t.ok} | ${t.dup} | ${t.fail} | ${(t.lastError || '—').slice(0, 80)} |`);
  }
  const text = out.join('\n') + '\n';
  process.stdout.write(`\n${text}\n`);
  try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY || '', text); } catch (e) { /* not in Actions */ }

  log({ done: true, total_ok: totalOk, total_dup: totalDup });
  process.exit(0);
})().catch((err) => {
  process.stderr.write(`FATAL: ${err.message}\n`);
  process.exit(1);
});
