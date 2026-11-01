# zen/ — vendored OpenCode free-tier gateway shim

These files are a verbatim copy of [12errh/zen-proxy](https://github.com/12errh/zen-proxy)
at commit `a96c00b6e1cb003e31766bd8cf804db081f45f91` (2026-10-31), MIT licensed — see
`LICENSE` next to this file.

Why they are here: OpenCode's free Zen models are served only to requests that look
like the OpenCode CLI — the `/inference/openai/v1` base, the HTTP/TLS stack of Bun
(Node's stack is answered with `429 FreeUsageLimitError`), the v2 identity headers and
the harness system preamble. 9router's built-in `oc` transport speaks the legacy
`/inference/v1` base from Node, so every free-model call is refused with
`429 FreeUsageLimitError` no matter which VPN exit the runner uses. This proxy is run
locally (uid "nine", inside the kernel egress lock) and receives 9router's `oc`
traffic through the `wreq-js` shim in `wreq-shim/`.

Local changes: none to the vendored code. `router.mjs` writes the `zen-proxy.json`
config at install time.
