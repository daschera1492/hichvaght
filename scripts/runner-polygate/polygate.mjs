// Runner-only Polygate: the free-model gateway runs on the GitHub runner itself.
//
//   cloudflared  -> 127.0.0.1:4317   the public entry for <subdomain>.codol.ir
//   polygate     -> systemd (user "polygate"), state in /var/lib/polygate
//
// Same plumbing as scripts/runner-router/router.mjs, with 9Router replaced by
// Polygate (https://github.com/B3hnamR/Polygate). There is no second VPN to
// wait for: Polygate brings its own exits (Direct, WARP, proxy pool, relays)
// and they are chosen in the dashboard.
//
// The runner has no inbound port, so the domain can only reach it through a
// Cloudflare Tunnel the runner dials out. The tunnel is created per run through
// CF_API_TOKEN (or reused through CF_TUNNEL_TOKEN) and its DNS record is kept
// pointing at it.
//
// Usage: node polygate.mjs start | stop

import { execFile } from "node:child_process";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.ROUTER_PORT || 4317);
const DOMAIN = process.env.ROUTER_DOMAIN || "polygate.codol.ir";
const DATA_DIR = process.env.POLYGATE_STATE_DIR || "/var/lib/polygate";
const TUNNEL_USER = "cfd";
// A dashboard password is mandatory and Polygate refuses anything shorter
// than 12 characters. It comes from the POLYGATE_ADMIN_PASSWORD secret (the
// workflow also accepts the old NINE_ROUTER_PASSWORD as a fallback), so it is
// never printed and never written into the workflow log.
const PASSWORD = (process.env.POLYGATE_ADMIN_PASSWORD || "").trim();

const CF = {
  token: (process.env.CF_API_TOKEN || "").trim(),
  zone: (process.env.CF_ZONE_ID || "").trim(),
  tunnelToken: (process.env.CF_TUNNEL_TOKEN || "").trim(),
  tunnelName: process.env.CF_TUNNEL_NAME || "polygate",
};

const log = (...a) => console.log(...a);
const header = (t) => console.log(`\n${"=".repeat(62)}\n${t}\n${"=".repeat(62)}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------ shell
function sh(cmd, { env = {}, timeout = 900_000, check = true } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      "bash",
      ["-lc", cmd],
      { env: { ...process.env, ...env }, timeout, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = `${stdout ?? ""}${stderr ?? ""}`.trim();
        if (err && check) {
          // Never echo the environment: it carries the dashboard password and
          // the tunnel token.
          reject(
            new Error(
              `command failed (exit ${err.code ?? "?"}):\n${cmd}\n--- output ---\n${out}`,
            ),
          );
          return;
        }
        resolve({ out, code: err?.code ?? 0 });
      },
    );
  });
}

const must = async (cmd, opts) => (await sh(cmd, opts)).out;

async function exportEnv(pairs) {
  if (!process.env.GITHUB_ENV) return;
  await appendFile(
    process.env.GITHUB_ENV,
    Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
  );
}

async function summary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
}

// ------------------------------------------------------------------ tunnel
async function cf(path, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${CF.token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const detail =
      (body.errors || []).map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${res.status}`;
    throw new Error(`cloudflare ${path} -> ${detail}`);
  }
  return body.result;
}

function zoneName() {
  return DOMAIN.split(".").slice(-2).join(".");
}

async function ensureTunnelToken() {
  if (CF.tunnelToken) {
    log(" Tunnel: using the existing CF_TUNNEL_TOKEN");
    return CF.tunnelToken;
  }
  if (!CF.token) {
    throw new Error(
      `Neither CF_TUNNEL_TOKEN nor CF_API_TOKEN is set. A GitHub runner has no public inbound ` +
        `port, so ${DOMAIN} can only reach it through a Cloudflare Tunnel.`,
    );
  }

  log(" Tunnel: no CF_TUNNEL_TOKEN - provisioning one through the Cloudflare API.");
  let accountId;
  try {
    const accounts = await cf("/accounts");
    accountId = accounts?.[0]?.id;
  } catch (err) {
    throw new Error(
      `CF_API_TOKEN cannot list accounts (${err.message}). Either give it "Account: Read" + ` +
        `"Cloudflare Tunnel: Edit", or create the tunnel by hand: Zero Trust -> Networks -> ` +
        `Tunnels -> Create, public hostname ${DOMAIN} -> http://localhost:${PORT}, then store its ` +
        `token as the CF_TUNNEL_TOKEN secret.`,
    );
  }
  if (!accountId) throw new Error("CF_API_TOKEN has no account to create the tunnel in");

  let tunnel;
  try {
    tunnel = (
      await cf(
        `/accounts/${accountId}/cfd_tunnel?name=${encodeURIComponent(CF.tunnelName)}&is_deleted=false`,
      )
    )?.[0];
    if (tunnel) {
      log(` Tunnel: reusing "${CF.tunnelName}" (${tunnel.id})`);
    } else {
      tunnel = await cf(`/accounts/${accountId}/cfd_tunnel`, {
        method: "POST",
        body: JSON.stringify({ name: CF.tunnelName, config_src: "cloudflare" }),
      });
      log(` Tunnel: created "${CF.tunnelName}" (${tunnel.id})`);
    }
  } catch (err) {
    throw new Error(
      `CF_API_TOKEN cannot manage Cloudflare Tunnels (${err.message}).\n` +
        `    Fix either one:\n` +
        `      1. Cloudflare dashboard -> My Profile -> API Tokens -> edit the token and add\n` +
        `         "Account -> Cloudflare Tunnel -> Edit", or\n` +
        `      2. Zero Trust -> Networks -> Tunnels -> Create a tunnel (Cloudflared),\n` +
        `         public hostname ${DOMAIN} -> http://localhost:${PORT},\n` +
        `         then store its token as the CF_TUNNEL_TOKEN secret.`,
    );
  }

  await cf(`/accounts/${accountId}/cfd_tunnel/${tunnel.id}/configurations`, {
    method: "PUT",
    body: JSON.stringify({
      config: {
        ingress: [
          { hostname: DOMAIN, service: `http://localhost:${PORT}` },
          { service: "http_status:404" },
        ],
      },
    }),
  });
  log(` Tunnel: ingress ${DOMAIN} -> http://localhost:${PORT}`);

  const zoneId = CF.zone || (await cf(`/zones?name=${encodeURIComponent(zoneName())}`))?.[0]?.id;
  if (!zoneId) throw new Error(`zone ${zoneName()} is not visible to CF_API_TOKEN`);
  const record = {
    type: "CNAME",
    name: DOMAIN,
    content: `${tunnel.id}.cfargotunnel.com`,
    proxied: true,
    ttl: 1,
  };
  const existing = await cf(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(DOMAIN)}`);
  if (existing?.length) {
    for (const r of existing) {
      if (r.id) await cf(`/zones/${zoneId}/dns_records/${r.id}`, { method: "DELETE" }).catch(() => {});
    }
  }
  await cf(`/zones/${zoneId}/dns_records`, { method: "POST", body: JSON.stringify(record) });
  log(` Tunnel: DNS ${DOMAIN} -> CNAME ${record.content} (proxied)`);

  return await cf(`/accounts/${accountId}/cfd_tunnel/${tunnel.id}/token`);
}

// The dashboard's "Public Hostname" step also creates the CNAME that makes the
// name resolve. Doing it here means a session heals itself even if nobody
// touched the dashboard - the tunnel id is already inside the token.
async function ensureDns(tunnelToken) {
  if (!CF.token || !CF.zone) {
    log(" Tunnel: no CF_API_TOKEN/CF_ZONE_ID - skipping the DNS check");
    return;
  }
  let tunnelId;
  try {
    tunnelId = JSON.parse(Buffer.from(tunnelToken, "base64").toString()).t;
  } catch {
    log(" Tunnel: cannot read the tunnel id from the token - skipping the DNS check");
    return;
  }
  const target = `${tunnelId}.cfargotunnel.com`;
  try {
    const existing = await cf(`/zones/${CF.zone}/dns_records?name=${encodeURIComponent(DOMAIN)}`);
    const current = existing?.[0];
    if (current?.type === "CNAME" && current?.content === target) {
      log(` Tunnel: DNS ${DOMAIN} -> ${target} already correct`);
      return;
    }
    const record = { type: "CNAME", name: DOMAIN, content: target, proxied: true, ttl: 1 };
    if (current) {
      await cf(`/zones/${CF.zone}/dns_records/${current.id}`, {
        method: "PUT",
        body: JSON.stringify(record),
      });
      log(` Tunnel: DNS ${DOMAIN} -> ${target} updated`);
    } else {
      await cf(`/zones/${CF.zone}/dns_records`, { method: "POST", body: JSON.stringify(record) });
      log(` Tunnel: DNS ${DOMAIN} -> ${target} created`);
    }
  } catch (err) {
    // Not fatal: the record may already be right, and the public probe below
    // reports the real state.
    log(` Tunnel: DNS check skipped (${err.message})`);
  }
}

async function startTunnel() {
  const token = await ensureTunnelToken();
  await ensureDns(token);

  log(" Tunnel: installing cloudflared.");
  await must(
    `if ! command -v cloudflared >/dev/null 2>&1; then
       curl -fsSL -o /tmp/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
       sudo install -m 0755 /tmp/cloudflared /usr/local/bin/cloudflared
       rm -f /tmp/cloudflared
     fi
     cloudflared --version`,
    { timeout: 300_000 },
  );

  // cloudflared keeps a uid of its own. The service installer writes a unit
  // without User=, so patch it afterwards.
  log(` Tunnel: running the service as "${TUNNEL_USER}".`);
  const out = await must(
    `set -e
     id -u ${TUNNEL_USER} >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin ${TUNNEL_USER}
     sudo cloudflared service install "$CF_TUNNEL_TOKEN_INTERNAL" 2>&1 | tail -3 || true
     sudo sed -i '/^User=/d;/^Group=/d' /etc/systemd/system/cloudflared.service
     sudo sed -i '/^\\[Service\\]/a User=${TUNNEL_USER}\\nGroup=${TUNNEL_USER}' /etc/systemd/system/cloudflared.service
     sudo chown -R ${TUNNEL_USER}:${TUNNEL_USER} /etc/cloudflared 2>/dev/null || true
     sudo chmod 700 /etc/cloudflared 2>/dev/null || true
     sudo systemctl daemon-reload
     sudo systemctl enable cloudflared >/dev/null 2>&1 || true
     sudo systemctl restart cloudflared
     sleep 3
     systemctl is-active cloudflared
     grep -E '^(User|Group)=' /etc/systemd/system/cloudflared.service`,
    { env: { CF_TUNNEL_TOKEN_INTERNAL: token }, timeout: 300_000 },
  );
  for (const line of out.split("\n").filter(Boolean)) log(`    ${line}`);
}

// ------------------------------------------------------------------ polygate
async function installPolygate() {
  header("Installing Polygate");
  log(" Polygate: downloading the official Linux installer.");
  await must(
    `curl -fsSL --retry 3 --connect-timeout 15 ` +
      `https://raw.githubusercontent.com/B3hnamR/Polygate/main/install.sh -o /tmp/polygate-install.sh`,
    { timeout: 300_000 },
  );

  // --yes + --https local: the dashboard listens on 127.0.0.1 only and
  // cloudflared is the public entrance. The password goes through the
  // environment (never the command text, which errors echo into the log).
  // An empty POLYGATE_DASHBOARD_PATH keeps the dashboard at the root of the
  // domain instead of /polygate.
  log(` Polygate: installing release "latest" on 127.0.0.1:${PORT}.`);
  const out = await must(
    `sudo --preserve-env=POLYGATE_DASHBOARD_PATH,POLYGATE_SKIP_DNS_CHECK,POLYGATE_ADMIN_PASSWORD ` +
      `bash /tmp/polygate-install.sh --yes --https local --port ${PORT}`,
    {
      env: {
        POLYGATE_DASHBOARD_PATH: "",
        POLYGATE_SKIP_DNS_CHECK: "1",
        POLYGATE_ADMIN_PASSWORD: PASSWORD,
      },
      timeout: 1_800_000,
    },
  );
  for (const line of out.split("\n").slice(-15).filter(Boolean)) log(`    ${line}`);
}

// cloudflared forwards the public name in Host. Polygate pins the Host header
// on a loopback listener, so the name must be allowed; X-Forwarded-* from
// cloudflared are trusted one hop, and the browser's scheme is https.
async function configureTunnelHost(workDir) {
  header("Pointing Polygate at the tunnel hostname");
  const script = `set -euo pipefail
f=/etc/polygate/polygate.env
cp -p "$f" "$f.before-tunnel"
grep -Ev '^(POLYGATE_ALLOWED_HOSTS|POLYGATE_TRUST_PROXY|POLYGATE_COOKIE_SECURE|POLYGATE_DASHBOARD_PATH)=' "$f" > "$f.new"
{
  printf 'POLYGATE_ALLOWED_HOSTS=%s\\n' '${DOMAIN}'
  printf 'POLYGATE_TRUST_PROXY=1\\n'
  printf 'POLYGATE_COOKIE_SECURE=1\\n'
} >> "$f.new"
mv "$f.new" "$f"
chmod 600 "$f"
systemctl restart polygate
`;
  const file = join(workDir, "configure-polygate.sh");
  await writeFile(file, script, { mode: 0o600 });
  await must(`sudo bash ${file}`, { timeout: 300_000 });
  log(` Polygate: POLYGATE_ALLOWED_HOSTS=${DOMAIN}, trust-proxy=1, secure cookie=1.`);
}

async function waitHealthy() {
  log(` Polygate: waiting for 127.0.0.1:${PORT}/healthz.`);
  for (let i = 1; i <= 90; i++) {
    const r = await sh(`curl -fsS --max-time 5 http://127.0.0.1:${PORT}/healthz`, {
      check: false,
      timeout: 15_000,
    });
    if (r.code === 0 && r.out.includes('"ok":true')) {
      log(`    answered after ${i}s: ${r.out.slice(0, 160)}`);
      // The tunnel sends Host: <domain>; prove the listener accepts that name
      // before cloudflared is asked to serve it.
      const host = await sh(
        `curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H ${JSON.stringify(`Host: ${DOMAIN}`)} http://127.0.0.1:${PORT}/`,
        { check: false, timeout: 15_000 },
      );
      const code = host.out.trim();
      if (/^(2|3)\d\d$/.test(code)) {
        log(`    Host ${DOMAIN} -> ${code} on the runner`);
        return;
      }
      const body = await must(
        `curl -s --max-time 5 -H ${JSON.stringify(`Host: ${DOMAIN}`)} http://127.0.0.1:${PORT}/ | head -c 300`,
        { check: false },
      );
      throw new Error(
        `Polygate answered ${code} for Host ${DOMAIN}. The allowed-hosts setting did not apply. ${body}`,
      );
    }
    if (i % 10 === 0) log(`    still waiting (${i}s)`);
    await sleep(1000);
  }
  throw new Error(
    `Polygate did not answer on 127.0.0.1:${PORT}/healthz. Read the service log: sudo journalctl -u polygate -n 100`,
  );
}

async function verifyPublic() {
  log(` Tunnel: waiting for https://${DOMAIN}/ to answer.`);
  for (let i = 1; i <= 40; i++) {
    const r = await sh(
      `curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://${DOMAIN}/`,
      { check: false, timeout: 30_000 },
    );
    const code = r.out.trim();
    if (/^(2|3)\d\d$/.test(code)) {
      log(`    ${DOMAIN} answers ${code} after ${i * 3}s`);
      return true;
    }
    if (i === 1 || i % 5 === 0) log(`    ${DOMAIN} -> ${code || "no answer"} (${i * 3}s)`);
    await sleep(3000);
  }
  log("    the tunnel is up but the public hostname has not answered yet");
  return false;
}

// ------------------------------------------------------------------ start
async function start() {
  header(`Polygate on the runner - ${DOMAIN}`);

  if (PASSWORD.length < 12) {
    throw new Error(
      `The dashboard password must be at least 12 characters.\n` +
        `    Add the repository secret POLYGATE_ADMIN_PASSWORD (Settings -> Secrets and variables -> Actions),\n` +
        `    or set NINE_ROUTER_PASSWORD to a value of 12+ characters. Nothing was installed.`,
    );
  }
  if (!CF.token && !CF.tunnelToken) {
    throw new Error(
      `Neither CF_API_TOKEN nor CF_TUNNEL_TOKEN is set. ${DOMAIN} cannot reach the runner without a tunnel.`,
    );
  }

  const workDir = await mkdtemp(join(tmpdir(), "polygate-runner-"));
  try {
    // Provision the tunnel first: if Cloudflare is misconfigured there is no
    // point installing the gateway.
    await startTunnel();

    await installPolygate();
    await configureTunnelHost(workDir);
    await waitHealthy();
    const public_ok = await verifyPublic();

    const url = `https://${DOMAIN}/`;
    const api = `https://${DOMAIN}/v1`;
    await exportEnv({
      POLYGATE_URL: url,
      POLYGATE_API_BASE: api,
      POLYGATE_DOMAIN: DOMAIN,
      POLYGATE_PASSWORD_SOURCE: "secret",
      POLYGATE_PUBLIC_OK: public_ok ? "1" : "0",
    });

    header("READY");
    log(`  Dashboard: ${url}`);
    log(`  API base : ${api}`);
    log(`  runner   : ${process.env.RUNNER_PUBLIC_IP || "?"}  (the tunnel + gateway stay direct)`);
    log(`  egress   : chosen per provider on the Routing page (Direct / WARP / proxy pool / relay)`);
    log(`  password : from the POLYGATE_ADMIN_PASSWORD (or NINE_ROUTER_PASSWORD) secret - not printed`);
    log(`  data     : ${DATA_DIR} (fresh on every run; a runner is discarded at the end)`);

    await summary([
      `### Polygate is ready`,
      ``,
      `| | |`,
      `| --- | --- |`,
      `| Dashboard | ${url} |`,
      `| API base | ${api} |`,
      `| Runner IP | ${process.env.RUNNER_PUBLIC_IP || "?"} |`,
      `| Password | the \`POLYGATE_ADMIN_PASSWORD\` / \`NINE_ROUTER_PASSWORD\` secret |`,
      `| Public probe | ${public_ok ? "answered" : "not answered yet"} |`,
      ``,
      `Open the dashboard, then **Overview -> Connect your client** to create a \`pg_...\` API key.`,
      `On **Routing**, pick Direct, Cloudflare WARP, the proxy pool or a relay if a provider limits the runner's address.`,
      ``,
    ]);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------- stop
async function stop() {
  header("Stopping Polygate");
  await sh(`sudo systemctl stop polygate || true`, { check: false });
  await sh(`sudo systemctl stop cloudflared || true`, { check: false });
  log(" Polygate and the tunnel are stopped.");
  log(" The runner is discarded, so Polygate's settings are not kept between sessions.");
}

// -------------------------------------------------------------------- run
const command = process.argv[2];
if (command === "start") await start();
else if (command === "stop") await stop();
else {
  console.error("usage: node polygate.mjs start|stop");
  process.exit(2);
}
