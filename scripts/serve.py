"""Serve the site folder on this computer, for trying changes before publishing.

    python scripts/serve.py        -> http://localhost:8790

Python's own server takes file types from the Windows registry, which often
labels .js as plain text; browsers then refuse to run the app's modules.
"""

import http.server
import os
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "site")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8790


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
        ".json": "application/json", ".webmanifest": "application/manifest+json",
        ".svg": "image/svg+xml", ".png": "image/png", ".html": "text/html",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # always the latest edit
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    print("Restaurant Diary on http://localhost:%d" % PORT)
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
