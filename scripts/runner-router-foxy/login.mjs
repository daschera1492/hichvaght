// FoxyVPN-compatible Firefox Account login refresh for the GitHub runner.
//
// The previous runner let awmvpn-core perform the Firefox Account login itself.
// Mozilla changed the FxA control plane, and that path stopped working: the
// refresh grant is now served by oauth.accounts.firefox.com and the control
// plane expects the Mozilla VPN client's headers. This script performs the same
// flow FoxyVPN v2.0.2 uses (Vauth/FoxyVPN), proves the Guardian proxy pass, and
// writes the refreshed credentials back into the awmvpn accounts archive that
// the existing router.mjs installs.
//
// Credential source (the archive wins when both are present):
//   FXA_ACCOUNTS_TGZ_B64  the existing archive (base64 tar.gz of accounts/)
//   FOXY_ACCOUNTS_TGZ_B64 the same thing under a FoxyVPN-specific name
//   FOXY_REFRESH_TOKEN    one refresh token; a fresh archive is created
//
// Tokens are never printed. Only account positions and HTTP failures are.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const CLIENT_ID = "5882386c6d801776";
const SCOPE = "profile https://identity.mozilla.com/apps/vpn";
const FXA_OAUTH_TOKEN = "https://oauth.accounts.firefox.com/v1/token";
const FXA_API_TOKEN = "https://api.accounts.firefox.com/v1/oauth/token";
const GUARDIAN = "https://vpn.mozilla.org";
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

// Copied from FoxyVPN v2.0.2 (Vauth/FoxyConfig/main/config.json). This is the
// header shape Mozilla's control plane now accepts; the old awmvpn used a
// desktop Firefox User-Agent and was rejected.
const CONTROL_HEADERS = {
  "User-Agent": "MozillaVPN/2.24.0 (sys:android 14)",
  Accept: "*/*",
  "Accept-Encoding": "identity",
};
const GUARDIAN_HEADERS = {
  "User-Agent": "MozillaVPN/2.24.0 (sys:android 14)",
  Accept: "application/json",
  "Accept-Encoding": "identity",
  "Content-Type": "application/json",
  "Cache-Control": "max-age=0",
};

const log = (...a) => console.log(...a);

function fail(message) {
  throw new Error(message);
}

function accountLabel(index, id) {
  const tail = id.length > 4 ? id.slice(-4) : id;
  return `account #${index + 1} (…${tail})`;
}

async function httpJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON error page */
  }
  return { res, text, data };
}

async function refreshOnce(url, refreshToken) {
  const body = JSON.stringify({
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: SCOPE,
  });
  const { res, text, data } = await httpJson(url, {
    method: "POST",
    headers: { ...CONTROL_HEADERS, "Content-Type": "application/json" },
    body,
  });
  if (res.status !== 200) {
    const detail =
      data.message || data.error || text.slice(0, 200).replace(/\s+/g, " ") || `HTTP ${res.status}`;
    const err = new Error(`HTTP ${res.status}: ${detail}`);
    err.status = res.status;
    err.errno = data.errno;
    throw err;
  }
  if (!data.access_token) fail("FxA returned no access_token");
  return data;
}

// FoxyVPN tries the OAuth host first and falls back to the API host when Fastly
// blocks that request (406) or the host is unreachable. A 400/401/403 means the
// refresh token itself was rejected, so there is nothing to retry.
async function refresh(refreshToken) {
  let first;
  try {
    return await refreshOnce(FXA_OAUTH_TOKEN, refreshToken);
  } catch (error) {
    first = error;
    if (error.status && ![406, 429, 500, 502, 503, 504].includes(error.status)) throw error;
    log(`• oauth host refused the refresh (${error.message}); trying the API host`);
  }
  try {
    return await refreshOnce(FXA_API_TOKEN, refreshToken);
  } catch (error) {
    log(`• oauth host failure: ${first.message}`);
    throw error;
  }
}

// A 200 from Guardian proves both the access token and the account's proxy
// entitlement. 403 means the account has not been activated yet, so activate
// it exactly as FoxyVPN does and retry once.
async function guardianPass(accessToken) {
  const tokenUrl = `${GUARDIAN}/api/v1/fpn/token`;
  const headers = () => ({ ...GUARDIAN_HEADERS, Authorization: `Bearer ${accessToken}` });

  let result = await httpJson(tokenUrl, { headers: headers() });
  if (result.res.status === 403) {
    log("• Guardian says the account is not activated; activating the entitlement");
    const activation = await httpJson(`${GUARDIAN}/api/v1/fpn/activate`, {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: "",
    });
    if (activation.res.status !== 200) {
      fail(
        `Guardian activation failed (HTTP ${activation.res.status}): ` +
          activation.text.slice(0, 200).replace(/\s+/g, " "),
      );
    }
    result = await httpJson(tokenUrl, { headers: headers() });
  }
  if (result.res.status === 401) fail("Guardian rejected the FxA access token (HTTP 401)");
  if (result.res.status !== 200) {
    fail(
      `Guardian token request failed (HTTP ${result.res.status}): ` +
        result.text.slice(0, 200).replace(/\s+/g, " "),
    );
  }
  if (!result.data.token) fail("Guardian returned no proxy token");
  return {
    quota: result.res.headers.get("x-quota-remaining") || result.res.headers.get("quota-remaining"),
  };
}

async function isDirectory(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.length >= 0;
  } catch {
    return false;
  }
}

async function findAccountsRoot(dir) {
  if (await isDirectory(join(dir, "accounts"))) return dir;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = join(dir, entry.name);
    if (await isDirectory(join(nested, "accounts"))) return nested;
  }
  fail("the archive has no accounts/ folder");
}

async function extractArchive(base64) {
  const dir = await mkdtemp(join(tmpdir(), "foxy-login-"));
  const tarPath = join(dir, "accounts.tar.gz");
  await writeFile(tarPath, Buffer.from(base64, "base64"));
  await execFileP("tar", ["xzf", tarPath, "-C", dir]);
  return findAccountsRoot(dir);
}

async function packArchive(root) {
  const tarPath = join(tmpdir(), `foxy-accounts-${process.pid}.tar.gz`);
  await execFileP("tar", ["czf", tarPath, "-C", root, "accounts"]);
  const bytes = await readFile(tarPath);
  await rm(tarPath, { force: true });
  return bytes.toString("base64");
}

async function accountIds(root) {
  const names = [];
  for (const entry of await readdir(join(root, "accounts"), { withFileTypes: true })) {
    if (entry.isDirectory()) names.push(entry.name);
  }
  if (!names.length) fail("the archive contains no account folders");
  return names;
}

function credentialsFrom(tokens, previous, refreshToken) {
  const expiresIn = Number(tokens.expires_in) > 0 ? Number(tokens.expires_in) : DEFAULT_TTL_SECONDS;
  return {
    access_token: tokens.access_token,
    refresh_token: (tokens.refresh_token || "").trim() || refreshToken,
    scope: tokens.scope || previous.scope || SCOPE,
    obtained_at: new Date().toISOString(),
    expires_in: expiresIn,
  };
}

async function markUnusable(root, id, reason) {
  const accPath = join(root, "accounts", id, "account.json");
  let account;
  try {
    account = JSON.parse(await readFile(accPath, "utf8"));
  } catch {
    return;
  }
  account.status = "reauth_required";
  account.reason = `FoxyVPN login refresh failed: ${reason}`.slice(0, 300);
  delete account.reason_code;
  delete account.reason_detail;
  delete account.retry_at;
  await writeFile(accPath, `${JSON.stringify(account, null, 2)}\n`, { mode: 0o600 });
}

async function refreshAccount(root, id, index) {
  const dir = join(root, "accounts", id);
  const account = JSON.parse(await readFile(join(dir, "account.json"), "utf8"));
  const credentials = JSON.parse(await readFile(join(dir, "credentials.json"), "utf8"));
  const refreshToken = String(credentials.refresh_token || "").trim();
  if (!refreshToken) fail("the stored account has no refresh_token");

  const tokens = await refresh(refreshToken);
  const pass = await guardianPass(tokens.access_token);
  const fresh = credentialsFrom(tokens, credentials, refreshToken);

  // The password is deliberately not copied: the old password sign-in path is
  // what Mozilla stopped accepting, and keeping it would let awmvpn retry it
  // (and send confirmation mails) instead of reporting a clean failure.
  await writeFile(join(dir, "credentials.json"), `${JSON.stringify(fresh, null, 2)}\n`, {
    mode: 0o600,
  });

  account.status = "ready";
  delete account.reason;
  delete account.reason_code;
  delete account.reason_detail;
  delete account.retry_at;
  await writeFile(join(dir, "account.json"), `${JSON.stringify(account, null, 2)}\n`, {
    mode: 0o600,
  });

  log(
    `  ✓ ${accountLabel(index, id)}: access token valid for ${fresh.expires_in}s` +
      (pass.quota ? `, quota remaining ${pass.quota} bytes` : ""),
  );
  return fresh;
}

async function createFromRefreshToken(refreshToken) {
  const root = await mkdtemp(join(tmpdir(), "foxy-login-"));
  const id = "foxy";
  const dir = join(root, "accounts", id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(root, "accounts", "secret.key"), `${randomBytes(32).toString("hex")}\n`, {
    mode: 0o600,
  });

  const tokens = await refresh(refreshToken);
  const pass = await guardianPass(tokens.access_token);
  const fresh = credentialsFrom(tokens, {}, refreshToken);
  const now = new Date().toISOString();

  await writeFile(join(dir, "credentials.json"), `${JSON.stringify(fresh, null, 2)}\n`, {
    mode: 0o600,
  });
  await writeFile(
    join(dir, "account.json"),
    `${JSON.stringify(
      {
        id,
        label: "FoxyVPN",
        added_at: now,
        status: "ready",
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  log(
    `  ✓ FOXY_REFRESH_TOKEN: access token valid for ${fresh.expires_in}s` +
      (pass.quota ? `, quota remaining ${pass.quota} bytes` : ""),
  );
  return root;
}

async function exportEnv(pairs) {
  const path = process.env.GITHUB_ENV;
  if (!path) {
    log("• GITHUB_ENV is not set; the refreshed archive is not exported");
    return;
  }
  const body = Object.entries(pairs)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  await appendFile(path, `${body}\n`);
}

async function main() {
  const archive = (
    process.env.FOXA_ACCOUNTS_TGZ_B64 ||
    process.env.FXA_ACCOUNTS_TGZ_B64 ||
    ""
  ).trim();
  const refreshToken = (process.env.FOXY_REFRESH_TOKEN || "").trim();

  if (!archive && !refreshToken) {
    fail(
      "no Firefox VPN credentials: set FXA_ACCOUNTS_TGZ_B64 (the existing accounts " +
        "archive) or FOXY_REFRESH_TOKEN (a refresh token from FoxyVPN)",
    );
  }

  let root;
  if (archive) {
    log(
      `• FoxyVPN login: refreshing the accounts archive ` +
        `(${(archive.length / 1024).toFixed(1)} KiB base64)…`,
    );
    root = await extractArchive(archive);
    const ids = await accountIds(root);
    let usable = 0;
    for (let i = 0; i < ids.length; i++) {
      try {
        await refreshAccount(root, ids[i], i);
        usable++;
      } catch (error) {
        log(`  ✗ ${accountLabel(i, ids[i])}: ${error.message}`);
        await markUnusable(root, ids[i], error.message);
      }
    }
    if (!usable) {
      if (refreshToken) {
        log("• no archived account could be refreshed; trying FOXY_REFRESH_TOKEN instead");
        root = await createFromRefreshToken(refreshToken);
      } else {
        // Last resort: hand the archive to awmvpn untouched and let its own
        // login path try. It is the path that stopped working, but a session
        // that still succeeds is better than a guaranteed failure.
        log(
          "• WARNING: no archived account could be refreshed. Handing the original " +
            "archive to awmvpn so its own login can try; if that also fails, sign in " +
            "once with FoxyVPN and set FOXY_REFRESH_TOKEN.",
        );
        await exportEnv({ FXA_ACCOUNTS_TGZ_B64: archive, FOXY_LOGIN_VERIFIED: "0" });
        await rm(root, { recursive: true, force: true });
        return;
      }
    }
  } else {
    log("• FoxyVPN login: creating an account from FOXY_REFRESH_TOKEN…");
    root = await createFromRefreshToken(refreshToken);
  }

  const refreshed = await packArchive(root);
  await exportEnv({
    FXA_ACCOUNTS_TGZ_B64: refreshed,
    FOXY_LOGIN_VERIFIED: "1",
  });
  log(`• FoxyVPN login: refreshed archive ready (${(refreshed.length / 1024).toFixed(1)} KiB base64).`);
  await rm(root, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(`FoxyVPN login failed: ${error.message}`);
  process.exit(1);
});
