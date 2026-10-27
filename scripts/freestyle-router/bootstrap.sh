#!/usr/bin/env bash
# Bootstrap 9Router inside a Freestyle Ubuntu VM.
# Idempotent: safe to run on every Start.
set -euo pipefail

PORT="${ROUTER_PORT:-20128}"
PASSWORD="${NINE_ROUTER_PASSWORD:-123456}"
DATA_DIR="/root/.9router"
RUNTIME="$DATA_DIR/runtime"

export PATH="$PATH:$(npm prefix -g)/bin"

echo "==> 1/5 installing 9router (if missing)"
if ! command -v 9router >/dev/null 2>&1; then
  # npm >= 11 blocks postinstall scripts unless allow-listed; older npm rejects the flag.
  sudo npm i -g 9router --allow-scripts=9router --no-audit --no-fund >/tmp/npm-i.log 2>&1 \
    || sudo npm i -g 9router --no-audit --no-fund >>/tmp/npm-i.log 2>&1 \
    || { tail -20 /tmp/npm-i.log; echo "FATAL: 9router install failed"; exit 1; }
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

echo "==> 2/5 installing runtime deps (wreq-js + sqlite + tray)"
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
echo "==> 3/5 placing wreq-js where the app's ESM import() can resolve it"
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

echo "==> 4/5 writing systemd unit"
sudo tee /etc/systemd/system/9router.service >/dev/null <<EOF
[Unit]
Description=9Router AI gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
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
sudo systemctl restart 9router

echo "==> 5/5 waiting for the listener on :$PORT"
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
