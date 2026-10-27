// Start: create the 9Router VM, install it, restore state (optionally), and
// route the fixed domain to it.
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
  const out = await run(vm, `sudo ROUTER_PORT=${CONFIG.port} NINE_ROUTER_PASSWORD='${CONFIG.password}' bash /tmp/bootstrap.sh`);
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
// 9Router's OpenCode free lane (`oc/*`) answers 429 from Freestyle's own exit
// address, from Azure/GitHub runners and from Cloudflare WARP — every datacenter
// range that has already burned the daily free window. The same request from a
// clean residential-grade IP answers 200 with no key at all.
//
// So the lane is not broken, the exit IP is. `outboundProxyUrl` is 9Router's own
// switch for this and it covers the wreq-js transport: with it set, the call
// leaves through the proxy and returns 200 in ~1-2s. These settings live in the
// database, so they are (re)applied here after a restore — an old archive must
// never be able to bring back the 429.
async function applyOutboundProxy(vm) {
  const url = (process.env.OUTBOUND_PROXY_URL ?? "").trim();
  if (!url) {
    log("• Egress: OUTBOUND_PROXY_URL not set — oc/* will fall back to this VM's own IP (429)");
    return false;
  }

  const mask = url.replace(/\/\/[^@/]*@/, "//***@");
  const payload = JSON.stringify({ outboundProxyEnabled: true, outboundProxyUrl: url, outboundNoProxy: "" });
  const auth = JSON.stringify({ password: CONFIG.password });
  const base = `http://127.0.0.1:${CONFIG.port}`;

  const out = await run(
    vm,
    `set -e
JAR=$(mktemp)
LOGIN=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" -X POST ${base}/api/auth/login \
  -H 'Content-Type: application/json' --data '${auth}')
if [ "$LOGIN" != "200" ]; then echo "login=$LOGIN"; rm -f "$JAR"; exit 1; fi
SAVED=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X PATCH ${base}/api/settings \
  -H 'Content-Type: application/json' --data '${payload}')
ENABLED=$(curl -s -b "$JAR" ${base}/api/settings | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).outboundProxyEnabled))}catch(e){process.stdout.write("unreadable")}})')
rm -f "$JAR"
echo "login=$LOGIN patch=$SAVED enabled=$ENABLED"`,
  );

  const line = (out.split("\n").find((l) => l.includes("login=")) ?? out).trim();
  if (!/enabled=true/.test(line)) {
    log(`• Egress: proxy was NOT applied (${line}) — oc/* will 429`);
    return false;
  }
  log(`• Egress: oc/* leaves through ${mask} (${line.replace(/\s*enabled=true/, "")})`);
  return true;
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

await provision(vm);
await restoreState(vm);
const egressProxied = await applyOutboundProxy(vm);
const counts = await reportState(vm);
await ensureRoute(data.id);
await verify();

header("READY");
log(`  URL      : https://${CONFIG.domain}/dashboard`);
log(`  Password : ${CONFIG.password}`);
log(`  VM       : ${data.id} (${CONFIG.slug})`);
log(`  Dataset  : ${wantBackup ? "restored" : "fresh (archive kept untouched)"}`);
log(`  Contents : providers=${counts.providerConnections ?? 0} combos=${counts.combos ?? 0} apiKeys=${counts.apiKeys ?? 0} customModels=${counts.customModels ?? 0}`);
log(`  Egress   : ${egressProxied ? "oc/* via OUTBOUND_PROXY_URL (free lane answers 200)" : "direct — oc/* will 429"}`);
log(`  Idle     : pauses after ${CONFIG.idleTimeoutSeconds}s, public traffic wakes it in <1s`);
log(`  Stop     : run "9Router Stop" to archive this state and destroy the VM`);
