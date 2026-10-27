// Start: create (or resume) the 9Router VM, install it, route the fixed domain.
//
// Tested end-to-end against the live API. Safe to re-run: every step is idempotent.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CONFIG, client, log, sleep, header, run, waitForState } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const freestyle = client();

header(`9Router Start — ${CONFIG.domain} (VM "${CONFIG.slug}")`);

// ---------------------------------------------------------------- 1. DNS
// Done once, permanently. The CNAME must be PROXIED (orange cloud):
// Cloudflare then serves a trusted certificate for the hostname and talks to
// the Freestyle edge itself. This removes any dependency on Freestyle's ACME
// pipeline, which does not issue for this zone.
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

// ---------------------------------------------------------------- 4. TLS rule
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

// ---------------------------------------------------------------- 5. verify
async function verify() {
  // Verified from the runner itself, i.e. the real public path through Cloudflare.
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
await ensureRoute(data.id);
await verify();

header("READY");
log(`  URL      : https://${CONFIG.domain}/dashboard`);
log(`  Password : ${CONFIG.password}`);
log(`  VM       : ${data.id} (${CONFIG.slug})`);
log(`  Idle     : pauses after ${CONFIG.idleTimeoutSeconds}s, wakes on next request`);
log(`  Stop     : run the "9Router Stop" workflow to destroy it`);
