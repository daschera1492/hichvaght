// Start: create the 9Router VM, install it, restore state (optionally), route the
// fixed domain to it, and — first — point all of the VM's traffic through the
// GitHub runner's Tailscale exit node so its egress is a clean IP.
//
// RESTORE_BACKUP=false starts from a blank database (the "fresh" tick in the
// workflow); anything else restores the archive written by Stop, falling back to
// the baseline seed config when no archive exists yet.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CONFIG,
  BACKUP,
  backupConfigured,
  client,
  log,
  sleep,
  header,
  run,
  tryRun,
  waitForListener,
  waitForState,
  downloadBackup,
  downloadBackupPrev,
  downloadSeed,
  exportState,
  stateIsEmpty,
  unseal,
} from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const freestyle = client();
const wantBackup = (process.env.RESTORE_BACKUP ?? "true").toLowerCase() !== "false";

header(`9Router Start — ${CONFIG.domain} (VM "${CONFIG.slug}")`);
log(`• Mode: ${wantBackup ? "restore the last Stop archive" : "fresh — ignore archive and seed"}`);

// ---------------------------------------------------------------- 1. DNS
// Done once, permanently. The CNAME must be PROXIED (orange cloud): Cloudflare
// then serves a trusted certificate for the hostname and talks to the Freestyle
// edge itself. This removes any dependency on Freestyle's ACME pipeline, which
// does not issue for this zone.
async function ensureDns() {
  const token = process.env.CF_API_TOKEN;
  if (!token) {
    log("• DNS: CF_API_TOKEN not set — assuming the CNAME already exists.");
    return;
  }
  const api = (method, path, body) =>
    fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }).then((r) => r.json());

  const zoneId = CONFIG.zoneId;
  const name = CONFIG.domain;

  const found = await api("GET", `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}&type=CNAME`);
  const rec = found.result?.[0];

  if (!rec) {
    const created = await api("POST", `/zones/${zoneId}/dns_records`, {
      type: "CNAME", name, content: "beta-web.freestyle.sh", proxied: true, ttl: 1,
    });
    if (!created.success) throw new Error(`DNS create failed: ${JSON.stringify(created.errors)}`);
    log(`• DNS: created CNAME ${name} -> beta-web.freestyle.sh (proxied)`);
  } else if (!rec.proxied || rec.content !== "beta-web.freestyle.sh") {
    const upd = await api("PATCH", `/zones/${zoneId}/dns_records/${rec.id}`, {
      content: "beta-web.freestyle.sh", proxied: true,
    });
    if (!upd.success) throw new Error(`DNS update failed: ${JSON.stringify(upd.errors)}`);
    log(`• DNS: updated CNAME ${name} -> beta-web.freestyle.sh (proxied)`);
  } else {
    log(`• DNS: CNAME ${name} -> beta-web.freestyle.sh (proxied) already correct`);
  }
}

// ---------------------------------------------------------------- 2. VM
async function ensureVm() {
  const list = await freestyle.vms.list();
  const existing = list.vms?.find((v) => v.slug === CONFIG.slug && v.state !== "stopped");

  if (existing) {
    log(`• VM: found existing ${existing.id} (${existing.state})`);
    if (existing.state === "paused") {
      log("• VM: resuming from pause…");
      await freestyle.vms.ref(existing.id).start();
      await waitForState(freestyle, existing.id, "running");
    }
    return freestyle.vms.ref(existing.id);
  }

  log(`• VM: creating from snapshot ${CONFIG.snapshotId}…`);
  const t0 = Date.now();
  const { vm, vmId } = await freestyle.vms.create({
    snapshotId: CONFIG.snapshotId,
    slug: CONFIG.slug,
    displayName: CONFIG.displayName,
    idleTimeoutSeconds: CONFIG.idleTimeoutSeconds,
    // Outbound internet is required to install npm packages.
    firewall: { rules: [{ action: "allow", source: {}, destination: { public: true } }] },
  });
  log(`• VM: ${vmId} running after ${Date.now() - t0} ms`);
  return vm;
}

// ---------------------------------------------------------------- 3. install
async function provision(vm) {
  log("• Provisioning 9Router inside the VM (this takes ~1–2 min)…");
  const script = await readFile(join(here, "bootstrap.sh"), "utf8");
  await vm.fs.writeTextFile("/tmp/bootstrap.sh", script);
  // Hand the password to the guest through a 600-mode file instead of inlining it:
  // the run() helper echoes the whole command on failure, and an inline value would
  // also be injectable if it ever contained a shell quote.
  await vm.fs.writeTextFile("/tmp/9router-pw", CONFIG.password);
  // vm.exec is NOT root, and the file is chmod 600 root-owned, so the password
  // must be read by the same root shell that runs bootstrap.sh. `sudo VAR="$(cat
  // ...)"` expands the substitution in the *caller's* (non-root) shell and hands
  // sudo an empty value — bootstrap.sh then aborts on its fail-hard check.
  const out = await run(
    vm,
    `sudo bash -c '
      chmod 600 /tmp/9router-pw
      export ROUTER_PORT=${CONFIG.port}
      export NINE_ROUTER_PASSWORD="$(cat /tmp/9router-pw)"
      bash /tmp/bootstrap.sh
      rc=$?
      rm -f /tmp/9router-pw
      exit $rc
    '`,
  );
  for (const line of out.split("\n").filter(Boolean)) log(`    ${line}`);
}

// ---------------------------------------------------------------- 4. state
// The VM is disposable, so its state travels through encrypted GitHub release
// assets. This runs before the route is created: the hostname never points at a
// half-filled database.

/** Start 9router with nothing but an empty database. */
async function startEmpty(vm, reason) {
  await run(
    vm,
    `sudo bash -c '
      set -e
      systemctl stop 9router || true
      rm -rf ${CONFIG.dataDir}/db
      rm -f ${CONFIG.dataDir}/db.json ${CONFIG.dataDir}/.migrated-from-json
      systemctl start 9router
    '`,
  );
  const up = await waitForListener(vm, CONFIG.port, 90);
  if (!up) throw new Error("9router did not start on an empty database");
  log(`• State: ${reason} — empty database, up after ${up}s`);
}

/** Drop a JSON export where 9router imports it on first boot. */
async function importSeed(vm, seedBytes) {
  await vm.fs.writeFile("/tmp/9router-seed.json", new Uint8Array(seedBytes));
  await run(
    vm,
    `sudo bash -c '
      set -e
      systemctl stop 9router || true
      rm -rf ${CONFIG.dataDir}/db
      cp /tmp/9router-seed.json ${CONFIG.dataDir}/db.json
      chown root:root ${CONFIG.dataDir}/db.json
      chmod 644 ${CONFIG.dataDir}/db.json
      rm -f ${CONFIG.dataDir}/.migrated-from-json
      systemctl start 9router
    '`,
  );
  return waitForListener(vm, CONFIG.port, 90);
}

async function restoreState(vm) {
  if (!wantBackup) {
    await startEmpty(vm, "fresh start requested, archive ignored");
    return;
  }
  if (!backupConfigured()) {
    log("• State: backup is not configured (BACKUP_ENCRYPTION_KEY / GITHUB_TOKEN) — starting empty");
    return;
  }

  // Preferred: the exact archive written by Stop. Newest first, then the
  // rollback copy — a Stop that archived an empty router must not be able to
  // hide the previous good state.
  const candidates = [];
  const latest = await downloadBackup().catch(() => null);
  if (latest) candidates.push({ label: "latest", sealed: latest });
  const prev = await downloadBackupPrev().catch(() => null);
  if (prev) candidates.push({ label: "previous", sealed: prev });

  for (const candidate of candidates) {
    const tar = unseal(candidate.sealed);
    log(
      `• State: ${candidate.label} archive ${(tar.length / 1024).toFixed(1)} KiB from release "${BACKUP.tag}", restoring…`,
    );
    await vm.fs.writeFile("/tmp/9router-restore.tar.gz", new Uint8Array(tar));

    const out = await run(
      vm,
      `sudo bash -c '
        set -e
        systemctl stop 9router || true
        rm -rf ${CONFIG.dataDir}/db
        tar xzf /tmp/9router-restore.tar.gz -C ${CONFIG.dataDir}
        # No database in the archive? Let 9router import the bundled JSON instead.
        if [ ! -f ${CONFIG.dataDir}/db/data.sqlite ] && [ -f ${CONFIG.dataDir}/9router-export.json ]; then
          cp ${CONFIG.dataDir}/9router-export.json ${CONFIG.dataDir}/db.json
          rm -f ${CONFIG.dataDir}/.migrated-from-json
        fi
        chown -R root:root ${CONFIG.dataDir}/db 2>/dev/null || true
        chown root:root ${CONFIG.dataDir}/9router-export.json 2>/dev/null || true
        [ -f ${CONFIG.dataDir}/jwt-secret ] && chmod 600 ${CONFIG.dataDir}/jwt-secret
        echo "--- restored ---"
        ls -l ${CONFIG.dataDir}/db ${CONFIG.dataDir}/9router-export.json 2>/dev/null
        systemctl start 9router
      '`,
    );
    for (const line of out.split("\n").filter(Boolean)) log(`    ${line}`);

    const up = await waitForListener(vm, CONFIG.port, 90);
    if (!up) {
      log(`• State: the ${candidate.label} database did not start`);
      continue;
    }
    log(`• State: 9router is serving the ${candidate.label} database (up after ${up}s)`);

    const counts = await reportState(vm);
    if (!stateIsEmpty(counts)) return;
    log(`• State: the ${candidate.label} archive holds no config — trying an older copy`);
  }

  // No archive yet (or every archived copy was empty): use the owner's baseline
  // export, if one was published.
  const seed = await downloadSeed();
  if (seed) {
    const json = unseal(seed);
    log(`• State: importing the baseline seed (${(json.length / 1024).toFixed(1)} KiB)…`);
    const up = await importSeed(vm, json);
    if (up) {
      log(`• State: baseline config imported (up after ${up}s)`);
      return;
    }
    log("• State: the baseline seed did not start — falling back to a fresh database");
    await startEmpty(vm, "seed rolled back");
    return;
  }

  log("• State: nothing archived yet — starting with a fresh database");
  await startEmpty(vm, "first run");
}

// ---------------------------------------------------------------- 4b. egress
// 9Router's OpenCode free lane (`oc/*`) answers 429 from every datacenter range
// that has already burned its daily free window — Freestyle's own exit address,
// Azure, GitHub runners, Cloudflare WARP. The lane is fine; the exit IP is not.
//
// The GitHub runner that launched this job advertises itself as a Tailscale exit
// node. We install Tailscale in the VM and point it at that exit node, so 100% of
// the VM's outbound traffic leaves from the runner's IP. This replaces the old
// OUTBOUND_PROXY_URL switch entirely.
async function routeThroughExitNode(vm) {
  const exitNode = CONFIG.exitNode.trim();
  const authKey = CONFIG.tailscaleAuthKey.trim();
  const want = CONFIG.runnerPublicIp.trim();
  if (!exitNode || !authKey) {
    log("• Egress: EXIT_NODE / TAILSCALE_AUTH_KEY not set — VM keeps its own IP (oc/* may 429)");
    return false;
  }

  // Everything here is FAIL-SOFT: a broken exit node must never cost the whole
  // session. The router works on the VM's own IP, so the worst case is "oc/* may
  // 429", not "no router at all".
  try {
    // ---- 1. client ------------------------------------------------------
    log("• Egress 1/4: Tailscale client…");
    const install = await run(
      vm,
      `set -e
if command -v tailscale >/dev/null 2>&1; then
  echo "already installed: $(tailscale version | head -n1)"
else
  curl -fsSL https://tailscale.com/install.sh -o /tmp/ts-install.sh
  sudo bash /tmp/ts-install.sh >/tmp/ts-install.log 2>&1 \
    || { tail -20 /tmp/ts-install.log; echo "FATAL: tailscale install failed"; exit 1; }
  echo "installed: $(tailscale version | head -n1)"
fi`,
      420_000,
    );
    for (const line of install.split("\n").filter(Boolean)) log(`    ${line}`);

    // ---- 2. auth only ---------------------------------------------------
    // No --exit-node here on purpose: this step cannot cut the VM's network, so
    // an auth failure is reported cleanly instead of breaking vm.exec.
    log("• Egress 2/4: joining the tailnet with the shared auth key…");
    await vm.fs.writeTextFile("/tmp/ts-auth.key", authKey);
    const auth = await run(
      vm,
      `set -e
sudo chmod 600 /tmp/ts-auth.key
sudo systemctl enable --now tailscaled >/dev/null 2>&1 || true
for i in $(seq 1 30); do sudo systemctl is-active --quiet tailscaled && break; sleep 1; done
sudo timeout 120 tailscale up \
  --authkey="$(sudo cat /tmp/ts-auth.key)" \
  --accept-dns=false \
  --hostname=${CONFIG.slug}-vm \
  || { echo "AUTH-FAILED (bad/expired/already-used auth key?)"; sudo tailscale status 2>&1 | head -5; sudo rm -f /tmp/ts-auth.key; exit 1; }
sudo rm -f /tmp/ts-auth.key
# A previous attempt may have left an exit node configured — start from a clean,
# working direct route so the probes below mean something.
sudo timeout 60 tailscale set --exit-node= --accept-dns=false || true
echo "baseline=$(curl -s --max-time 10 https://api.ipify.org || echo none)"`,
      240_000,
    );
    for (const line of auth.split("\n").filter(Boolean)) log(`    ${line}`);
    const baseline = (auth.split("\n").find((l) => l.startsWith("baseline=")) ?? "").slice(9).trim();
    if (!baseline || baseline === "none") {
      log("• Egress: the VM has no internet before the switch — leaving the direct route as is");
      return false;
    }

    // ---- 2b. can this VM even SEE the exit node? -------------------------
    // This is the check that was missing. `tailscale set --exit-node=…` happily
    // installs a 0.0.0.0/0 route into tailscale0 even when the exit node is not in
    // the VM's netmap; every packet is then black-holed (no DNS, no HTTPS) and,
    // because Freestyle's control channel rides the same network, vm.exec hangs
    // too. Observed in run 40654240428: EXITNODE=100.123.186.114 but
    // `tailscale ping` -> "no matching peer", egress=unknown, VM unreachable.
    //
    // In that run the VM was tagged tag:exit-node (the shared auth key is tagged)
    // and its netmap contained ONLY untagged member devices — every tagged node,
    // including the runner/exit node, was hidden by the tailnet policy. Switching
    // routes there can never work, so refuse to switch and say why.
    log(`• Egress 2b/4: checking that this VM can reach the exit node ${exitNode}…`);
    const probe = await tryRun(vm, `sudo tailscale ping -c 2 --timeout 4s ${exitNode} 2>&1 || true`, 120_000);
    const probeOut = probe.out;
    if (!/pong|via DERP|via direct/i.test(probeOut)) {
      log(`    ${probeOut.split("\n")[0] || "no response"}`);
      log("• Egress: the VM cannot reach the exit node — NOT switching routes (this would");
      log("          black-hole all traffic). The router still works on the VM's own IP.");
      log("          Fix one of these, then re-run:");
      log("            a) Tailscale admin -> Access controls: allow this device to reach");
      log("               tag:exit-node (the shared auth key tags BOTH nodes, and this");
      log(`               tailnet hides tagged peers from each other), or`);
      log("            b) use an UNTAGGED reusable auth key for the runner/exit node.");
      return false;
    }
    log("    reachable");

    // ---- 3. switch, in a detached self-reverting watchdog ----------------
    // `tailscale set --exit-node=…` reroutes 0.0.0.0/0 through the runner. If the
    // runner cannot actually forward (ip_forward, NAT, ACL, exit-node approval),
    // the VM loses the internet — and Freestyle's control channel with it, so an
    // exec running the switch never returns. (That is exactly the 30-minute
    // "hang": output stops right after this log line.) The watchdog therefore runs
    // detached, probes the internet, and reverts to the direct route by itself, so
    // the VM can never be left unreachable and vm.exec can never block forever.
    log(`• Egress 3/4: switching the default route to exit node ${exitNode} (self-reverting watchdog)…`);
    await vm.fs.writeTextFile("/tmp/ts-exit.sh", `#!/bin/bash
EXIT_NODE=${exitNode}
LOG=/tmp/ts-exit.log
RES=/tmp/ts-exit.result
rm -f "$RES" "$LOG"
exec >>"$LOG" 2>&1
echo "watchdog start $(date -u +%H:%M:%S) exit-node=$EXIT_NODE"
timeout 60 tailscale set --exit-node="$EXIT_NODE" --exit-node-allow-lan-access=true --accept-dns=false
echo "set --exit-node rc=$?"
OK=""
for i in $(seq 1 8); do
  sleep 3
  IP=$(curl -s --max-time 6 https://api.ipify.org || true)
  echo "probe $i egress=\${IP:-none}"
  if [ -n "$IP" ]; then OK="$IP"; break; fi
done
if [ -n "$OK" ]; then
  echo "RESULT=ok egress=$OK" > "$RES"
else
  echo "no egress through the exit node — reverting to the direct route"
  timeout 60 tailscale set --exit-node= --accept-dns=false
  sleep 4
  BACK=$(curl -s --max-time 8 https://api.ipify.org || true)
  echo "RESULT=failed reverted_egress=\${BACK:-none}" > "$RES"
fi
chmod 644 "$RES" "$LOG" 2>/dev/null
echo "watchdog done"
`);
    await run(
      vm,
      `chmod +x /tmp/ts-exit.sh
sudo rm -f /tmp/ts-exit.result /tmp/ts-exit.log
sudo setsid nohup /tmp/ts-exit.sh >/dev/null 2>&1 &
echo launched`,
      60_000,
    );

    // ---- 4. verdict -----------------------------------------------------
    log("• Egress 4/4: waiting for the watchdog verdict…");
    let verdict = "";
    let tail = "";
    for (let attempt = 1; attempt <= 2 && !verdict; attempt++) {
      const poll = await run(
        vm,
        `timeout 45 bash -c 'for i in $(seq 1 20); do [ -s /tmp/ts-exit.result ] && break; sleep 2; done; cat /tmp/ts-exit.result 2>/dev/null || echo RESULT=pending'
tail -n 6 /tmp/ts-exit.log 2>/dev/null || true`,
        180_000,
      );
      tail = poll;
      const m = poll.match(/RESULT=(ok|failed)\b[^\n]*/);
      if (m) verdict = m[0];
    }
    for (const line of tail.split("\n").filter(Boolean)) log(`    ${line}`);

    const ok = verdict.match(/^RESULT=ok egress=(\S+)/);
    if (ok) {
      const egress = ok[1];
      if (want && egress !== want) {
        log(`• Egress: routed through the exit node, but egress is ${egress} (runner IP ${want}) — check the runner's NAT`);
      } else {
        log(`• Egress: verified — ALL VM traffic leaves from ${egress} (the runner's IP)`);
      }
      return true;
    }
    if (/^RESULT=failed/.test(verdict)) {
      log("• Egress: the exit node does not forward traffic — reverted to the direct route.");
      log("          Usual causes: exit node not APPROVED in the Tailscale admin console,");
      log("          tailnet ACL blocking it, or ip_forward/NAT missing on the runner.");
      log("          Continuing without it: the router works, but oc/* requests may 429.");
      return false;
    }
    log("• Egress: watchdog verdict still pending — leaving the direct route in place.");
    return false;
  } catch (e) {
    log(`• Egress: FAILED — ${String(e.message).split("\n")[0]}`);
    log("          Continuing WITHOUT the exit node (the router still works; oc/* may 429).");
    return false;
  }
}

/** Report what the running instance actually holds. */
async function reportState(vm) {
  // The app creates its database lazily, so touch an API route first.
  await tryRun(vm, `curl -s -o /dev/null http://127.0.0.1:${CONFIG.port}/api/providers || true`);
  await sleep(1000);
  const { counts } = await exportState(vm, "/tmp/9router-verify.json");
  log(
    `• State: providers=${counts.providerConnections ?? 0} nodes=${counts.providerNodes ?? 0} ` +
      `combos=${counts.combos ?? 0} apiKeys=${counts.apiKeys ?? 0} customModels=${counts.customModels ?? 0}`,
  );
  return counts;
}

// ---------------------------------------------------------------- 5. TLS rule
async function ensureRoute(vmId) {
  const { rules } = await freestyle.tls.rules.list();
  const mine = (rules ?? []).filter((r) => r.domain === CONFIG.domain);

  const right = mine.find((r) => r.destination?.vmId === vmId && r.destination?.port === CONFIG.port);
  for (const stale of mine.filter((r) => r !== right)) {
    await freestyle.tls.rules.delete(stale.id);
    log(`• Route: removed stale rule ${stale.id}`);
  }
  if (right) {
    log(`• Route: ${CONFIG.domain} -> ${vmId}:${CONFIG.port} already in place (${right.id})`);
    return;
  }

  const rule = await freestyle.tls.rules.create({
    action: "allow",
    domain: CONFIG.domain,
    source: { public: true },
    destination: { vmId, port: CONFIG.port },
  });
  log(`• Route: created ${rule.id} — ${CONFIG.domain} -> ${vmId}:${CONFIG.port}`);
}

// ---------------------------------------------------------------- 6. verify
async function verify() {
  // Checked from the runner itself, i.e. the real public path through Cloudflare.
  // /dashboard redirects to /login once the router is up, so following is expected.
  const url = `https://${CONFIG.domain}/dashboard`;
  log(`• Verify: waiting for ${url} to answer…`);
  for (let i = 1; i <= 30; i++) {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0" },
    }).catch((e) => ({ status: 0, err: e }));
    if (res.status === 200) {
      log(`• Verify: OK — 200 at ${res.url ?? url} (attempt ${i})`);
      return true;
    }
    if (i % 5 === 0) log(`    attempt ${i}: ${res.status || res.err}`);
    await sleep(4000);
  }
  log("• Verify: WARNING — public URL did not return 200 yet (route may still be warming up)");
  return false;
}

// ---------------------------------------------------------------- run
await ensureDns();
const vm = await ensureVm();
const data = await vm.data();
log(`• VM: ${data.id} state=${data.state} slug=${data.slug}`);

// Route the VM's traffic through the runner's exit node FIRST, so everything
// below — npm install, 9router's own outbound, the free oc/* lane — leaves from
// the runner's clean IP instead of Freestyle's datacenter address.
const egressRouted = await routeThroughExitNode(vm);

await provision(vm);
await restoreState(vm);
const counts = await reportState(vm);
await ensureRoute(data.id);
await verify();

header("READY");
log(`  URL      : https://${CONFIG.domain}/dashboard`);
log(`  Password : ${CONFIG.password}`);
log(`  VM       : ${data.id} (${CONFIG.slug})`);
log(`  Dataset  : ${wantBackup ? "restored" : "fresh (archive kept untouched)"}`);
log(`  Contents : providers=${counts.providerConnections ?? 0} combos=${counts.combos ?? 0} apiKeys=${counts.apiKeys ?? 0} customModels=${counts.customModels ?? 0}`);
log(`  Egress   : ${egressRouted ? `via Tailscale exit node ${CONFIG.exitNode} (runner IP — oc/* answers 200)` : "direct — oc/* may 429"}`);
log(`  Idle     : pauses after ${CONFIG.idleTimeoutSeconds}s, public traffic wakes it in <1s`);
log(`  Session  : the lifecycle workflow archives this state and deletes the VM at the deadline`);
