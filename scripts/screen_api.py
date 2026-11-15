#!/usr/bin/env python3
"""QEMU monitor bridge over HTTP, bound to the tailnet only.

  GET /shot.png        -> screendump of the guest, converted to PNG
  GET /stats           -> JSON summary of the same screendump (is it black?)
  GET /hmp?cmd=...     -> run one HMP command and return its output as text

The monitor is QEMU's own HMP socket, so this also gives keyboard and mouse
control of the guest (sendkey, mouse_move, mouse_button) without needing VNC.
"""
import hashlib
import json
import os
import socket
import struct
import sys
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

SOCK = os.environ.get("MON_SOCK", "/var/lib/androidvm/mon.sock")
TMPDIR = os.environ.get("MON_TMPDIR", "/tmp")


def hmp(cmd, wait=2.0):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(wait)
    s.connect(SOCK)
    try:
        s.recv(4096)
    except Exception:
        pass
    s.sendall((cmd + "\n").encode())
    buf = b""
    end = time.time() + wait
    while time.time() < end:
        try:
            d = s.recv(1 << 16)
        except socket.timeout:
            break
        if not d:
            break
        buf += d
        if b"(qemu)" in buf:
            break
    s.close()
    return buf.decode("utf-8", "replace")


def screendump():
    """Ask QEMU for a framebuffer dump and return (w, h, rgb-bytes)."""
    ppm = os.path.join(TMPDIR, "qemu-shot-%d.ppm" % os.getpid())
    if os.path.exists(ppm):
        os.remove(ppm)
    hmp("screendump " + ppm, wait=3.0)
    for _ in range(40):
        if os.path.exists(ppm) and os.path.getsize(ppm) > 1024:
            break
        time.sleep(0.1)
    with open(ppm, "rb") as f:
        data = f.read()
    try:
        os.remove(ppm)
    except OSError:
        pass
    parts = data.split(b"\n", 3)
    if parts[0].strip() != b"P6":
        raise ValueError("not a P6 ppm: " + repr(parts[0][:20]))
    w, h = (int(x) for x in parts[1].split())
    return w, h, parts[3]


def ppm_to_png(w, h, px):
    stride = w * 3
    raw = b"".join(b"\x00" + px[y * stride:(y + 1) * stride] for y in range(h))

    def chunk(t, d):
        c = t + d
        return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def summarize(w, h, px):
    counts = {}
    nonblack = 0
    for i in range(0, len(px) - 2, 3):
        r, g, b = px[i], px[i + 1], px[i + 2]
        if r or g or b:
            nonblack += 1
            k = "%d,%d,%d" % (r, g, b)
            counts[k] = counts.get(k, 0) + 1
    top = sorted(counts.items(), key=lambda kv: -kv[1])[:8]
    return {
        "width": w,
        "height": h,
        "pixels": w * h,
        "nonblack": nonblack,
        "nonblack_pct": round(100.0 * nonblack / max(1, w * h), 2),
        "top_colors": [{"rgb": k, "count": v} for k, v in top],
        "md5": hashlib.md5(px).hexdigest(),
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="text/plain; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        try:
            if u.path in ("/shot.png", "/stats"):
                w, h, px = screendump()
                if u.path == "/stats":
                    self._send(200, json.dumps(summarize(w, h, px)).encode(),
                               "application/json")
                else:
                    self._send(200, ppm_to_png(w, h, px), "image/png")
                return
            if u.path == "/hmp":
                cmd = (parse_qs(u.query).get("cmd") or ["info status"])[0]
                self._send(200, hmp(cmd).encode())
                return
            if u.path == "/health":
                self._send(200, b"ok")
                return
            self._send(404, b"not found")
        except Exception as e:  # noqa: BLE001
            self._send(500, ("error: %s" % e).encode())


if __name__ == "__main__":
    bind = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8099
    ThreadingHTTPServer((bind, port), Handler).serve_forever()
