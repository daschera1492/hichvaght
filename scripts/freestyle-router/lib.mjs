// Shared helpers for the 9Router-on-Freestyle Start/Stop workflows.
//
// Every shape used here was verified against the live API (freestyle@0.2.20):
//   - vms.create({ snapshotId, slug, idleTimeoutSeconds, firewall, tls })
//   - vms.ref(slug) -> handle with .exec()/.data()/.start()/.pause()/.delete()
//   - tls.rules.create({ action, domain, source, destination })
//   - deleting a VM cascades its firewall + tls rules automatically
import { Freestyle } from "freestyle";

export const CONFIG = {
  domain: process.env.ROUTER_DOMAIN || "router.codol.ir",
  slug: process.env.ROUTER_SLUG || "nine-router",
  displayName: "9Router",
  port: Number(process.env.ROUTER_PORT || 20128),
  password: process.env.NINE_ROUTER_PASSWORD || "codol-router-2026",
  // Pause the VM after this much idle time so free-tier quota lasts.
  idleTimeoutSeconds: Number(process.env.IDLE_TIMEOUT_SECONDS || 1200),
  snapshotId: process.env.FREESTYLE_SNAPSHOT || "freestyle/ubuntu-sm",
  zoneName: process.env.CF_ZONE_NAME || "codol.ir",
  zoneId: process.env.CF_ZONE_ID || "bf636ce15fffa706d4c393463276b6ee",
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
