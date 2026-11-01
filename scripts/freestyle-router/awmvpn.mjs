// AWMVPN: bring Mozilla's free VPN (the awmvpn-core client) up inside the
// 9Router VM and make the WHOLE VM egress through it.
//
// Two layers, applied in this order:
//
//   1. awmvpn-core listens as an authenticated SOCKS5/HTTP proxy on
//      127.0.0.1:10810 and tunnels everything to Mozilla's Fastly edge.
//   2. redsocks + an iptables NAT chain (AWMVPN) redirect every locally
//      generated TCP connection into that SOCKS5, so programs inside the VM
//      need no proxy setting at all — the VM behaves like a device connected to
//      the VPN. Loopback, private ranges (Freestyle's control channel and the
//      Tailscale exit node) and the VPN's own traffic stay direct.
//
// Runs AFTER start.mjs on purpose:
//   start.mjs has already created the VM, installed 9router and pointed ALL of
//   the VM's traffic at the runner's Tailscale exit node. Only then do the
//   Firefox Accounts and Guardian calls leave from the runner's clean IP —
//   from Freestyle's own datacenter address Guardian answers 451
//   (RegionUnavailable) and FxA flags the sign-in as unusual.
//
// What this file does NOT do: create Firefox Accounts. It restores them from
// the FXA_ACCOUNTS_TGZ_B64 secret — a tar.gz of a `user-data/accounts` folder
// holding credentials.json + secret.key. Sign in once on your own machine
// (`awmvpn-core -add-account`), tar that folder, base64 it, store it as a
// secret, and every session reuses it without a browser or an emailed code.
//
// Layout it installs (portable, next to the binary):
//   /opt/awmvpn/awmvpn-core
//   /opt/awmvpn/user-data/{config.json,accounts/...}
//
// Environment:
//   FXA_ACCOUNTS_TGZ_B64  base64 of the accounts archive (required)
//   FXA_COUNTRY           country code, "auto" for Mozilla's REC location, or
//                         empty/random to try up to 3 random free locations
//   FXA_TRANSPORT         h2 (default) or h3
//   FXA_PROXY_PORT        default 10810
//   FXA_PROXY_USER/PASS   proxy login (a random password is generated if empty)
//   FXA_RELEASE           release tag, default "latest"
//   FXA_TRIES             how many locations to try, default 3
//   FXA_TRANSPARENT       "0" leaves the VM's routing alone (SOCKS5 only)
import { appendFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import {
  CONFIG,
  client,
  ensureRunning,
  header,
  log,
  run,
  sleep,
  tryRun,
} from "./lib.mjs";

const REPO = process.env.FXA_REPO || "AiWithMase/awmvpn";
const RELEASE = process.env.FXA_RELEASE || "latest";
const INSTALL_DIR = process.env.FXA_INSTALL_DIR || "/opt/awmvpn";
const DATA_DIR = `${INSTALL_DIR}/user-data`;
const SERVICE = "awmvpn";
const RUN_USER = "awmvpn";
const REDSOCKS_PORT = 12345;
const PROXY_PORT = Number(process.env.FXA_PROXY_PORT || 10810);
const DASH_PORT = Number(process.env.FXA_DASHBOARD_PORT || 10820);
const TRANSPORT = (process.env.FXA_TRANSPORT || "h2").toLowerCase() === "h3" ? "h3" : "h2";
const PROXY_USER = process.env.FXA_PROXY_USER || "router";
// Hex only: it goes into a shell command, a config file and a redsocks.conf,
// so nothing that needs quoting can ever appear in it.
const PROXY_PASS = process.env.FXA_PROXY_PASS || randomBytes(12).toString("hex");
const TRIES = Math.max(1, Number(process.env.FXA_TRIES || 3));
const TRANSPARENT = (process.env.FXA_TRANSPARENT ?? "1") !== "0";

// The countries a FREE Firefox account can actually connect to (the Plus-only
// ones are rejected by Guardian for free accounts).
const FREE_COUNTRIES = ["ar", "au", "de", "jp", "us", "za"];

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// ------------------------------------------------------------------ VM
async function ensureVm() {
  const freestyle = client();
  const list = await freestyle.vms.list();
  const found = (list.vms ?? []).find((v) => v.slug === CONFIG.slug && v.state !== "stopped");
  if (!found) {
    throw new Error(`VM "${CONFIG.slug}" does not exist — run start.mjs first (it creates the VM)`);
  }
  const vm = freestyle.vms.ref(found.id);
  const data = await ensureRunning(freestyle, vm);
  log(`• VM: ${data.id} state=${data.state} slug=${data.slug}`);
  return vm;
}

// ---------------------------------------------------------------- core
// The service runs as an unprivileged user on purpose: the transparent redirect
// below must be able to let the VPN's own upstream connections out untouched
// (`-m owner --uid-owner`), and that needs a uid of its own.
async function installCore(vm) {
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const asset = `awmvpn-core-linux-${arch}.tar.gz`;
  const url =
    RELEASE === "latest"
      ? `https://github.com/${REPO}/releases/latest/download/${asset}`
      : `https://github.com/${REPO}/releases/download/${RELEASE}/${asset}`;

  // Downloaded on the runner, not in the guest: the runner has a plain, fast
  // internet path, and the VM's egress is already going through the exit node.
  log(`• Core: downloading ${asset} (${RELEASE}) on the runner…`);
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": "9router-awmvpn" },
  });
  if (!res.ok) throw new Error(`cannot download ${url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  log(`• Core: ${(bytes.length / 1048576).toFixed(1)} MiB — pushing into the VM…`);
  await vm.fs.writeFile("/tmp/awmvpn-core.tar.gz", bytes);

  const out = await run(
    vm,
    `set -e
id -u ${RUN_USER} >/dev/null 2>&1 || sudo useradd --system --no-create-home \\
  --home-dir ${INSTALL_DIR} --shell /usr/sbin/nologin ${RUN_USER}
sudo mkdir -p ${INSTALL_DIR} ${DATA_DIR}
sudo tar xzf /tmp/awmvpn-core.tar.gz -C ${INSTALL_DIR} --strip-components=1
sudo chmod 0755 ${INSTALL_DIR}/awmvpn-core
sudo chown -R ${RUN_USER}:${RUN_USER} ${DATA_DIR}
sudo rm -f /tmp/awmvpn-core.tar.gz
echo -n "version: "; ${INSTALL_DIR}/awmvpn-core -version
echo -n "uid:     "; id -u ${RUN_USER}
`,
    300_000,
  );
  for (const line of out.split("\n").filter(Boolean)) log(`    ${line}`);
}

// ------------------------------------------------------------ accounts
async function restoreAccounts(vm) {
  const b64 = (process.env.FXA_ACCOUNTS_TGZ_B64 || "").trim();
  if (!b64) {
    throw new Error(
      "FXA_ACCOUNTS_TGZ_B64 is not set. Sign in once with `awmvpn-core -add-account`, " +
        "then: tar czf accounts.tar.gz -C <data-dir> accounts && base64 -w0 accounts.tar.gz",
    );
  }
  const tar = Buffer.from(b64, "base64");
  if (tar.length < 100) throw new Error("FXA_ACCOUNTS_TGZ_B64 does not decode to a tar.gz");
  log(`• Accounts: restoring ${(tar.length / 1024).toFixed(1)} KiB from the secret…`);
  await vm.fs.writeFile("/tmp/fxa-accounts.tar.gz", new Uint8Array(tar));

  const out = await run(
    vm,
    `set -e
sudo tar xzf /tmp/fxa-accounts.tar.gz -C ${DATA_DIR}
sudo rm -f /tmp/fxa-accounts.tar.gz
sudo chown -R ${RUN_USER}:${RUN_USER} ${DATA_DIR}
sudo chmod 600 ${DATA_DIR}/accounts/secret.key
echo -n "accounts: "; sudo bash -c 'ls -1 ${DATA_DIR}/accounts | grep -v secret.key | wc -l'
`,
    180_000,
  );
  for (const line of out.split("\n").filter(Boolean)) log(`    ${line}`);
  // An account with no secret.key cannot be decrypted: fail here, with a clear
  // message, instead of later as a mysterious "no account" tunnel failure.
  const check = await tryRun(vm, `sudo test -f ${DATA_DIR}/accounts/secret.key && echo ok`);
  if (check.out.trim() !== "ok") throw new Error("the archive has no accounts/secret.key");
}

// -------------------------------------------------------------- config
// Only the fields we care about are written; everything omitted keeps the
// program's default (the config loader fills missing fields in).
function configFor(country) {
  return JSON.stringify(
    {
      version: 2,
      proxy: {
        listen: `127.0.0.1:${PROXY_PORT}`,
        username: PROXY_USER,
        password: PROXY_PASS,
        country,
        transport: TRANSPORT,
        upstream_connections: 1,
        max_connections: 256,
        // Never sleep: the whole point is that the VM can call it at any time.
        idle_sleep: "0s",
      },
      dashboard: { enabled: true, listen: `127.0.0.1:${DASH_PORT}` },
      routing: { enabled: false, region: "" },
    },
    null,
    2,
  );
}

async function writeConfig(vm, country) {
  await vm.fs.writeTextFile("/tmp/awmvpn-config.json", configFor(country));
  await run(
    vm,
    `set -e
sudo install -m 600 -o ${RUN_USER} -g ${RUN_USER} /tmp/awmvpn-config.json ${DATA_DIR}/config.json
sudo rm -f /tmp/awmvpn-config.json
`,
    60_000,
  );
}

async function restartService(vm) {
  const unit = `[Unit]
Description=AWMVPN core (Mozilla free VPN client)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_USER}
ExecStart=${INSTALL_DIR}/awmvpn-core -data-dir ${DATA_DIR} -plain
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
`;
  await vm.fs.writeTextFile("/tmp/awmvpn.service", unit);
  await run(
    vm,
    `set -e
sudo install -m 644 -o root -g root /tmp/awmvpn.service /etc/systemd/system/${SERVICE}.service
sudo rm -f /tmp/awmvpn.service
sudo systemctl daemon-reload
sudo systemctl enable ${SERVICE} >/dev/null 2>&1 || true
sudo systemctl restart ${SERVICE}
sleep 2
sudo systemctl is-active ${SERVICE}
`,
    120_000,
  );
}

// --------------------------------------------------------------- probe
// The only real success signal: an HTTPS request answered from inside the
// tunnel. `-status` prints "connected" earlier, because the upstream session is
// opened lazily on first use.
async function probe(vm) {
  const r = await tryRun(
    vm,
    `curl -s --max-time 15 --socks5-hostname 127.0.0.1:${PROXY_PORT} ` +
      `--proxy-user ${sq(`${PROXY_USER}:${PROXY_PASS}`)} https://api.ipify.org`,
    60_000,
  );
  const ip = r.out.trim();
  if (r.statusCode !== 0) return { ok: false, detail: ip || `curl exit ${r.statusCode}` };
  if (!/^[0-9a-fA-F:.]{3,45}$/.test(ip)) return { ok: false, detail: ip || "empty answer" };
  return { ok: true, ip };
}

async function waitForTunnel(vm, attempts = 12) {
  for (let i = 1; i <= attempts; i++) {
    const p = await probe(vm);
    if (p.ok) {
      log(`    tunnel up after ${i} probe(s) — exit IP ${p.ip}`);
      return p;
    }
    if (i === 1 || i % 3 === 0) log(`    probe ${i}/${attempts}: ${p.detail.slice(0, 120)}`);
    await sleep(8000);
  }
  return { ok: false };
}

async function diagnostics(vm) {
  const st = await tryRun(vm, `sudo ${INSTALL_DIR}/awmvpn-core -status -data-dir ${DATA_DIR} 2>&1 | head -20`, 60_000);
  for (const line of st.out.split("\n").filter(Boolean)) log(`    ${line}`);
  const logs = await tryRun(
    vm,
    `sudo bash -c 'tail -n 15 ${DATA_DIR}/logs/*.log 2>/dev/null || journalctl -u ${SERVICE} -n 20 --no-pager 2>/dev/null'`,
    60_000,
  );
  for (const line of logs.out.split("\n").filter(Boolean)) log(`    ${line}`);
}

// ------------------------------------------------- whole-VM redirection
// redsocks takes over every redirected TCP connection and forwards it to the
// SOCKS5 above. Everything that must NOT be redirected is listed explicitly:
//   - loopback
//   - private/link-local ranges: Freestyle's control channel reaches this VM
//     from 10.x, the Tailscale exit node lives in 100.64.0.0/10, and metadata
//     in 169.254.0.0/16. Redirecting any of them would make vm.exec hang and
//     cut the VM off — the same failure mode start.mjs guards against.
//   - the VPN's own uid and redsocks' uid, otherwise the tunnel would try to
//     reach Mozilla through itself.
// UDP is left alone (redsocks is TCP only); QUIC therefore still goes direct.
async function installRedsocks(vm) {
  const conf = `base {
  log_debug = off;
  log_info = on;
  daemon = on;
  redirector = iptables;
}
redsocks {
  local_ip = 127.0.0.1;
  local_port = ${REDSOCKS_PORT};
  ip = 127.0.0.1;
  port = ${PROXY_PORT};
  type = socks5;
  login = "${PROXY_USER}";
  password = "${PROXY_PASS}";
}
`;
  await vm.fs.writeTextFile("/tmp/redsocks.conf", conf);
  const out = await run(
    vm,
    `set -e
if ! command -v redsocks >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq redsocks iptables
fi
sudo install -m 600 -o root -g root /tmp/redsocks.conf /etc/redsocks.conf
sudo rm -f /tmp/redsocks.conf
sudo systemctl enable redsocks >/dev/null 2>&1 || true
sudo systemctl restart redsocks
sleep 1
sudo systemctl is-active redsocks
`,
    420_000,
  );
  for (const line of out.split("\n").filter(Boolean)) log(`    ${line}`);
}

async function applyTransparent(vm, expectedIp) {
  const uids = await tryRun(vm, `echo "$(id -u ${RUN_USER}) $(id -u redsocks 2>/dev/null || echo 0)"`);
  const [vpnUid, redsocksUid] = uids.out.trim().split(/\s+/);
  if (!vpnUid) throw new Error("cannot read the VPN user's uid");

  const runnerIp = (CONFIG.runnerPublicIp || "").trim();
  const script = `#!/bin/bash
# Redirect every locally generated TCP connection into redsocks, then prove it
# works — and revert by itself if it does not. Same reasoning as start.mjs's
# exit-node watchdog: a bad redirect takes the VM off the network, including
# Freestyle's control channel, so an exec that applies it would never return.
LOG=/tmp/awmvpn-redirect.log
RES=/tmp/awmvpn-redirect.result
rm -f "$RES"
exec >>"$LOG" 2>&1
echo "redirect start $(date -u +%H:%M:%S)"

revert() {
  iptables -t nat -D OUTPUT -j AWMVPN 2>/dev/null
  iptables -t nat -F AWMVPN 2>/dev/null
  iptables -t nat -X AWMVPN 2>/dev/null
}

revert
iptables -t nat -N AWMVPN
iptables -t nat -A AWMVPN -d 127.0.0.0/8 -j RETURN
iptables -t nat -A AWMVPN -d 10.0.0.0/8 -j RETURN
iptables -t nat -A AWMVPN -d 172.16.0.0/12 -j RETURN
iptables -t nat -A AWMVPN -d 192.168.0.0/16 -j RETURN
iptables -t nat -A AWMVPN -d 169.254.0.0/16 -j RETURN
iptables -t nat -A AWMVPN -d 100.64.0.0/10 -j RETURN
iptables -t nat -A AWMVPN -m owner --uid-owner ${vpnUid} -j RETURN
iptables -t nat -A AWMVPN -m owner --uid-owner ${redsocksUid} -j RETURN
iptables -t nat -A AWMVPN -p tcp -j REDIRECT --to-ports ${REDSOCKS_PORT}
iptables -t nat -I OUTPUT 1 -j AWMVPN
echo "rules installed: $(iptables -t nat -S AWMVPN | wc -l) lines"

OK=""
for i in $(seq 1 6); do
  sleep 3
  IP=$(curl -s --max-time 20 https://api.ipify.org || true)
  echo "probe $i egress=\${IP:-none}"
  if [ -n "$IP" ]; then OK="$IP"; break; fi
done

EXPECTED="${expectedIp}"
RUNNER="${runnerIp}"
if [ -z "$OK" ]; then
  echo "no egress after the redirect — reverting"
  revert
  sleep 3
  BACK=$(curl -s --max-time 15 https://api.ipify.org || true)
  echo "RESULT=failed reverted_egress=\${BACK:-none}" > "$RES"
elif [ -n "$RUNNER" ] && [ "$OK" = "$RUNNER" ]; then
  echo "egress is still the runner IP ($OK) — the redirect is not in effect"
  revert
  sleep 3
  echo "RESULT=failed still_runner_ip=\${OK}" > "$RES"
elif [ -n "$EXPECTED" ] && [ "$OK" != "$EXPECTED" ]; then
  echo "egress $OK differs from the VPN exit IP $EXPECTED — keeping the redirect"
  echo "RESULT=ok egress=$OK expected=$EXPECTED" > "$RES"
else
  echo "RESULT=ok egress=$OK" > "$RES"
fi
chmod 644 "$RES" "$LOG" 2>/dev/null
echo "redirect done"
`;
  await vm.fs.writeTextFile("/tmp/awmvpn-redirect.sh", script);
  await run(
    vm,
    `set -e
chmod +x /tmp/awmvpn-redirect.sh
sudo rm -f /tmp/awmvpn-redirect.result /tmp/awmvpn-redirect.log
sudo setsid nohup /tmp/awmvpn-redirect.sh >/dev/null 2>&1 &
echo launched
`,
    60_000,
  );

  for (let attempt = 1; attempt <= 2; attempt++) {
    const poll = await run(
      vm,
      `timeout 60 bash -c 'for i in $(seq 1 25); do [ -s /tmp/awmvpn-redirect.result ] && break; sleep 2; done; cat /tmp/awmvpn-redirect.result 2>/dev/null || echo RESULT=pending'
tail -n 6 /tmp/awmvpn-redirect.log 2>/dev/null || true`,
      180_000,
    );
    for (const line of poll.split("\n").filter(Boolean)) log(`    ${line}`);
    const m = poll.match(/RESULT=(ok|failed)\b[^\n]*/);
    if (!m) continue;
    if (m[1] === "ok") return true;
    return false;
  }
  log("    redirect verdict still pending — leaving the direct route in place");
  return false;
}

async function clearTransparent(vm) {
  await tryRun(
    vm,
    `sudo iptables -t nat -D OUTPUT -j AWMVPN 2>/dev/null; \
     sudo iptables -t nat -F AWMVPN 2>/dev/null; \
     sudo iptables -t nat -X AWMVPN 2>/dev/null; echo cleared`,
    60_000,
  );
}

// ------------------------------------------------------------- locations
function pickLocations() {
  const want = (process.env.FXA_COUNTRY || "").trim().toLowerCase();
  if (want && want !== "random") return [want === "auto" ? "" : want];
  const pool = [...FREE_COUNTRIES];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, TRIES);
}

async function exportEnv(pairs) {
  const path = process.env.GITHUB_ENV;
  if (!path) return;
  const body = Object.entries(pairs)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  await appendFile(path, `${body}\n`);
}

// ------------------------------------------------------------------ run
header(`AWMVPN — whole-VM VPN inside "${CONFIG.slug}"`);
log(`• Transport: ${TRANSPORT} | SOCKS5 127.0.0.1:${PROXY_PORT} | dashboard 127.0.0.1:${DASH_PORT}`);
log(`• Whole-VM redirect: ${TRANSPARENT ? "on (redsocks + iptables)" : "off (SOCKS5 only)"}`);

const vm = await ensureVm();
await installCore(vm);
await restoreAccounts(vm);

let winner = null;
for (const country of pickLocations()) {
  const label = country || "auto (Mozilla's REC location)";
  log(`• Location: ${label}`);
  await writeConfig(vm, country);
  await restartService(vm);
  const res = await waitForTunnel(vm);
  if (res.ok) {
    winner = { country, ip: res.ip };
    break;
  }
  log(`    no tunnel through ${label}`);
  await diagnostics(vm);
}

if (!winner) {
  throw new Error(
    "AWMVPN never produced a working tunnel. Usual causes: the restored account needs " +
      "a sign-in (reauth_required), Guardian answers 451 because the egress is not the " +
      "runner's IP, or the transport is blocked. The diagnostics above name which one.",
  );
}

// From here on the tunnel exists; now make the VM itself use it.
let transparent = false;
if (TRANSPARENT) {
  log("• Whole-VM redirect: installing redsocks…");
  try {
    await installRedsocks(vm);
    log("• Whole-VM redirect: applying the iptables chain (self-reverting watchdog)…");
    transparent = await applyTransparent(vm, winner.ip);
  } catch (e) {
    log(`• Whole-VM redirect: FAILED — ${String(e.message).split("\n")[0]}`);
    await clearTransparent(vm);
    transparent = false;
  }
  if (!transparent) {
    log("• Whole-VM redirect: NOT active — the VM keeps its normal route and only");
    log("                     the SOCKS5 address below works. 9router is unaffected.");
  }
}

const socks = `socks5h://${PROXY_USER}:${PROXY_PASS}@127.0.0.1:${PROXY_PORT}`;
await exportEnv({
  FXA_SOCKS5: socks,
  FXA_COUNTRY: winner.country || "auto",
  FXA_EXIT_IP: winner.ip,
  FXA_VPN_ACTIVE: "1",
  FXA_TRANSPARENT: transparent ? "1" : "0",
});

header("AWMVPN READY");
log(`  Location  : ${winner.country || "auto"}`);
log(`  Exit IP   : ${winner.ip}`);
log(`  Whole VM  : ${transparent ? "ALL TCP traffic goes through the VPN" : "not redirected (SOCKS5 only)"}`);
log(`  SOCKS5    : ${socks}`);
log(`  Dashboard : http://127.0.0.1:${DASH_PORT}/app/ (inside the VM only)`);
log(`  Files     : ${DATA_DIR} (config.json, accounts/ — contains credentials)`);
log(`  Direct    : loopback, private ranges and the VPN's own traffic stay off-tunnel`);
