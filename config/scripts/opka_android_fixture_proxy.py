"""Strict CI HTTPS CONNECT fixture; no forwarding and no production updater override."""
import http.server
import json
import ssl
from urllib.parse import urlsplit

API = 'api.github.com'
DOWNLOAD = 'github.com'
ASSET = 'release-assets.githubusercontent.com'


def fixture_response(host, path, manifest):
    version = manifest['version']
    root = f'/KOSFin/opka/releases/download/v{version}/'
    if host == API and path == '/repos/KOSFin/opka/git/matching-refs/tags/v':
        return 200, {'Content-Type': 'application/json'}, json.dumps([{'ref': f'refs/tags/v{version}'}]).encode()
    if host == API and path == f'/repos/KOSFin/opka/releases/tags/v{version}':
        return 200, {'Content-Type': 'application/json'}, json.dumps({'draft': False, 'assets': [{'name': 'latest-android.json'}]}).encode()
    if host == DOWNLOAD and path == root + 'latest-android.json':
        return 200, {'Content-Type': 'application/json'}, json.dumps(manifest).encode()
    if host == DOWNLOAD and path == root + 'opka-android.apk':
        return 302, {'Location': f'https://{ASSET}/opka-ci/opka-android.apk'}, b''
    if host == ASSET and path == '/opka-ci/opka-android.apk':
        return 200, {'Content-Type': 'application/vnd.android.package-archive'}, None
    return 403, {}, b'CI fixture route refused'


def create_server(address, certificate, key, manifest, apk, record):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certificate, key)

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        tunnel_host = None

        def setup(self):
            super().setup()
            self.connection.settimeout(30)

        def finish(self):
            try:
                super().finish()
            finally:
                self.connection.close()

        def log_message(self, *_):
            pass

        def do_CONNECT(self):
            if self.path not in {f'{host}:443' for host in (API, DOWNLOAD, ASSET)}:
                record('rejected-connect')
                self.send_error(403)
                return
            self.tunnel_host = self.path[:-4]
            self.send_response(200, 'Connection established')
            self.end_headers()
            self.wfile.flush()
            self.rfile.close()
            self.wfile.close()
            self.connection = context.wrap_socket(self.connection, server_side=True)
            self.rfile = self.connection.makefile('rb', -1)
            self.wfile = self.connection.makefile('wb', 0)
            self.close_connection = False

        def do_GET(self):
            parsed = urlsplit(self.path)
            host = self.headers.get('Host', '').removesuffix(':443')
            path = parsed.path
            if host != self.tunnel_host or parsed.query or parsed.fragment:
                status, headers, body = 403, {}, b'CI fixture route refused'
            else:
                status, headers, body = fixture_response(host, path, manifest)
            record(f'{status}:{host}:{path}' if status != 403 else 'rejected-get')
            self.send_response(status)
            for name, value in headers.items():
                self.send_header(name, value)
            self.send_header('Content-Length', str(apk.stat().st_size if body is None else len(body)))
            self.send_header('Connection', 'close')
            self.end_headers()
            if body is None:
                with apk.open('rb') as stream:
                    while chunk := stream.read(65536):
                        self.wfile.write(chunk)
            elif body:
                self.wfile.write(body)
            self.close_connection = True

    server = http.server.ThreadingHTTPServer(address, Handler)
    server.daemon_threads = True
    return server
