// Stop: archive the router state, then destroy the VM and everything pointing
// at it.
//
// Order matters: the archive is uploaded *before* anything is deleted, so a
// failed backup leaves a working router instead of an empty disk. Deleting a VM
// cascades its firewall and TLS rules automatically, but the route is removed
// explicitly first so a partial run never leaves a rule aimed at a machine that
// no longer exists.
//
// The archive holds both halves of the state:
//   db/                    the live SQLite database (exact restore)
//   9router-export.json    the official JSON the dashboard exports (portable)
//   jwt-secret, machine-id so sessions and key bindings survive
//
// An empty router never overwrites a good archive unless FORCE_BACKUP=1, so a
// "fresh start" experiment cannot silently destroy the real configuration.
//
// DNS records are deliberately left alone: the hostname is permanent and will
// be re-routed to the next VM on the next Start.
import {
  CONFIG,
  BACKUP,
  backupConfigured,
  client,
  log,
  header,
  run,
  tryRun,
  ensureRunning,
  exportState,
  stateIsEmpty,
  seal,
  uploadBackup,
} from "./lib.mjs";

const freestyle = client();

header(`9Router Stop — ${CONFIG.domain} (VM "${CONFIG.slug}")`);
log(`• State: ${CONFIG.dataDir} (database + official export + secrets) is archived, not discarded`);

// ---------------------------------------------------------------- 1. find VM
const list = await freestyle.vms.list();
const target = (list.vms ?? []).find((v) => v.slug === CONFIG.slug || v.id === CONFIG.slug);
if (!target) log("• VM: not found (already stopped)");

// ---------------------------------------------------------------- 2. backup
let backupOk = false;
let counts = {};
if (target) {
  if (!backupConfigured()) {
    log("• Backup: skipped — BACKUP_ENCRYPTION_KEY / GITHUB_TOKEN not set");
  } else {
    const vm = freestyle.vms.ref(target.id);
    try {
      await ensureRunning(freestyle, vm);

      // A start that failed before provision leaves a VM with no ${CONFIG.dataDir}
      // and no better-sqlite3, so exportState() would crash. There is genuinely
      // nothing to archive — skip the backup and let teardown delete the VM rather
      // than aborting and leaking it.
      const provisioned = (await tryRun(vm, `test -d ${CONFIG.dataDir} && echo yes || echo no`)).out.includes("yes");
      if (!provisioned) {
        log(`• Backup: skipped — ${CONFIG.dataDir} absent (VM was never provisioned), nothing to archive`);
      } else {
      // Export before touching anything: this is the official, portable format.
      const exported = await exportState(vm, "/tmp/9router-export.json");
      counts = exported.counts;
      log(`• State: ${JSON.stringify(counts)}`);

      // Stop the service so SQLite checkpoints its WAL into one clean file.
      await tryRun(vm, "sudo systemctl stop 9router || true");

      const info = await run(
        vm,
        `sudo bash -c '
          set -e
          cd ${CONFIG.dataDir}
          cp /tmp/9router-export.json 9router-export.json
          FILES="db 9router-export.json"
          [ -f jwt-secret ] && FILES="$FILES jwt-secret"
          [ -f machine-id ] && FILES="$FILES machine-id"
          tar czf /tmp/9router-state.tar.gz $FILES
          chmod 644 /tmp/9router-state.tar.gz
          echo "--- archive ---"
          sha256sum /tmp/9router-state.tar.gz
          ls -l /tmp/9router-state.tar.gz
          tar tzf /tmp/9router-state.tar.gz
        '`,
      );
      for (const line of info.split("\n").filter(Boolean)) log(`    ${line}`);

      const raw = new Uint8Array(await vm.fs.readFile("/tmp/9router-state.tar.gz"));
      if (raw.byteLength < 1024) throw new Error(`archive suspiciously small (${raw.byteLength} bytes)`);

      if (stateIsEmpty(counts) && process.env.FORCE_BACKUP !== "1") {
        log("• Backup: router is EMPTY — keeping the previous archive instead of overwriting it");
        log("           (run Stop with FORCE_BACKUP=1 to archive the empty state on purpose)");
      } else {
        await uploadBackup(seal(raw));
        backupOk = true;
      }
      }
    } catch (e) {
      log(`• Backup: FAILED — ${e.message}`);
      if (process.env.ALLOW_UNBACKED_STOP !== "1") {
        header("ABORTED");
        log("  Nothing was deleted: the router is still running and its state is intact.");
        log("  Fix the backup problem, or re-run with ALLOW_UNBACKED_STOP=1 to delete anyway.");
        process.exit(1);
      }
      log("• Backup: continuing anyway (ALLOW_UNBACKED_STOP=1)");
    }
  }
}

// ---------------------------------------------------------------- 3. routes
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

// ---------------------------------------------------------------- 4. VM
if (target) {
  try {
    await freestyle.vms.ref(target.id).delete();
    log(`• VM: deleted ${target.id} (was ${target.state})`);
  } catch (e) {
    log(`• VM: delete failed — ${e.message}`);
    process.exitCode = 1;
  }
}

header("STOPPED");
log(`  Quota     : VM destroyed`);
log(`  State     : ${backupOk ? `archived to release "${BACKUP.tag}" → ${BACKUP.asset}` : "not archived (see above)"}`);
if (backupOk) log(`              providers=${counts.providerConnections ?? "?"} combos=${counts.combos ?? "?"} keys=${counts.apiKeys ?? "?"} customModels=${counts.customModels ?? "?"}`);
log(`  Hostname  : https://${CONFIG.domain} stays configured`);
log(`  Restore   : "9Router Start" (backup ticked) puts this state back`);
