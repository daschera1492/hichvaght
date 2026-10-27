// Stop: destroy the 9Router VM and everything that points at it.
//
// Deleting a VM cascades its firewall and TLS rules automatically, but the
// rules are removed explicitly first so a partial run never leaves a route
// aimed at a machine that no longer exists.
//
// The DNS records are deliberately left alone: the hostname is permanent and
// will be re-routed to the next VM on the next Start.
import { CONFIG, client, log, header } from "./lib.mjs";

const freestyle = client();

header(`9Router Stop — ${CONFIG.domain} (VM "${CONFIG.slug}")`);

// ---------------------------------------------------------------- 1. routes
try {
  const { rules } = await freestyle.tls.rules.list();
  const mine = (rules ?? []).filter((r) => r.domain === CONFIG.domain);
  if (!mine.length) log("• Route: nothing to remove");
  for (const r of mine) {
    await freestyle.tls.rules.delete(r.id);
    log(`• Route: deleted ${r.id} (${r.domain} -> ${r.destination?.vmId}:${r.destination?.port})`);
  }
} catch (e) {
  log(`• Route: could not list/delete rules — ${e.message}`);
}

// ---------------------------------------------------------------- 2. VM
try {
  const list = await freestyle.vms.list();
  const mine = (list.vms ?? []).filter((v) => v.slug === CONFIG.slug || v.id === CONFIG.slug);
  if (!mine.length) {
    log("• VM: not found (already stopped)");
  }
  for (const v of mine) {
    await freestyle.vms.ref(v.id).delete();
    log(`• VM: deleted ${v.id} (${v.state})`);
  }
} catch (e) {
  log(`• VM: delete failed — ${e.message}`);
  process.exitCode = 1;
}

header("STOPPED");
log(`  The hostname https://${CONFIG.domain} stays configured.`);
log(`  Run the "9Router Start" workflow to bring it back on the same URL.`);
