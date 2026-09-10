"""Dependency-free static frontend server. It does not expose API or project files."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import argparse
import json
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
ALLOWED = {'/', '/index.html', '/app.js', '/style.css', '/config.js', '/theme.js'}

class FrontendHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/config.js' and getattr(self.server, 'api_url', None):
            payload = ('window.GALLERY_CONFIG = ' + json.dumps({'apiBaseUrl':self.server.api_url}) + ';\n').encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/javascript; charset=utf-8')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(payload)
            return
        if path == '/': self.path = '/index.html'
        elif path not in ALLOWED:
            self.send_error(404)
            return
        if self.command == 'HEAD':
            super().do_HEAD()
        else:
            super().do_GET()

    do_HEAD = do_GET

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Prompt Gallery static frontend')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--api-url', help='Override config.js in memory; must be an http(s) backend URL')
    args = parser.parse_args()
    if args.api_url and (urlsplit(args.api_url).scheme not in ('http','https') or not urlsplit(args.api_url).netloc):
        parser.error('--api-url must be an absolute http(s) URL')
    server = ThreadingHTTPServer(('127.0.0.1', args.port), FrontendHandler)
    server.api_url = args.api_url
    print(f'作品库前端已启动：http://127.0.0.1:{args.port}', flush=True)
    server.serve_forever()
