// Informational probe: can the real wreq-js — the package 9router itself
// installs, Rust + BoringSSL with a browser TLS/HTTP2 fingerprint — reach
// OpenCode's free tier directly?
//
// The proven path is the compat front (:8787) → zen-proxy on Bun (:8788), which
// fixes three separate things the gateway fingerprints: the legacy
// /inference/v1 base, Node's TLS stack, and the missing harness preamble. This
// probe only measures the TLS/HTTP2 layer, with the accepted base and preamble,
// so a future build could drop Bun if the answer is 200.
//
// Never fatal: it prints one line and exits 0 either way.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const [appDir, preamblePath, model = "deepseek-v4.1-flash-free"] = process.argv.slice(2);

function say(msg) {
  console.log(msg);
}

if (!appDir || !preamblePath) {
  say("usage: wreq-probe.mjs <app-dir> <preamble-file> [model]");
  process.exit(0);
}

let wreq;
try {
  const require = createRequire(join(appDir, "package.json"));
  wreq = require("wreq-js");
} catch (err) {
  say(`cannot load wreq-js from ${appDir}: ${err.code || err.name} ${String(err.message).slice(0, 120)}`);
  process.exit(0);
}

const version = (() => {
  try {
    // Read the manifest directly: the package's exports map has no "./package.json".
    return JSON.parse(readFileSync(join(appDir, "node_modules/wreq-js/package.json"), "utf8")).version;
  } catch {
    return "?";
  }
})();

const sessionId = `ses_${randomBytes(16).toString("hex")}`;
const preamble = readFileSync(preamblePath, "utf8");

const headers = {
  "content-type": "application/json",
  accept: "text/event-stream",
  authorization: "Bearer public",
  "user-agent": "opencode/latest/2.1.4/cli",
  "x-opencode-client": "cli",
  "x-opencode-project": "global",
  "x-opencode-session": sessionId,
  "x-opencode-session-id": sessionId,
  "x-session-affinity": sessionId,
  "x-session-id": sessionId,
};

const body = JSON.stringify({
  model,
  messages: [
    { role: "system", content: preamble },
    { role: "user", content: "Reply with the single word: ok" },
  ],
  stream: true,
  stream_options: { include_usage: true },
});

const started = Date.now();
try {
  const session = await wreq.createSession({ browser: "chrome_149", os: "linux", timeout: 120_000 });
  try {
    const res = await session.fetch("https://opencode.ai/inference/openai/v1/chat/completions", {
      method: "POST",
      headers,
      body,
    });
    const text = await res.text();
    const first = (text.match(/"content"\s*:\s*"([^"]{0,40})/) || [])[1] || "";
    say(
      `wreq-js ${version} direct: HTTP ${res.status} (${Date.now() - started}ms, ${text.length}B)` +
        (first ? ` first="${first}"` : "") +
        (res.status === 200 ? "" : ` ${text.replace(/\s+/g, " ").slice(0, 200)}`),
    );
  } finally {
    await session.close?.();
  }
} catch (err) {
  say(`wreq-js ${version} direct: request failed — ${String(err.message || err).slice(0, 200)}`);
}
process.exit(0);
