# zen/ — vendored OpenCode free-tier gateway

These files are a verbatim copy of [12errh/zen-proxy](https://github.com/12errh/zen-proxy)
at commit `a96c00b6e1cb003e31766bd8cf804db081f45f91` (2026-10-31), MIT licensed — see
`LICENSE` next to this file.

Why they are here: OpenCode's free Zen models are served only to requests that look
like the OpenCode CLI — the `/inference/openai/v1` base, the HTTP/TLS stack of Bun
(Node's stack is answered with `429 FreeUsageLimitError`), the v2 identity headers and
the harness system preamble. 9router's built-in `oc` transport speaks the legacy
`/inference/v1` base from Node, so every free-model call is refused with
`429 FreeUsageLimitError` no matter which VPN exit the runner uses.

How the runner wires it (see `../router.mjs`):

    ‎9router (oc, uid nine) → 127.0.0.1:8787  compat front (../free-tier-compat.mjs)
                            → 127.0.0.1:8788  zen-proxy (Bun, this directory)
                            → https://opencode.ai/inference/openai/v1

The interception is the `oc` provider's base URL: `installFreeTier()` rewrites
`baseUrl:"https://opencode.ai"` in the app to `http://127.0.0.1:8787`, so the traffic
arrives at the front whatever transport 9router picks. The front rewrites any path to
`/v1/...`, drops the identity headers the gateway refuses, and streams the answer back.
Both services run as the unprivileged user `nine`, inside the kernel egress lock, so
their upstream calls leave through the Mozilla VPN like the rest of 9router.

`wreq-probe.mjs` is not part of zen-proxy: it is an informational probe that calls the
gateway with the real `wreq-js` package (Rust + BoringSSL, browser TLS/HTTP2
fingerprint) to measure whether a future build can drop the Bun hop. `router.mjs` logs
its one line and never fails the run on it.

Local changes: none to the vendored code. `router.mjs` writes the `zen-proxy.json`
config at install time.
