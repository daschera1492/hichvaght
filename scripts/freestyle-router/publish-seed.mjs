// Publish a 9router export JSON as the baseline seed for this repo's lifecycle.
//
// The seed is only used when no Stop archive exists yet (a brand-new setup), so
// a Reset or a first-ever Start still produces a configured router. The file is
// encrypted with BACKUP_ENCRYPTION_KEY before it leaves this machine.
//
//   BACKUP_ENCRYPTION_KEY=… GITHUB_TOKEN=… node publish-seed.mjs ./9router.json
import { readFile } from "node:fs/promises";
import { BACKUP, backupConfigured, log, seal, uploadSeed } from "./lib.mjs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node publish-seed.mjs <path-to-9router-export.json>");
  process.exit(1);
}
if (!backupConfigured()) {
  console.error("BACKUP_ENCRYPTION_KEY, GITHUB_TOKEN and GITHUB_REPOSITORY must be set");
  process.exit(1);
}

const raw = await readFile(file);
const parsed = JSON.parse(raw.toString("utf8"));
log(`seed: ${file} (${(raw.length / 1024).toFixed(1)} KiB)`);
log(
  `counts: providers=${parsed.providerConnections?.length ?? 0} nodes=${parsed.providerNodes?.length ?? 0} ` +
    `combos=${parsed.combos?.length ?? 0} apiKeys=${parsed.apiKeys?.length ?? 0} customModels=${parsed.customModels?.length ?? 0}`,
);
await uploadSeed(seal(raw));
log(`published as "${BACKUP.seedAsset}" in release "${BACKUP.tag}"`);
