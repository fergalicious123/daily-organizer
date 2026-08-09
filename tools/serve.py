"""Local development server.

`python -m http.server` sends no cache headers at all, which leaves browsers
free to heuristically cache the ES modules. The result is editing a .js file,
reloading, and still running the old code — with no error to explain why.

This is the same server with `Cache-Control: no-store` on everything, so a
reload always fetches what is actually on disk.

    python tools/serve.py [port]

Production is unaffected: GitHub Pages sets its own sensible headers, and the
service worker is network-first for code.
"""

import functools
import http.server
import os
import socketserver
import sys

DEFAULT_PORT = 8000
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    # Keep-alive. The default is HTTP/1.0, which tears down the connection
    # after every file — and this app loads a dozen ES modules, so that is a
    # dozen TCP handshakes for no reason.
    protocol_version = "HTTP/1.1"

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Quieter than the default: one line per request, no timestamp noise.
        sys.stderr.write("%s\n" % (fmt % args))


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    """Threaded, because a serial server is unusable for an ES-module app.

    A plain TCPServer handles one request at a time. This app pulls in a dozen
    modules, so the browser's parallel fetches queue behind each other and a
    load that should take ~100ms takes tens of seconds. `python -m http.server`
    is threaded for exactly this reason; writing a custom server means opting
    back in explicitly.
    """

    daemon_threads = True

    # SO_REUSEADDR means different things per platform. On Unix it just skips
    # the TIME_WAIT wait on restart, which is what you want. On Windows it lets
    # a SECOND process bind a port another process is already serving — both
    # "succeed", requests go to whichever wins the race, and the page loads
    # erratically or not at all with no error anywhere. So: only on Unix.
    allow_reuse_address = os.name != "nt"


def port_in_use(port):
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.4)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT

    # Fail loudly rather than silently double-binding.
    if port_in_use(port):
        print(f"Port {port} is already serving something.")
        print("If that is an old copy of this server, stop it first:")
        print(f'  PowerShell:  Get-NetTCPConnection -LocalPort {port} -State Listen |')
        print(f'               ForEach-Object {{ Stop-Process -Id $_.OwningProcess -Force }}')
        print(f"Or use a different port:  python tools/serve.py {port + 1}")
        sys.exit(1)

    handler = functools.partial(NoCacheHandler, directory=ROOT)

    try:
        with Server(("", port), handler) as httpd:
            print(f"Daily Organizer serving at http://localhost:{port}")
            print("Caching is disabled, so edits show up on reload.")
            print("Press Ctrl+C to stop.")
            try:
                httpd.serve_forever()
            except KeyboardInterrupt:
                print("\nStopped.")
    except OSError as err:
        print(f"Could not start on port {port}: {err}")
        sys.exit(1)


if __name__ == "__main__":
    main()
