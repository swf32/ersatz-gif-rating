from __future__ import annotations

import functools
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class QuietStaticHandler(SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        return


class ProjectHTTPServer:
    def __init__(self, root: Path, host: str = "127.0.0.1", port: int = 0) -> None:
        self.root = root
        self.host = host
        self.port = port
        self._httpd: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> "ProjectHTTPServer":
        handler = functools.partial(QuietStaticHandler, directory=str(self.root))
        self._httpd = ThreadingHTTPServer((self.host, self.port), handler)
        self.port = int(self._httpd.server_address[1])
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        if self._httpd is not None:
            self._httpd.shutdown()
            self._httpd.server_close()
            self._httpd = None
        if self._thread is not None:
            self._thread.join(timeout=2)
            self._thread = None

    def __enter__(self) -> "ProjectHTTPServer":
        return self.start()

    def __exit__(self, exc_type, exc, tb) -> None:
        self.stop()
