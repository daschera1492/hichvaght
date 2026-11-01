#!/usr/bin/env bash
# Bootstrap 9Router inside a Freestyle Ubuntu VM.
# Idempotent: safe to run on every Start.
set -euo pipefail

PORT="${ROUTER_PORT:-20128}"
# No default password: this repo is public, so a baked-in value would be visible
# to everyone. The caller must always provide one.
: "${NINE_ROUTER_PASSWORD:?NINE_ROUTER_PASSWORD must be set (no default password allowed)}"
PASSWORD="$NINE_ROUTER_PASSWORD"
# Two layouts, chosen by the caller:
#
#   * DEDICATED (runner): 9router runs as its own system user, never root. The
#     runner locks that uid's egress to the VPN with nftables (`meta skuid`), and
#     locking uid 0 would also capture systemd, DHCP and every root helper.
#     DATA_DIR is the override 9router documents (README: `-e DATA_DIR=/app/data`).
#   * LEGACY (Freestyle VM): unchanged root layout in /root/.9router, because
#     start.mjs/stop.mjs archive and restore exactly that path.
#
# Dedicated mode is opt-in, so the VM workflows keep their existing behaviour.
if [ -n "${NINE_RUN_USER:-}" ] || [ -n "${NINE_DATA_DIR:-}" ]; then
  DEDICATED=1
  NINE_USER="${NINE_RUN_USER:-nine}"
  DATA_DIR="${NINE_DATA_DIR:-/var/lib/9router}"
else
  DEDICATED=0
  NINE_USER="root"
  DATA_DIR="/root/.9router"
fi
RUNTIME="$DATA_DIR/runtime"

export PATH="$PATH:$(npm prefix -g)/bin"

echo "==> 1/6 installing 9router (if missing)"
if ! command -v 9router >/dev/null 2>&1; then
  # npm >= 11 blocks postinstall scripts unless allow-listed; older npm rejects the
  # flag. Pick the flag by asking npm itself instead of failing a 2-minute install
  # and retrying it (measured on run 40654240428: the failed attempt cost ~2 min).
  SCRIPT_FLAG=""
  if npm help install 2>/dev/null | grep -q -- '--allow-scripts'; then
    SCRIPT_FLAG="--allow-scripts=9router"
  fi
  echo "    npm $(npm --version), script flag: ${SCRIPT_FLAG:-none}"
  { echo "attempt 1 at $(date -u +%H:%M:%S)"; sudo npm i -g 9router $SCRIPT_FLAG --no-audit --no-fund; } >/tmp/npm-i.log 2>&1 \
    || { echo "attempt 2 at $(date -u +%H:%M:%S)" >>/tmp/npm-i.log; sudo npm i -g 9router --no-audit --no-fund >>/tmp/npm-i.log 2>&1; } \
    || { tail -20 /tmp/npm-i.log; echo "FATAL: 9router install failed"; exit 1; }
  echo "    installed in the time shown by: $(grep -E 'added [0-9]+ package' /tmp/npm-i.log | tail -1)"
fi
BIN="$(command -v 9router)"
echo "    9router -> $BIN ($(9router --version 2>/dev/null || echo '?'))"

# The package root, resolved through the symlink in bin/ (the node version in the
# path changes over time, so it must never be hard-coded).
# bin/9router may point either at <pkg>/cli.js (root) or <pkg>/bin/9router.js,
# so walk up until we find the directory that actually contains package.json.
PKG_DIR="$(dirname "$(readlink -f "$BIN")")"
if [ ! -f "$PKG_DIR/package.json" ]; then
  PKG_DIR="$(dirname "$PKG_DIR")"
fi
APP_DIR="$PKG_DIR/app"
[ -f "$PKG_DIR/package.json" ] || { echo "FATAL: package root not found from $BIN"; exit 1; }
[ -d "$APP_DIR" ] || { echo "FATAL: app directory not found under $PKG_DIR"; exit 1; }
echo "    package -> $PKG_DIR"
echo "    app dir -> $APP_DIR"
# runner-router/router.mjs needs the same path to put the zen-proxy wreq-js
# stand-in where the app's ESM import() looks for it.
printf '%s\n' "$APP_DIR" | sudo tee /etc/9router-app-dir >/dev/null

# The dedicated account. `--system` keeps it out of the login users; the home is
# the data dir itself, which the app writes to anyway. Idempotent: re-running a
# start must never fail here.
echo "==> 2/6 preparing the run-as user \"$NINE_USER\" and $DATA_DIR"
RUN_AS=""
if [ "$DEDICATED" = "1" ]; then
  if ! id -u "$NINE_USER" >/dev/null 2>&1; then
    sudo useradd --system --user-group --create-home --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$NINE_USER"
  fi
  sudo mkdir -p "$DATA_DIR" "$RUNTIME"
  sudo chown -R "$NINE_USER:$NINE_USER" "$DATA_DIR"
  sudo chmod 0750 "$DATA_DIR"
  # 9router owns its own package tree too: Next keeps runtime caches under the
  # build directory, and a read-only install would fail on image/ISR caching.
  sudo chown -R "$NINE_USER:$NINE_USER" "$PKG_DIR"
  sudo mkdir -p "$APP_DIR/.next-cli-build/cache/images" "$APP_DIR/.next-cli-build/cache/fetch-cache"
  sudo chown -R "$NINE_USER:$NINE_USER" "$APP_DIR/.next-cli-build/cache"
  # systemd appends stdout/stderr to this file, so the service user must own it.
  sudo touch /var/log/9router.log
  sudo chown "$NINE_USER:$NINE_USER" /var/log/9router.log
  sudo chmod 0640 /var/log/9router.log
  RUN_AS="User=${NINE_USER}
Group=${NINE_USER}
WorkingDirectory=${DATA_DIR}
Environment=DATA_DIR=${DATA_DIR}
Environment=HOME=${DATA_DIR}
Environment=NEXT_TELEMETRY_DISABLED=1"
  echo "    uid $(id -u "$NINE_USER") / gid $(id -g "$NINE_USER"), data dir owned by $NINE_USER"
else
  echo "    legacy layout: running as root, data dir $DATA_DIR (Freestyle VM)"
fi

echo "==> 3/6 installing runtime deps (wreq-js + sqlite + tray)"
sudo mkdir -p "$RUNTIME"
if [ ! -f "$RUNTIME/package.json" ]; then
  printf '{"name":"9router-runtime","version":"1.0.0","private":true}\n' | sudo tee "$RUNTIME/package.json" >/dev/null
fi
# One command so npm never prunes the others (it reconciles the tree with package.json).
sudo bash -c "cd '$RUNTIME' && npm install --save \
  wreq-js@3.2.0 better-sqlite3@13.0.3 sql.js@1.14.1 systray2 \
  --no-audit --no-fund --ignore-scripts" >/tmp/npm-runtime.log 2>&1 \
  || { tail -20 /tmp/npm-runtime.log; echo "FATAL: runtime deps install failed"; exit 1; }

for m in wreq-js better-sqlite3 sql.js; do
  if [ ! -f "$RUNTIME/node_modules/$m/package.json" ]; then
    echo "FATAL: $m missing from $RUNTIME/node_modules"; exit 1
  fi
done
echo "    runtime deps OK"

# wreq-js is loaded with a dynamic ESM import(), and NODE_PATH does NOT apply to
# ESM resolution — only to require(). Without a copy inside the app's own
# node_modules the import throws ERR_MODULE_NOT_FOUND, and 9router's fallback
# path then crashes on `(void 0).resolve(...)`, surfacing as
# "wreq-js unavailable (Cannot read properties of undefined (reading 'resolve'))".
# Copying the package (plus its platform binding) next to the app fixes it.
echo "==> 4/6 placing wreq-js where the app's ESM import() can resolve it"
sudo mkdir -p "$APP_DIR/node_modules/@wreq-js"
sudo rm -rf "$APP_DIR/node_modules/wreq-js"
sudo cp -a "$RUNTIME/node_modules/wreq-js" "$APP_DIR/node_modules/"
if [ -d "$RUNTIME/node_modules/@wreq-js" ]; then
  sudo cp -a "$RUNTIME/node_modules/@wreq-js/." "$APP_DIR/node_modules/@wreq-js/"
fi
echo "    copied: $(sudo du -sh "$APP_DIR/node_modules/wreq-js" | cut -f1) + binding ($(sudo ls "$APP_DIR/node_modules/@wreq-js" | tr '\n' ' '))"

# Verify the way the app actually loads it: an ESM import() from the very
# directory the bundled server code lives in.
CHECK="$APP_DIR/.next-cli-build/server/chunks/_wreqcheck.mjs"
sudo tee "$CHECK" >/dev/null <<'EOF'
const m = await import("wreq-js").catch((e) => {
  console.log("ESM import failed:", e.code || e.name, "|", String(e.message).slice(0, 120));
  process.exit(1);
});
const fn = m.fetch || m.default?.fetch;
if (typeof fn !== "function") {
  console.log("ESM import succeeded but fetch is", typeof fn);
  process.exit(1);
}
// A real request proves the native binding for this platform loads too.
const res = await fn("https://api.github.com", { method: "GET" }).catch((e) => ({ status: 0, err: e.message }));
console.log(`wreq-js ESM import: OK (fetch -> ${res.status || res.err})`);
EOF
sudo node "$CHECK" || { sudo rm -f "$CHECK"; echo "FATAL: wreq-js is not importable from the app"; exit 1; }
sudo rm -f "$CHECK"
# cp -a above reintroduced root-owned files inside the package tree.
sudo chown -R "$NINE_USER:$NINE_USER" "$APP_DIR/node_modules" "$RUNTIME"

echo "==> 5/6 writing systemd unit"
sudo tee /etc/systemd/system/9router.service >/dev/null <<EOF
[Unit]
Description=9Router AI gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# Dedicated mode (runner): router.mjs locks exactly this uid to the VPN, so
# nothing else on the machine (systemd, DHCP, cloudflared) is ever redirected.
# Legacy mode (Freestyle VM) leaves this block empty, i.e. root as before.
${RUN_AS}
# 9router reads INITIAL_PASSWORD (not NINE_ROUTER_PASSWORD) when no password is
# stored in settings yet; it is also what satisfies the "change the default
# password before remote access" guard.
Environment=INITIAL_PASSWORD=${PASSWORD}
# CJS dependencies (better-sqlite3, sql.js, systray2) resolve through NODE_PATH.
Environment=NODE_PATH=${RUNTIME}/node_modules
ExecStart=${BIN} --no-browser --skip-update --port ${PORT}
Restart=always
RestartSec=5
StandardOutput=append:/var/log/9router.log
StandardError=append:/var/log/9router.log

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable 9router >/dev/null 2>&1 || true

# The runner variant starts 9router only after its uid has been locked to the
# VPN at the kernel level (router.mjs). It must therefore be able to install
# the unit without ever running the app on the direct route.
if [ "${NINE_ROUTER_SKIP_START:-0}" = "1" ]; then
  echo "==> 6/6 start skipped (NINE_ROUTER_SKIP_START=1): the caller starts 9router after the egress lock"
  exit 0
fi

sudo systemctl restart 9router

echo "==> 6/6 waiting for the listener on :$PORT"
for i in $(seq 1 90); do
  if curl -sf -o /dev/null "http://127.0.0.1:$PORT/dashboard" 2>/dev/null \
     || curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/dashboard" 2>/dev/null | grep -qE '^[23]'; then
    echo "    9router is up after ${i}s"
    exit 0
  fi
  sleep 1
done

echo "FATAL: 9router did not open port $PORT"
sudo systemctl status 9router --no-pager || true
sudo tail -40 /var/log/9router.log || true
exit 1
