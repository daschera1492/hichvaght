import sodium from "libsodium-wrappers";

// One-off helper: copy the Cloudflare secrets from this repository into the
// Polygate loop repository. Values are sealed with the target repository's
// public key, so they travel encrypted and are never printed.

const TOKEN = (process.env.TARGET_TOKEN || "").trim();
const TARGET = "zahraernhty63494/polygate-loop";
const pairs = {
  CF_API_TOKEN: (process.env.SRC_CF_API_TOKEN || "").trim(),
  CF_ZONE_ID: (process.env.SRC_CF_ZONE_ID || "").trim(),
};

if (!TOKEN) throw new Error("TARGET_TOKEN is not set");

const gh = (path, init = {}) =>
  fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "opencode",
      ...(init.headers || {}),
    },
  });

await sodium.ready;

const keyRes = await gh(`/repos/${TARGET}/actions/secrets/public-key`);
if (!keyRes.ok) throw new Error(`public key: HTTP ${keyRes.status} ${await keyRes.text()}`);
const { key, key_id } = await keyRes.json();
const publicKey = sodium.from_base64(key, sodium.base64_variants.ORIGINAL);

for (const [name, value] of Object.entries(pairs)) {
  if (!value) {
    console.log(`${name}: not set in the source repository - skipped`);
    continue;
  }
  const sealed = sodium.crypto_box_seal(sodium.from_string(value), publicKey);
  const res = await gh(`/repos/${TARGET}/actions/secrets/${name}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      encrypted_value: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL),
      key_id,
    }),
  });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${await res.text()}`);
  console.log(`${name}: copied (${value.length} chars)`);
}
