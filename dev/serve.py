#!/usr/bin/env python3
"""Local demo server: serves site/ and forwards /api/* to `wrangler dev` on localhost.

Phones on the same wifi only need to reach this one port (wrangler itself
isn't reachable over the LAN on this Mac).

    python3 dev/serve.py            # http://localhost:8000 and http://<lan-ip>:8000
"""
import http.server
import os
import socket
import urllib.error
import urllib.request

PORT = int(os.environ.get("PORT", 8000))
WORKER = os.environ.get("WORKER", "http://127.0.0.1:8787")
SITE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "site")
FORWARD = ("X-Pin", "Content-Type")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=SITE, **kwargs)

    def end_headers(self):
        # Always fetch fresh files while iterating on the demo.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def proxy(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(WORKER + self.path[len("/api"):], data=body, method=self.command)
        for h in FORWARD:
            if self.headers.get(h):
                req.add_header(h, self.headers[h])
        try:
            res = urllib.request.urlopen(req, timeout=15)
            status, data, ctype = res.status, res.read(), res.headers.get("Content-Type")
        except urllib.error.HTTPError as e:
            status, data, ctype = e.code, e.read(), e.headers.get("Content-Type")
        except OSError:
            status, data, ctype = 502, b'{"error":"worker_down"}', "application/json"
        self.send_response(status)
        self.send_header("Content-Type", ctype or "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def route(self, fallback):
        if self.path.startswith("/api/"):
            return self.proxy()
        if fallback:
            return fallback()
        self.send_error(405)

    def do_GET(self):
        self.route(super().do_GET)

    def do_HEAD(self):
        self.route(super().do_HEAD)

    def do_POST(self):
        self.route(None)

    def do_PATCH(self):
        self.route(None)

    def do_DELETE(self):
        self.route(None)


def lan_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except OSError:
        return "your-mac-ip"


if __name__ == "__main__":
    print(f"🍦 Parlour open: http://localhost:{PORT}  ·  phones: http://{lan_ip()}:{PORT}")
    http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
