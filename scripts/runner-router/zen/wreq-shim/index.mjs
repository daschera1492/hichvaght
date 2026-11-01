// Drop-in stand-in for the optional `wreq-js` dependency 9router loads for its
// OpenCode free-tier transport.
//
// What 9router expects: `createSession(options)` returning `{ fetch(url, init) }`
// that performs the request with a browser/CLI-like TLS fingerprint. Node cannot
// pass OpenCode's free-tier gate from this process (the gateway answers
// `429 FreeUsageLimitError`), so this shim does not try: it rewrites the request
// to the local zen-proxy (Bun + the real CLI wire shape + harness preamble),
// which is itself inside the kernel egress lock, so the outbound call still
// leaves through the VPN.
//
// The identity headers 9router derives are dropped on purpose: they are not in
// the CLI's format (`ses_` + 32 hex), and zen-proxy mints the pair the gateway
// actually accepts.

const BASE = (process.env.ZEN_PROXY_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");

// Headers the gateway tie-breaks on; zen-proxy sets all of them itself.
const DROP = new Set([
  "host",
  "connection",
  "x-opencode-session",
  "x-opencode-session-id",
  "x-opencode-project",
  "x-opencode-client",
  "x-session-affinity",
  "x-session-id",
  "user-agent",
]);

function target(url) {
  const u = String(url || "");
  // Already pointed at the shim: leave it alone (no rewrite loop).
  if (u.startsWith(BASE)) return u;
  if (!/^https?:\/\/opencode\.ai(\/|$)/i.test(u)) return u; // Grok, etc.: real fetch
  if (/\/messages(\?|$)/.test(u)) return `${BASE}/v1/messages`;
  if (/\/responses(\?|$)/.test(u)) return `${BASE}/v1/responses`;
  return `${BASE}/v1/chat/completions`;
}

export function createSession(_options = {}) {
  return {
    async fetch(url, init = {}) {
      const headers = {};
      for (const [k, v] of Object.entries(init.headers || {})) {
        if (!DROP.has(k.toLowerCase())) headers[k] = v;
      }
      if (!Object.keys(headers).some((k) => k.toLowerCase() === "authorization")) {
        headers.authorization = "Bearer public";
      }
      if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
        headers["content-type"] = "application/json";
      }

      // 9router hands us its own timeout and its request signal; honour both.
      const controller = new AbortController();
      const forward = () => controller.abort(init.signal?.reason);
      if (init.signal) {
        if (init.signal.aborted) forward();
        else init.signal.addEventListener("abort", forward, { once: true });
      }
      const ms = Number(init.timeout) > 0 ? Number(init.timeout) : 120_000;
      const timer = setTimeout(() => controller.abort(new Error(`zen-proxy timeout after ${ms}ms`)), ms);
      if (timer.unref) timer.unref();

      try {
        return await fetch(target(url), {
          method: String(init.method || "GET").toUpperCase(),
          headers,
          body: init.body,
          redirect: "follow",
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
        if (init.signal) init.signal.removeEventListener?.("abort", forward);
      }
    },
  };
}

export default { createSession };
