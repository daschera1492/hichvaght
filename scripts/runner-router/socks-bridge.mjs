// HTTP CONNECT proxy in front of the AWMVPN SOCKS5 listener.
//
// 9router's provider layer (proxyAwareFetch) reads HTTPS_PROXY / HTTP_PROXY and
// hands that URL straight to undici's ProxyAgent, which only speaks http:// and
// https:// — it rejects socks5h:. AWMVPN exposes SOCKS5, so this sits between
// them and does the protocol translation:
//
//   9router ──HTTP CONNECT──► 127.0.0.1:8118 ──SOCKS5──► 127.0.0.1:10810 ──► Mozilla
//
// The SOCKS5 username/password come from the environment file that router.mjs
// installs (root-only, never printed). Every tunnel is logged with its target,
// which is how a session proves that provider traffic really leaves through the
// VPN instead of merely having a proxy configured.
//
// Usage: node socks-bridge.mjs   (normally started by the socks-bridge service)
import net from "node:net";

const LISTEN = process.env.BRIDGE_LISTEN || "127.0.0.1:8118";
const SOCKS_HOST = process.env.SOCKS_HOST || "127.0.0.1";
const SOCKS_PORT = Number(process.env.SOCKS_PORT || 10810);
const SOCKS_USER = process.env.SOCKS_USER || "router";
const SOCKS_PASS = process.env.SOCKS_PASS || "";
const HEAD_LIMIT = 64 * 1024;

const log = (...a) => console.log(new Date().toISOString(), ...a);

function splitHostPort(target) {
  // [v6]:port | host:port | host (default 443 for CONNECT)
  if (target.startsWith("[")) {
    const end = target.indexOf("]");
    return [target.slice(1, end), Number(target.slice(end + 2) || 443)];
  }
  const i = target.lastIndexOf(":");
  if (i < 0) return [target, 443];
  return [target.slice(0, i), Number(target.slice(i + 1))];
}

// Opens a SOCKS5 tunnel and resolves with the socket once the reply says OK.
// DNS is resolved by the proxy (ATYP=3), matching socks5h:// semantics.
function socksConnect(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: SOCKS_HOST, port: SOCKS_PORT });
    let stage = 0;
    let buf = Buffer.alloc(0);
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };

    socket.setTimeout(20_000, () => fail(new Error("SOCKS5 timeout")));
    socket.on("error", fail);
    socket.on("connect", () => socket.write(Buffer.from([0x05, 0x01, 0x02])));

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        for (;;) {
          if (stage === 0) {
            if (buf.length < 2) return;
            const method = buf[1];
            buf = buf.subarray(2);
            if (method !== 0x02) throw new Error(`SOCKS5 refused username/password (method ${method})`);
            const user = Buffer.from(SOCKS_USER, "utf8");
            const pass = Buffer.from(SOCKS_PASS, "utf8");
            socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
            stage = 1;
          } else if (stage === 1) {
            if (buf.length < 2) return;
            const status = buf[1];
            buf = buf.subarray(2);
            if (status !== 0x00) throw new Error(`SOCKS5 auth rejected (${status})`);
            const name = Buffer.from(host, "utf8");
            const portBuf = Buffer.alloc(2);
            portBuf.writeUInt16BE(port);
            let addr;
            if (net.isIPv4(host)) {
              addr = Buffer.from([0x01, ...host.split(".").map(Number)]);
            } else if (net.isIPv6(host)) {
              throw new Error("IPv6 targets are not supported");
            } else {
              addr = Buffer.concat([Buffer.from([0x03, name.length]), name]);
            }
            socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addr, portBuf]));
            stage = 2;
          } else if (stage === 2) {
            if (buf.length < 5) return;
            if (buf[1] !== 0x00) throw new Error(`SOCKS5 connect failed (${buf[1]})`);
            const atyp = buf[3];
            const need = atyp === 0x01 ? 10 : atyp === 0x04 ? 22 : 7 + buf[4];
            if (buf.length < need) return;
            const extra = buf.subarray(need);
            socket.removeListener("data", onData);
            socket.setTimeout(0);
            socket.pause();
            settled = true;
            if (extra.length) socket.unshift(extra);
            resolve(socket);
            return;
          }
        }
      } catch (err) {
        fail(err);
      }
    };

    socket.on("data", onData);
  });
}

function bridge(client, upstream) {
  client.pipe(upstream);
  upstream.pipe(client);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
}

async function handle(client, head, rest) {
  const [requestLine, ...headerLines] = head.split("\r\n");
  const [method, target] = requestLine.split(" ");

  if (method === "CONNECT") {
    const [host, port] = splitHostPort(target);
    const upstream = await socksConnect(host, port);
    log(`CONNECT ${host}:${port}`);
    client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: socks-bridge\r\n\r\n");
    client.setTimeout(0);
    if (rest.length) upstream.write(rest);
    bridge(client, upstream);
    return;
  }

  // Plain (absolute-form) HTTP through the proxy. Everything 9router talks to is
  // HTTPS, so this exists only so a stray http:// URL does not fail.
  let url;
  try {
    url = new URL(target);
  } catch {
    client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const upstream = await socksConnect(url.hostname, port);
  log(`${method} ${url.host}`);
  const headers = headerLines.filter((l) => l && !/^proxy-connection:/i.test(l));
  upstream.write(`${method} ${url.pathname}${url.search} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`);
  if (rest.length) upstream.write(rest);
  bridge(client, upstream);
}

const server = net.createServer((client) => {
  let head = Buffer.alloc(0);
  client.setTimeout(30_000, () => client.destroy());
  client.on("error", () => client.destroy());

  const onHead = (chunk) => {
    head = Buffer.concat([head, chunk]);
    if (head.length > HEAD_LIMIT) {
      client.destroy();
      return;
    }
    const end = head.indexOf("\r\n\r\n");
    if (end < 0) return;
    client.removeListener("data", onHead);
    client.pause();
    const text = head.subarray(0, end).toString("latin1");
    const rest = head.subarray(end + 4);
    handle(client, text, rest).catch((err) => {
      log(`error ${err.message}`);
      try {
        client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      } catch {
        client.destroy();
      }
    });
  };

  client.on("data", onHead);
});

server.on("error", (err) => {
  log(`listen error ${err.message}`);
  process.exit(1);
});

server.listen(Number(LISTEN.split(":").pop()), LISTEN.split(":")[0], () => {
  log(`listening on ${LISTEN} → socks5 ${SOCKS_HOST}:${SOCKS_PORT}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => process.exit(0)));
