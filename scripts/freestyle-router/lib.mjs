// Shared helpers for the 9Router-on-Freestyle Start/Stop workflows.
//
// Every Freestyle shape used here was verified against the live API (freestyle@0.2.20):
//   - vms.create({ snapshotId, slug, idleTimeoutSeconds, firewall })
//   - vms.ref(slug) -> handle with .exec()/.data()/.start()/.pause()/.delete()
//   - tls.rules.create({ action, domain, source, destination })
//   - deleting a VM cascades its firewall + tls rules automatically
//
// State persistence: Freestyle has no volumes, so a destroyed VM loses
// everything inside it. Stop therefore exports 9router's own backup JSON *and*
// archives the SQLite database, seals the bundle with AES-256-GCM, and stores it
// as a GitHub release asset. Start puts it back into the brand-new VM.
import { Freestyle } from "freestyle";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export const CONFIG = {
  domain: process.env.ROUTER_DOMAIN || "router.codol.ir",
  slug: process.env.ROUTER_SLUG || "nine-router",
  displayName: "9Router",
  port: Number(process.env.ROUTER_PORT || 20128),
  password: process.env.NINE_ROUTER_PASSWORD || "*m96319631Z-",
  // Pause the VM after this much idle time. Public traffic wakes it again
  // (measured: ~0.7 s), so this costs nothing in practice.
  idleTimeoutSeconds: Number(process.env.IDLE_TIMEOUT_SECONDS || 1200),
  snapshotId: process.env.FREESTYLE_SNAPSHOT || "freestyle/ubuntu-sm",
  zoneName: process.env.CF_ZONE_NAME || "codol.ir",
  zoneId: process.env.CF_ZONE_ID || "bf636ce15fffa706d4c393463276b6ee",
  dataDir: "/root/.9router",
  runtimeNodePath: "/root/.9router/runtime/node_modules",
};

export const BACKUP = {
  tag: process.env.BACKUP_RELEASE_TAG || "router-backup",
  asset: process.env.BACKUP_ASSET_NAME || "9router-state.tar.gz.enc",
  // One generation older than `asset`. Every upload moves the current archive
  // here first, so a bad backup can never destroy the last good one.
  prevAsset: process.env.BACKUP_PREV_NAME || "9router-state.prev.tar.gz.enc",
  // Baseline config: the owner's own 9router export. Applied only when no state
  // archive exists, i.e. right after Reset.
  seedAsset: process.env.BACKUP_SEED_NAME || "9router-seed.json.enc",
  repo: process.env.GITHUB_REPOSITORY || "daschera1492/hichvaght",
  token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
  passphrase: process.env.BACKUP_ENCRYPTION_KEY || "",
};

export function client() {
  const apiKey = process.env.FREESTYLE_API_KEY;
  if (!apiKey) throw new Error("FREESTYLE_API_KEY is not set");
  return new Freestyle({ apiKey });
}

export const log = (...a) => console.log(...a);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function header(title) {
  console.log(`\n${"=".repeat(60)}\n${title}\n${"=".repeat(60)}`);
}

/** Run a command in the guest and throw on a non-zero exit status. */
export async function run(vm, command, timeoutMs = 900_000) {
  const r = await vm.exec({ command, timeoutMs });
  const out = ((r.stdout ?? "") + (r.stderr ?? "")).trim();
  if (r.statusCode !== 0) {
    throw new Error(`guest command failed (exit ${r.statusCode}):\n${command}\n--- output ---\n${out}`);
  }
  return out;
}

/** Run a command and return {out, statusCode} without throwing. */
export async function tryRun(vm, command, timeoutMs = 900_000) {
  const r = await vm.exec({ command, timeoutMs });
  return { out: ((r.stdout ?? "") + (r.stderr ?? "")).trim(), statusCode: r.statusCode };
}

export async function waitForState(freestyle, slug, want, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const d = await freestyle.vms.get(slug);
      last = d.state;
      if (d.state === want) return d;
    } catch (e) {
      if (e?.status === 404) { last = "absent"; }
      else throw e;
    }
    await sleep(2000);
  }
  throw new Error(`VM ${slug} never reached "${want}" (last state: ${last})`);
}

/** exec() on a paused VM fails, so bring it back first. */
export async function ensureRunning(freestyle, vm) {
  const d = await vm.data();
  if (d.state === "running") return d;
  log(`• VM: ${d.state} — resuming…`);
  await vm.start();
  return waitForState(freestyle, d.slug || d.id, "running");
}

/** Poll the router's dashboard port until it answers (or time out). */
export async function waitForListener(vm, port = CONFIG.port, attempts = 90) {
  for (let i = 1; i <= attempts; i++) {
    const { out } = await tryRun(vm, `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/dashboard`);
    if (/^[23]/.test(out.trim())) return i;
    await sleep(1000);
  }
  return 0;
}

// ------------------------------------------------------- 9router state (JSON)
// export-json.js reads data.sqlite and rebuilds the exact JSON the dashboard's
// Export button produces (verified: 241,145-byte original reproduced byte for
// byte). It is also our way of counting what a VM actually holds.
export async function installExporter(vm) {
  const src = await readFile(join(here, "export-json.js"), "utf8");
  await vm.fs.writeFile("/tmp/export-json.js", src);
}

/** Write the official export to /tmp/9router-export.json and return its counts. */
export async function exportState(vm, outPath = "/tmp/9router-export.json") {
  await installExporter(vm);
  const out = await run(
    vm,
    `sudo NODE_PATH=${CONFIG.runtimeNodePath} node /tmp/export-json.js ${outPath}`,
    180_000,
  );
  const countsLine = out.split("\n").reverse().find((l) => l.trim().startsWith("{"));
  let counts = {};
  try { counts = countsLine ? JSON.parse(countsLine) : {}; } catch { /* keep {} */ }
  return { out, counts };
}

// A state with no provider connections, combos or custom models carries nothing
// worth restoring, even if the app auto-created an API key for it. Treating such
// a state as "not empty" once let an empty router overwrite a 140-provider
// archive, so the API-key count alone must never keep a backup alive.
export const stateIsEmpty = (counts) =>
  !counts.providerConnections && !counts.combos && !counts.customModels;

// ------------------------------------------------------------------ backup
// AES-256-GCM with a key derived from BACKUP_ENCRYPTION_KEY. The repository is
// public, so nothing may ever be uploaded in the clear: the archive contains
// every provider credential the router knows about.
function backupKey() {
  if (!BACKUP.passphrase) throw new Error("BACKUP_ENCRYPTION_KEY is not set");
  return scryptSync(BACKUP.passphrase, "9router-backup-v1", 32);
}

export function seal(bytes) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", backupKey(), iv);
  const body = Buffer.concat([c.update(Buffer.from(bytes)), c.final()]);
  return Buffer.concat([Buffer.from("9RB1"), iv, c.getAuthTag(), body]);
}

export function unseal(bytes) {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 4).toString("latin1") !== "9RB1") throw new Error("backup has an unknown format");
  const iv = b.subarray(4, 16), tag = b.subarray(16, 32), body = b.subarray(32);
  const d = createDecipheriv("aes-256-gcm", backupKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]);
}

export const backupConfigured = () => Boolean(BACKUP.token && BACKUP.passphrase && BACKUP.repo);

function ghHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${BACKUP.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "9router-freestyle-backup",
    ...extra,
  };
}

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

async function uploadAsset(name, sealedBytes) {
  const release = await ensureRelease();
  for (const a of (release.assets || []).filter((x) => x.name === name)) {
    await fetch(`https://api.github.com/repos/${BACKUP.repo}/releases/assets/${a.id}`, {
      method: "DELETE",
      headers: ghHeaders(),
    });
    log(`• Upload: replaced previous ${name} (asset ${a.id})`);
  }
  const res = await fetch(
    `https://uploads.github.com/repos/${BACKUP.repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
    { method: "POST", headers: ghHeaders({ "Content-Type": "application/octet-stream" }), body: sealedBytes },
  );
  if (!res.ok) throw new Error(`cannot upload ${name}: HTTP ${res.status} ${await res.text()}`);
  const asset = await res.json();
  log(`• Upload: ${name} (${(sealedBytes.length / 1024).toFixed(1)} KiB, asset ${asset.id})`);
  return asset;
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
  // The token must not be forwarded to the storage backend behind the redirect.
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    if (!location) throw new Error("asset redirect had no location");
    const blob = await fetch(location);
    if (!blob.ok) throw new Error(`cannot fetch asset body: HTTP ${blob.status}`);
    return Buffer.from(await blob.arrayBuffer());
  }
  if (!res.ok) throw new Error(`cannot download ${name}: HTTP ${res.status} ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

async function deleteAsset(name) {
  const release = await findRelease();
  if (!release) return false;
  let removed = false;
  for (const a of (release.assets || []).filter((x) => x.name === name)) {
    const res = await fetch(`https://api.github.com/repos/${BACKUP.repo}/releases/assets/${a.id}`, {
      method: "DELETE",
      headers: ghHeaders(),
    });
    if (!res.ok && res.status !== 404) throw new Error(`cannot delete ${name}: HTTP ${res.status}`);
    log(`• Delete: ${name} (asset ${a.id})`);
    removed = true;
  }
  return removed;
}

export async function uploadBackup(bytes) {
  // Rotate first: whatever is live now becomes the rollback copy, so a stop that
  // archives a broken state still leaves the previous good archive recoverable.
  const current = await downloadAsset(BACKUP.asset).catch(() => null);
  if (current && current.length > 4096) {
    await uploadAsset(BACKUP.prevAsset, current);
  }
  return uploadAsset(BACKUP.asset, bytes);
}
export const downloadBackup = () => downloadAsset(BACKUP.asset);
export const downloadBackupPrev = () => downloadAsset(BACKUP.prevAsset);
export const deleteBackup = () => deleteAsset(BACKUP.asset);
export const uploadSeed = (bytes) => uploadAsset(BACKUP.seedAsset, bytes);
export const downloadSeed = () => downloadAsset(BACKUP.seedAsset);
