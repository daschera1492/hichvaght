#!/usr/bin/env bash
# Bootstrap 9Router inside a Freestyle Ubuntu VM.
# Idempotent: safe to run on every Start.
set -euo pipefail

PORT="${ROUTER_PORT:-20128}"
PASSWORD="${NINE_ROUTER_PASSWORD:-codol-router-2026}"
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

echo "==> 3/5 verifying wreq-js loads from NODE_PATH (what the dashboard uses)"
sudo bash -c "NODE_PATH='$RUNTIME/node_modules' node -e 'const w=require(\"wreq-js\"); if(typeof w.fetch!==\"function\")process.exit(1); console.log(\"    wreq-js fetch: OK\")'" \
  || { echo "FATAL: wreq-js does not load"; exit 1; }

echo "==> 4/5 writing systemd unit"
sudo tee /etc/systemd/system/9router.service >/dev/null <<EOF
[Unit]
Description=9Router AI gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=NINE_ROUTER_PASSWORD=${PASSWORD}
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
