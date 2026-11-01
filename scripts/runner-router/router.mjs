// Runner-only 9Router: no Freestyle VM, no Tailscale exit node.
//
// Everything runs on the GitHub runner itself:
//
//   cloudflared  ──► 127.0.0.1:20128   the public entry for router2.codol.ir
//   9router      ──► systemd service (root), same data dir as before
//   awmvpn-core  ──► SOCKS5 127.0.0.1:10810 (Mozilla free VPN)
//   iptables     ──► the whole machine egresses through that SOCKS5
//
// Scope of the redirect: everything, minus the three processes that would kill
// the setup if they were sent through the tunnel:
//
//   awmvpn     its own upstream dial would loop back into redsocks
//   redsocks   same reason, one hop earlier
//   cloudflared  the public entry point: tunnelling the tunnel doubles every
//                request and turns any VPN blip into a dead domain
//
// The Actions agent (user "runner") is excluded by default too — see
// VPN_EXCLUDE_RUNNER — because it carries the job's control channel and its
// log upload. Everything else, including 9router, leaves through Mozilla.
//
// Usage: node router.mjs start | stop
//
// State still travels through the encrypted release asset, so the database the
// VM sessions archived is picked up unchanged.
import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

const PORT = Number(process.env.ROUTER_PORT || 20128);
const DOMAIN = process.env.ROUTER_DOMAIN || "router2.codol.ir";
const DATA_DIR = "/root/.9router";
const VPN_DIR = "/opt/awmvpn";
const VPN_DATA = `${VPN_DIR}/user-data`;
const VPN_PORT = Number(process.env.FXA_PROXY_PORT || 10810);
const VPN_USER = "awmvpn";
const TUNNEL_USER = "cfd";
const REDSOCKS_PORT = 12345;
const FXA_REPO = process.env.FXA_REPO || "AiWithMase/awmvpn";
const FXA_RELEASE = process.env.FXA_RELEASE || "latest";
const TRANSPORT = (process.env.FXA_TRANSPORT || "h2").toLowerCase() === "h3" ? "h3" : "h2";
const UPSTREAM = Math.max(1, Math.min(16, Number(process.env.FXA_UPSTREAM_CONNECTIONS || 4)));
const FREE_COUNTRIES = ["ar", "au", "de", "jp", "us", "za"];

// "Whole machine" still has to leave the job's own control channel alone: if the
// agent cannot reach github.com the run is declared lost and everything above is
// thrown away. Set VPN_EXCLUDE_RUNNER=false to send it through the tunnel too.
const EXCLUDE_RUNNER = (process.env.VPN_EXCLUDE_RUNNER ?? "true").toLowerCase() !== "false";

const CF = {
  token: (process.env.CF_API_TOKEN || "").trim(),
  zone: (process.env.CF_ZONE_ID || "").trim(),
  tunnelToken: (process.env.CF_TUNNEL_TOKEN || "").trim(),
  tunnelName: process.env.CF_TUNNEL_NAME || "router2",
};

const BACKUP = {
  tag: process.env.BACKUP_RELEASE_TAG || "router-backup",
  asset: process.env.BACKUP_ASSET_NAME || "9router-state.tar.gz.enc",
  prevAsset: process.env.BACKUP_PREV_NAME || "9router-state.prev.tar.gz.enc",
  repo: process.env.GITHUB_REPOSITORY || "daschera1492/hichvaght",
  token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
  passphrase: process.env.BACKUP_ENCRYPTION_KEY || "",
};

const log = (...a) => console.log(...a);
const header = (t) => console.log(`\n${"=".repeat(62)}\n${t}\n${"=".repeat(62)}`);

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
          // Never echo the environment: it carries the tunnel token.
          reject(new Error(`command failed (exit ${err.code ?? "?"}):\n${cmd}\n--- output ---\n${out}`));
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

// ------------------------------------------------------------------ backup
function backupKey() {
  if (!BACKUP.passphrase) throw new Error("BACKUP_ENCRYPTION_KEY is not set");
  return scryptSync(BACKUP.passphrase, "9router-backup-v1", 32);
}

function seal(bytes) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", backupKey(), iv);
  const body = Buffer.concat([c.update(Buffer.from(bytes)), c.final()]);
  return Buffer.concat([Buffer.from("9RB1"), iv, c.getAuthTag(), body]);
}

function unseal(bytes) {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 4).toString("latin1") !== "9RB1") throw new Error("backup has an unknown format");
  const iv = b.subarray(4, 16), tag = b.subarray(16, 32), body = b.subarray(32);
  const d = createDecipheriv("aes-256-gcm", backupKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]);
}

const ghHeaders = (extra = {}) => ({
  Authorization: `Bearer ${BACKUP.token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "runner-router-backup",
  ...extra,
});

async function findRelease() {
  const res = await fetch(`https://api.github.com/repos/${BACKUP.repo}/releases/tags/${BACKUP.tag}`, {
    headers: ghHeaders(),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`cannot read release: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function ensureRelease() {
  const found = await findRelease();
  if (found) return found;
  const res = await fetch(`https://api.github.com/repos/${BACKUP.repo}/releases`, {
    method: "POST",
    headers: ghHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      tag_name: BACKUP.tag,
      name: "9Router state backup",
      body: "Encrypted 9router state written by the lifecycle workflows. Do not delete manually.",
      draft: false,
      prerelease: false,
    }),
  });
  if (!res.ok) throw new Error(`cannot create release: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function uploadAsset(name, bytes) {
  const release = await ensureRelease();
  for (const a of (release.assets || []).filter((x) => x.name === name)) {
    await fetch(`https://api.github.com/repos/${BACKUP.repo}/releases/assets/${a.id}`, {
      method: "DELETE",
      headers: ghHeaders(),
    });
  }
  const res = await fetch(
    `https://uploads.github.com/repos/${BACKUP.repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
    { method: "POST", headers: ghHeaders({ "Content-Type": "application/octet-stream" }), body: bytes },
  );
  if (!res.ok) throw new Error(`cannot upload ${name}: HTTP ${res.status} ${await res.text()}`);
  log(`• Upload: ${name} (${(bytes.length / 1024).toFixed(1)} KiB)`);
}

async function downloadAsset(name) {
  const release = await findRelease();
  if (!release) return null;
  const asset = (release.assets || []).find((x) => x.name === name);
  if (!asset) return null;
  const res = await fetch(`https://api.github.com/repos/${BACKUP.repo}/releases/assets/${asset.id}`, {
    headers: ghHeaders({ Accept: "application/octet-stream" }),
    redirect: "manual",
  });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location");
    if (!loc) throw new Error("asset redirect had no location");
    const blob = await fetch(loc);
    if (!blob.ok) throw new Error(`cannot fetch asset body: HTTP ${blob.status}`);
    return Buffer.from(await blob.arrayBuffer());
  }
  if (!res.ok) throw new Error(`cannot download ${name}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
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

// A GitHub runner has no public inbound port. The domain can only reach it
// through a tunnel the runner itself dials out, so one of two things has to be
// true before 9router is worth starting:
//
//   1. CF_TUNNEL_TOKEN already exists (tunnel created by hand in the dashboard), or
//   2. CF_API_TOKEN may manage tunnels, in which case the tunnel, its ingress
//      rule and the DNS record are all created here — no dashboard work at all.
async function ensureTunnelToken() {
  if (CF.tunnelToken) {
    log("• Tunnel: using the existing CF_TUNNEL_TOKEN");
    return CF.tunnelToken;
  }
  if (!CF.token) {
    throw new Error(
      `Neither CF_TUNNEL_TOKEN nor CF_API_TOKEN is set. A GitHub runner has no public inbound ` +
        `port, so ${DOMAIN} can only reach it through a Cloudflare Tunnel.`,
    );
  }

  log("• Tunnel: no CF_TUNNEL_TOKEN — provisioning one through the Cloudflare API…");
  let accountId;
  try {
    const accounts = await cf("/accounts");
    accountId = accounts?.[0]?.id;
  } catch (err) {
    throw new Error(
      `CF_API_TOKEN cannot list accounts (${err.message}). Either give it "Account: Read" + ` +
        `"Cloudflare Tunnel: Edit", or create the tunnel by hand: Zero Trust → Networks → ` +
        `Tunnels → Create, public hostname ${DOMAIN} → http://localhost:${PORT}, then store its ` +
        `token as CF_TUNNEL_TOKEN.`,
    );
  }
  if (!accountId) throw new Error("CF_API_TOKEN has no account to create the tunnel in");

  let tunnel = (await cf(`/accounts/${accountId}/cfd_tunnel?name=${encodeURIComponent(CF.tunnelName)}&is_deleted=false`))?.[0];
  if (tunnel) {
    log(`• Tunnel: reusing "${CF.tunnelName}" (${tunnel.id})`);
  } else {
    tunnel = await cf(`/accounts/${accountId}/cfd_tunnel`, {
      method: "POST",
      body: JSON.stringify({ name: CF.tunnelName, config_src: "cloudflare" }),
    });
    log(`• Tunnel: created "${CF.tunnelName}" (${tunnel.id})`);
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
  log(`• Tunnel: ingress ${DOMAIN} → http://localhost:${PORT}`);

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
  log(`• Tunnel: DNS ${DOMAIN} → CNAME ${record.content} (proxied)`);

  return await cf(`/accounts/${accountId}/cfd_tunnel/${tunnel.id}/token`);
}

async function startTunnel() {
  const token = await ensureTunnelToken();

  log("• Tunnel: installing cloudflared…");
  await must(
    `if ! command -v cloudflared >/dev/null 2>&1; then
       curl -fsSL -o /tmp/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
       sudo install -m 0755 /tmp/cloudflared /usr/local/bin/cloudflared
       rm -f /tmp/cloudflared
     fi
     cloudflared --version`,
    { timeout: 300_000 },
  );

  // cloudflared gets a uid of its own so the redirect can leave it alone. The
  // service installer writes a unit without User=, so patch it afterwards.
  log(`• Tunnel: running the service as "${TUNNEL_USER}"…`);
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

// Checked after 9router is listening, not before: the tunnel would otherwise
// answer 502 for the whole wait and prove nothing.
async function verifyPublic() {
  log(`• Tunnel: waiting for https://${DOMAIN}/dashboard to answer…`);
  for (let i = 1; i <= 30; i++) {
    const r = await sh(
      `curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://${DOMAIN}/dashboard`,
      { check: false, timeout: 30_000 },
    );
    const code = r.out.trim();
    if (/^(2|3)\d\d$/.test(code)) {
      log(`    ${DOMAIN} answers ${code} after ${i * 3}s`);
      return true;
    }
    if (i === 1 || i % 5 === 0) log(`    ${DOMAIN} -> ${code || "no answer"} (${i * 3}s)`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  log("    the tunnel is up but the public hostname has not answered yet");
  return false;
}

// ---------------------------------------------------------------- 9router
async function installRouter() {
  log("• 9router: running the existing bootstrap (install + systemd unit)…");
  const script = join(repoRoot, "scripts", "freestyle-router", "bootstrap.sh");
  await readFile(script, "utf8"); // fail early with a clear error if it is missing
  const out = await must(`sudo bash ${script}`, {
    env: { ROUTER_PORT: String(PORT), NINE_ROUTER_PASSWORD: process.env.NINE_ROUTER_PASSWORD },
    timeout: 900_000,
  });
  for (const line of out.split("\n").slice(-12).filter(Boolean)) log(`    ${line}`);
}

async function restoreState() {
  const wantBackup = (process.env.RESTORE_BACKUP ?? "true").toLowerCase() !== "false";
  if (!wantBackup) {
    log("• State: fresh start requested — archive ignored");
    return;
  }
  if (!BACKUP.token || !BACKUP.passphrase) {
    log("• State: backup is not configured (BACKUP_ENCRYPTION_KEY / GITHUB_TOKEN) — starting empty");
    return;
  }
  const latest = await downloadAsset(BACKUP.asset).catch(() => null);
  const prev = latest ? null : await downloadAsset(BACKUP.prevAsset).catch(() => null);
  const candidate = latest ?? prev;
  if (!candidate) {
    log("• State: nothing archived yet — starting empty");
    return;
  }
  const tar = unseal(candidate);
  const dir = await mkdtemp(join(tmpdir(), "9r-"));
  const file = join(dir, "state.tar.gz");
  await writeFile(file, tar);
  log(`• State: restoring ${(tar.length / 1024).toFixed(1)} KiB…`);
  const out = await must(`
    set -e
    sudo systemctl stop 9router || true
    sudo rm -rf ${DATA_DIR}/db
    sudo tar xzf ${file} -C ${DATA_DIR}
    if [ ! -f ${DATA_DIR}/db/data.sqlite ] && [ -f ${DATA_DIR}/9router-export.json ]; then
      sudo cp ${DATA_DIR}/9router-export.json ${DATA_DIR}/db.json
      sudo rm -f ${DATA_DIR}/.migrated-from-json
    fi
    [ -f ${DATA_DIR}/jwt-secret ] && sudo chmod 600 ${DATA_DIR}/jwt-secret
    sudo systemctl start 9router
    for i in $(seq 1 90); do
      code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${PORT}/dashboard || true)
      case "$code" in 2*|3*) echo "restored database answers after \${i}s"; exit 0;; esac
      sleep 1
    done
    echo "the restored database did not start"
    exit 1
  `);
  for (const line of out.split("\n").filter(Boolean)) log(`    ${line}`);
  await rm(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------- vpn
async function installVpn() {
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const asset = `awmvpn-core-linux-${arch}.tar.gz`;
  const url =
    FXA_RELEASE === "latest"
      ? `https://github.com/${FXA_REPO}/releases/latest/download/${asset}`
      : `https://github.com/${FXA_REPO}/releases/download/${FXA_RELEASE}/${asset}`;
  log(`• VPN: downloading ${asset}…`);
  const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "runner-router" } });
  if (!res.ok) throw new Error(`cannot download ${url}: HTTP ${res.status}`);
  const dir = await mkdtemp(join(tmpdir(), "fxa-"));
  const tarPath = join(dir, "core.tar.gz");
  await writeFile(tarPath, Buffer.from(await res.arrayBuffer()));

  const b64 = (process.env.FXA_ACCOUNTS_TGZ_B64 || "").trim();
  if (!b64) {
    throw new Error(
      "FXA_ACCOUNTS_TGZ_B64 is not set. Sign in once with `awmvpn-core -add-account`, then " +
        "tar czf accounts.tar.gz -C <data-dir> accounts && base64 -w0 accounts.tar.gz",
    );
  }
  const accPath = join(dir, "accounts.tar.gz");
  await writeFile(accPath, Buffer.from(b64, "base64"));

  const out = await must(`
    set -e
    id -u ${VPN_USER} >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin ${VPN_USER}
    sudo mkdir -p ${VPN_DIR} ${VPN_DATA}
    sudo tar xzf ${tarPath} -C ${VPN_DIR} --strip-components=1
    sudo chmod 0755 ${VPN_DIR}/awmvpn-core
    sudo tar xzf ${accPath} -C ${VPN_DATA}
    sudo chown -R ${VPN_USER}:${VPN_USER} ${VPN_DATA}
    sudo chmod 600 ${VPN_DATA}/accounts/secret.key
    echo -n "version: "; ${VPN_DIR}/awmvpn-core -version
  `, { timeout: 300_000 });
  for (const line of out.split("\n").filter(Boolean)) log(`    ${line}`);
  await rm(dir, { recursive: true, force: true });
}

function vpnConfig(country) {
  return JSON.stringify(
    {
      version: 2,
      proxy: {
        listen: `127.0.0.1:${VPN_PORT}`,
        username: "router",
        password: process.env.FXA_PROXY_PASS || "routerpass",
        country,
        transport: TRANSPORT,
        // One upstream connection multiplexes every TCP flow through a single
        // HTTP/2 stream to the edge, which serialises concurrent requests. A
        // handful of them keeps parallel AI calls from queueing behind each
        // other — this is the knob that made the old whole-VM setup feel slow.
        upstream_connections: UPSTREAM,
        max_connections: 512,
        idle_sleep: "0s",
      },
      dashboard: { enabled: true, listen: "127.0.0.1:10820" },
      routing: { enabled: false, region: "" },
    },
    null,
    2,
  );
}

async function startVpn(country) {
  const dir = await mkdtemp(join(tmpdir(), "fxac-"));
  const cfg = join(dir, "config.json");
  await writeFile(cfg, vpnConfig(country));
  const unit = `[Unit]
Description=AWMVPN core (Mozilla free VPN client)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${VPN_USER}
Group=${VPN_USER}
ExecStart=${VPN_DIR}/awmvpn-core -data-dir ${VPN_DATA} -plain
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
`;
  const unitPath = join(dir, "awmvpn.service");
  await writeFile(unitPath, unit);
  await must(`
    set -e
    sudo install -m 600 -o ${VPN_USER} -g ${VPN_USER} ${cfg} ${VPN_DATA}/config.json
    sudo install -m 644 -o root -g root ${unitPath} /etc/systemd/system/awmvpn.service
    sudo systemctl daemon-reload
    sudo systemctl enable awmvpn >/dev/null 2>&1 || true
    sudo systemctl restart awmvpn
    sleep 2
    systemctl is-active awmvpn
  `);
  await rm(dir, { recursive: true, force: true });
}

async function vpnProbe() {
  const r = await sh(
    `curl -s --max-time 15 --socks5-hostname 127.0.0.1:${VPN_PORT} ` +
      `--proxy-user 'router:${process.env.FXA_PROXY_PASS || "routerpass"}' https://api.ipify.org`,
    { check: false, timeout: 60_000 },
  );
  const ip = r.out.trim();
  return /^[0-9a-fA-F:.]{3,45}$/.test(ip) ? { ok: true, ip } : { ok: false, detail: ip };
}

function pickLocations() {
  const want = (process.env.FXA_COUNTRY || "").trim().toLowerCase();
  if (want && want !== "random") return [want === "auto" ? "" : want];
  const pool = [...FREE_COUNTRIES];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Number(process.env.FXA_TRIES || 3));
}

async function bringUpVpn() {
  await installVpn();
  for (const country of pickLocations()) {
    log(`• VPN: trying location ${country || "auto"}`);
    await startVpn(country);
    for (let i = 1; i <= 12; i++) {
      const p = await vpnProbe();
      if (p.ok) {
        log(`    tunnel up after ${i} probe(s) — exit IP ${p.ip}`);
        return { country, ip: p.ip };
      }
      if (i === 1 || i % 3 === 0) log(`    probe ${i}/12: ${(p.detail || "no answer").slice(0, 100)}`);
      await new Promise((r) => setTimeout(r, 8000));
    }
    const st = await sh(`sudo ${VPN_DIR}/awmvpn-core -status -data-dir ${VPN_DATA} 2>&1 | head -12`, {
      check: false,
    });
    for (const line of st.out.split("\n").filter(Boolean)) log(`    ${line}`);
  }
  throw new Error("AWMVPN never produced a working tunnel (account needs a sign-in, or Guardian refuses the region)");
}

// ------------------------------------------------- redirect: whole machine
async function redirectEverything(expectedIp, runnerIp) {
  log("• Redirect: whole machine through the VPN (except the tunnel and the VPN itself)…");
  const out = await must(`
    set -e
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq redsocks iptables >/dev/null
    sudo tee /etc/redsocks.conf >/dev/null <<CONF
base {
  log_debug = off;
  log_info = on;
  daemon = on;
  redirector = iptables;
}
redsocks {
  local_ip = 127.0.0.1;
  local_port = ${REDSOCKS_PORT};
  ip = 127.0.0.1;
  port = ${VPN_PORT};
  type = socks5;
  login = "router";
  password = "\${FXA_PASS}";
}
CONF
    sudo systemctl enable redsocks >/dev/null 2>&1 || true
    sudo systemctl restart redsocks
    sleep 1
    systemctl is-active redsocks
  `, { env: { FXA_PASS: process.env.FXA_PROXY_PASS || "routerpass" }, timeout: 420_000 });
  for (const line of out.split("\n").filter(Boolean)) log(`    ${line}`);

  const r = await sh(`
    set -e
    VPN_UID=$(id -u ${VPN_USER})
    RS_UID=$(id -u redsocks)
    CFD_UID=$(id -u ${TUNNEL_USER})
    RUNNER_UID=$(id -u runner 2>/dev/null || echo "")

    # -m owner is the only way to exempt a process from the redirect, and
    # iptables-nft does not autoload xt_owner on every kernel. Probe it and use
    # whichever backend actually accepts the match; a chain with the owner rules
    # silently missing looks fine now and turns the tunnel into a loop on the
    # first reconnect.
    modprobe xt_owner 2>/dev/null || true
    probe_owner() {
      $1 -t nat -N AWMVPNT 2>/dev/null || $1 -t nat -F AWMVPNT 2>/dev/null
      $1 -t nat -A AWMVPNT -m owner --uid-owner 0 -j RETURN 2>/dev/null
      rc=$?
      $1 -t nat -F AWMVPNT 2>/dev/null
      $1 -t nat -X AWMVPNT 2>/dev/null
      return $rc
    }
    IPT=""
    for c in iptables iptables-legacy; do
      command -v $c >/dev/null 2>&1 || continue
      if probe_owner $c; then IPT=$c; echo "owner matching: $c"; break; fi
      echo "owner matching: $c unavailable"
    done
    if [ -z "$IPT" ]; then
      echo "RESULT=unsupported"
      exit 0
    fi

    revert() {
      for c in "$IPT" iptables iptables-legacy; do
        command -v $c >/dev/null 2>&1 || continue
        $c -t nat -D OUTPUT -j AWMVPN 2>/dev/null || true
        $c -t nat -F AWMVPN 2>/dev/null || true
        $c -t nat -X AWMVPN 2>/dev/null || true
      done
    }

    revert
    $IPT -t nat -N AWMVPN
    for net in 127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10; do
      $IPT -t nat -A AWMVPN -d $net -j RETURN
    done
    $IPT -t nat -A AWMVPN -m owner --uid-owner $VPN_UID -j RETURN
    $IPT -t nat -A AWMVPN -m owner --uid-owner $RS_UID -j RETURN
    $IPT -t nat -A AWMVPN -m owner --uid-owner $CFD_UID -j RETURN
    if [ "${EXCLUDE_RUNNER}" = "true" ] && [ -n "$RUNNER_UID" ]; then
      $IPT -t nat -A AWMVPN -m owner --uid-owner $RUNNER_UID -j RETURN
    fi
    $IPT -t nat -A AWMVPN -p tcp -j REDIRECT --to-ports ${REDSOCKS_PORT}
    $IPT -t nat -I OUTPUT 1 -j AWMVPN
    echo "rules: $($IPT -t nat -S AWMVPN | wc -l) lines, owner: $($IPT -t nat -S AWMVPN | grep -c owner)"

    # root is the redirected case (9router runs as root); the runner user is the
    # exempt case. Both must be checked, because "everything works" only means
    # something if the two paths actually differ.
    probe() { sudo curl -s --max-time 20 https://api.ipify.org || true; }
    probe_as_runner() { sudo -u runner curl -s --max-time 20 https://api.ipify.org 2>/dev/null || true; }

    ROOT_IP=""
    for i in $(seq 1 8); do
      ROOT_IP=$(probe)
      echo "root probe $i egress=\${ROOT_IP:-none}"
      [ -n "$ROOT_IP" ] && break
      sleep 3
    done
    RUN_IP=$(probe_as_runner)
    echo "runner probe egress=\${RUN_IP:-none}"

    EXPECTED="${expectedIp}"
    RUNNER="${runnerIp}"

    if [ -z "$ROOT_IP" ]; then
      echo "the redirected machine has no egress — reverting"
      revert
      echo "RESULT=failed no_egress"
      exit 0
    fi
    if [ -n "$RUNNER" ] && [ "$ROOT_IP" = "$RUNNER" ]; then
      echo "egress is still the runner IP ($ROOT_IP) — the redirect is not in effect, reverting"
      revert
      echo "RESULT=failed still_runner_ip=$ROOT_IP"
      exit 0
    fi
    if [ "${EXCLUDE_RUNNER}" = "true" ] && [ -n "$RUNNER" ] && [ "$RUN_IP" = "$ROOT_IP" ]; then
      echo "warning: the exempt user is also on the VPN IP ($RUN_IP) — the owner rules are not matching"
    fi

    # A first probe proves nothing on its own: the tunnel was opened before these
    # rules existed, so its upstream connection is already established and never
    # passes nat/OUTPUT again. Restart it so it dials out through the new chain —
    # that is the real test that the owner exclusions hold.
    echo "restarting the VPN to force a reconnect through the redirect"
    sudo systemctl restart awmvpn
    ROOT_IP2=""
    for i in $(seq 1 8); do
      sleep 5
      ROOT_IP2=$(probe)
      echo "post-restart probe $i egress=\${ROOT_IP2:-none}"
      [ -n "$ROOT_IP2" ] && break
    done
    if [ -z "$ROOT_IP2" ] || { [ -n "$RUNNER" ] && [ "$ROOT_IP2" = "$RUNNER" ]; }; then
      echo "the tunnel does not survive a reconnect through the redirect — reverting"
      revert
      sudo systemctl restart awmvpn
      echo "RESULT=failed reconnect=\${ROOT_IP2:-none}"
      exit 0
    fi
    if [ -n "$EXPECTED" ] && [ "$ROOT_IP2" != "$EXPECTED" ]; then
      echo "note: egress $ROOT_IP2 differs from the VPN exit IP $EXPECTED"
    fi
    echo "RESULT=ok egress=$ROOT_IP2 exempt=\${RUN_IP:-none}"
  `, { check: false, timeout: 420_000 });

  for (const line of r.out.split("\n").filter(Boolean)) log(`    ${line}`);
  const m = r.out.match(/RESULT=(\w+)/);
  if (!m) return false;
  if (m[1] === "unsupported") {
    log("    this kernel cannot match a process owner in iptables (no xt_owner), so the VPN");
    log("    cannot be exempted from its own redirect — refusing to apply it.");
    return false;
  }
  return m[1] === "ok";
}

// ------------------------------------------------------------------ start
async function start() {
  header(`9Router on the runner — ${DOMAIN}`);
  for (const [name, value] of Object.entries({
    NINE_ROUTER_PASSWORD: process.env.NINE_ROUTER_PASSWORD,
  })) {
    if (!value) throw new Error(`${name} is not set`);
  }

  await startTunnel();
  await installRouter();
  await restoreState();
  await verifyPublic();

  const vpn = await bringUpVpn();
  const redirected = await redirectEverything(vpn.ip, process.env.RUNNER_PUBLIC_IP || "");

  const socks = `socks5h://router:${process.env.FXA_PROXY_PASS || "routerpass"}@127.0.0.1:${VPN_PORT}`;
  await exportEnv({
    FXA_SOCKS5: socks,
    FXA_COUNTRY: vpn.country || "auto",
    FXA_EXIT_IP: vpn.ip,
    FXA_VPN_ACTIVE: "1",
    FXA_VPN_SCOPE: redirected ? "whole-machine" : "vpn-only",
  });

  header("READY");
  log(`  URL      : https://${DOMAIN}/dashboard`);
  log(`  runner   : ${process.env.RUNNER_PUBLIC_IP || "?"} (exempt: tunnel + agent)`);
  log(`  egress   : ${redirected ? `whole machine → VPN exit ${vpn.ip} (${vpn.country || "auto"})` : `VPN only — 9router keeps the runner IP`}`);
  log(`  SOCKS5   : 127.0.0.1:${VPN_PORT} (user router, password is per-run and not printed)`);
  log(`  data     : ${DATA_DIR}`);
}

// ------------------------------------------------------------------- stop
async function stop() {
  header("Archive 9router state");
  if (!BACKUP.token || !BACKUP.passphrase) {
    log("• Backup is not configured — nothing archived");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "9r-stop-"));
  const file = join(dir, "state.tar.gz");
  try {
    const out = await must(`
      set -e
      sudo systemctl stop 9router || true
      # A start that failed before the install finished must not turn the
      # always() archive step into a second, unrelated failure.
      if [ ! -d ${DATA_DIR} ]; then echo "NO_DATA_DIR"; exit 0; fi
      cd ${DATA_DIR}
      sudo tar czf ${file} db 9router-export.json jwt-secret 2>/dev/null || sudo tar czf ${file} db
      sudo chmod 644 ${file}
      ls -l ${file}
    `, { timeout: 300_000 });
    for (const line of out.split("\n").filter(Boolean)) log(`    ${line}`);

    const tar = await readFile(file).catch(() => null);
    if (!tar) {
      log("• Nothing to archive");
      return;
    }
    if (tar.length < 4096) {
      log(`• Archive is only ${tar.length} bytes — refusing to overwrite the last good backup`);
      return;
    }
    const sealed = seal(tar);
    const current = await downloadAsset(BACKUP.asset).catch(() => null);
    if (current && current.length > 4096) await uploadAsset(BACKUP.prevAsset, current);
    await uploadAsset(BACKUP.asset, sealed);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await sh(`sudo systemctl start 9router || true`, { check: false });
  }
}

// -------------------------------------------------------------------- run
const command = process.argv[2];
if (command === "start") await start();
else if (command === "stop") await stop();
else {
  console.error("usage: node router.mjs start|stop");
  process.exit(2);
}
