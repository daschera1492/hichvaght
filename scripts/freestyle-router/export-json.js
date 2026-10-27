// Build 9router's official export JSON straight from data.sqlite.
// Mirrors the inverse of app/src/lib/db/migrate.js importLegacyMain(), so the
// file is byte-compatible with the dashboard's Export button.
const Database = require("better-sqlite3");
const fs = require("fs");

const DB = "/root/.9router/db/data.sqlite";
const OUT = process.argv[2] || "/tmp/9router-export.json";

const db = new Database(DB, { readonly: true });
const pj = (s, fallback) => {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};
const all = (q) => db.prepare(q).all();

const settings = all("SELECT data FROM settings WHERE id = 1")[0];

const out = {
  settings: pj(settings?.data, {}),
  providerConnections: all("SELECT * FROM providerConnections").map((r) => ({
    ...pj(r.data, {}),
    id: r.id,
    provider: r.provider,
    authType: r.authType,
    name: r.name,
    email: r.email,
    priority: r.priority,
    isActive: !!r.isActive,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  })),
  providerNodes: all("SELECT * FROM providerNodes").map((r) => ({
    ...pj(r.data, {}),
    id: r.id,
    type: r.type,
    name: r.name,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  })),
  proxyPools: all("SELECT * FROM proxyPools").map((r) => ({
    ...pj(r.data, {}),
    id: r.id,
    isActive: !!r.isActive,
    testStatus: r.testStatus,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  })),
  apiKeys: all("SELECT * FROM apiKeys").map((r) => ({
    id: r.id,
    key: r.key,
    name: r.name,
    machineId: r.machineId,
    isActive: !!r.isActive,
    createdAt: r.createdAt,
  })),
  combos: all("SELECT * FROM combos").map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    models: pj(r.models, []),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  })),
  modelAliases: Object.fromEntries(all("SELECT key, value FROM kv WHERE scope = 'modelAliases'").map((r) => [r.key, pj(r.value, {})])),
  customModels: all("SELECT value FROM kv WHERE scope = 'customModels'").map((r) => pj(r.value, {})),
  mitmAlias: Object.fromEntries(all("SELECT key, value FROM kv WHERE scope = 'mitmAlias'").map((r) => [r.key, pj(r.value, {})])),
  pricing: Object.fromEntries(all("SELECT key, value FROM kv WHERE scope = 'pricing'").map((r) => [r.key, pj(r.value, {})])),
};

fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
const counts = Object.fromEntries(
  ["providerConnections", "providerNodes", "proxyPools", "apiKeys", "combos", "customModels"].map((k) => [k, out[k].length]),
);
console.log("exported " + OUT + " (" + fs.statSync(OUT).size + " bytes)");
console.log(JSON.stringify(counts));
