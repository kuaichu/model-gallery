"""Local, dependency-free project gallery. Run with Python 3.10+."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit, unquote, parse_qs
import json
import shutil
import uuid
import threading
import datetime
import argparse
import re
import hashlib
import sys
import os
from email import policy
from email.parser import BytesParser

if __package__:
    from .auth import AuthStore, AuthError
else:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from auth import AuthStore, AuthError

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = Path(__file__).resolve().parent / 'runtime'
ALLOWED_ORIGINS = {'http://127.0.0.1:8765', 'http://localhost:8765'}
DB = ROOT / 'data/library.json'
LOCK = threading.RLock()
AUTH = AuthStore(ROOT / 'data/auth.json')
MAX_HTML_BYTES = 20 * 1024 * 1024
PUBLIC_PREFIX = ''

def public_library(data):
    fields = {'id', 'groupId', 'title', 'model', 'notes', 'rating', 'createdAt', 'entry', 'previewUrl',
              'reasoningEffort', 'durationSeconds', 'projectDate', 'modelProvider', 'agentTool', 'displayOrder', 'originalFilename'}
    return {'groups':[{k:v for k,v in group.items() if k in {'id','title','prompt','createdAt'}} for group in data['groups']],
            'projects':[{k:v for k,v in project.items() if k in fields} for project in data['projects']]}

def read():
    return json.loads(DB.read_text(encoding='utf-8')) if DB.exists() else {'groups': [], 'projects': []}

def save(data):
    DB.parent.mkdir(exist_ok=True)
    tmp = DB.with_suffix('.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    tmp.replace(DB)

def identity():
    return uuid.uuid4().hex[:16]

def ordered_projects(projects):
    recent = sorted(projects, key=lambda p: p.get('createdAt', ''), reverse=True)
    return sorted(recent, key=lambda p: p.get('displayOrder', float('inf')))

def reorder_projects(data, ids):
    if not isinstance(ids, list) or not ids or not all(isinstance(i, str) for i in ids) or len(ids) != len(set(ids)):
        raise ValueError('排序列表必须包含不重复的作品 ID。')
    existing = {p['id']: p for p in data['projects']}
    if not set(ids).issubset(existing):
        raise ValueError('作品列表已变化，请刷新后重试。')
    # Filtered/group views replace only their occupied positions, keeping hidden projects intact.
    selected = set(ids)
    replacements = iter(ids)
    for rank, project in enumerate(ordered_projects(data['projects'])):
        project_id = next(replacements) if project['id'] in selected else project['id']
        existing[project_id]['displayOrder'] = rank

def import_source(source):
    source = source.strip().strip('"')
    parsed = urlsplit(source)
    if parsed.scheme in ('http', 'https') and parsed.netloc:
        return source, source
    path = Path(source)
    if not path.is_absolute() or not path.exists():
        raise ValueError('请填写存在的本地文件或文件夹绝对路径，或完整的 http(s) 网址。')
    if path.is_dir():
        standalone = [p for p in path.glob('*.html') if p.name != 'index.html']
        if len(standalone) == 1:
            path = standalone[0]
        elif (path / 'dist/index.html').exists():
            path = path / 'dist'
        elif not (path / 'index.html').exists():
            raise ValueError('目录中没有可运行的 HTML。请先构建项目，再选择 dist 文件夹。')
    if path.is_file() and path.suffix.lower() not in ('.html', '.htm'):
        raise ValueError('请选择 HTML 成品文件或含 index.html 的静态网站目录。')
    folder = ROOT / 'projects' / identity()
    folder.mkdir(parents=True)
    try:
        if path.is_file():
            shutil.copy2(path, folder / 'index.html')
        else:
            # Do not recursively import the gallery into itself.
            if path.resolve() == ROOT or path.resolve() in ROOT.parents:
                raise ValueError('请选择具体作品的静态输出目录。')
            shutil.copytree(path, folder, dirs_exist_ok=True, ignore=shutil.ignore_patterns('node_modules', '.git', '*.pem', '.env*'), symlinks=False)
        entry = '/projects/' + folder.name + '/index.html'
        return entry, entry
    except Exception:
        shutil.rmtree(folder)
        raise

def parse_upload(content_type, payload):
    message = BytesParser(policy=policy.default).parsebytes(
        b'Content-Type: ' + content_type.encode('ascii') + b'\r\nMIME-Version: 1.0\r\n\r\n' + payload)
    if not message.is_multipart() or message.defects:
        raise ValueError('上传格式无效，请重新选择 HTML 文件。')
    parts = {}
    for part in message.iter_parts():
        name = part.get_param('name', header='content-disposition')
        if name not in ('metadata', 'file') or name in parts or part.is_multipart() or part.defects:
            raise ValueError('请一次上传一个 HTML 文件。')
        parts[name] = part
    if set(parts) != {'metadata', 'file'}:
        raise ValueError('请同时提交作品信息和 HTML 文件。')
    metadata = parts['metadata'].get_payload(decode=True)
    if len(metadata) > 64 * 1024:
        raise ValueError('作品信息过长。')
    body = json.loads(metadata.decode('utf-8'))
    filename = re.split(r'[/\\]', parts['file'].get_filename() or '')[-1]
    content = parts['file'].get_payload(decode=True)
    if not filename or len(filename) > 255 or Path(filename).suffix.lower() not in ('.html', '.htm'):
        raise ValueError('只能上传 .html 或 .htm 文件。')
    if not content or len(content) > MAX_HTML_BYTES:
        raise ValueError('HTML 文件不能为空，且不能超过 20 MB。')
    try:
        text = content.decode('utf-8-sig')
    except UnicodeDecodeError:
        raise ValueError('请将 HTML 文件保存为 UTF-8 编码后上传。')
    if '\x00' in text or not re.search(r'<(?:!doctype\s+html|html|head|body|script|svg|div|main|p\b|h[1-6]\b)', text, re.I):
        raise ValueError('文件内容不像 HTML，请上传可独立打开的网页文件。')
    return body, (filename, content)

def store_upload(upload):
    folder = ROOT / 'projects' / identity()
    folder.mkdir(parents=True)
    try:
        (folder / 'index.html').write_bytes(upload[1])
    except OSError:
        (folder / 'index.html').unlink(missing_ok=True)
        folder.rmdir()
        raise
    return '/projects/' + folder.name + '/index.html'

def project_fields(body, old=None, upload=None):
    old = old or {}
    result = {k: str(body.get(k, old.get(k, ''))).strip() for k in ('groupId', 'title', 'model', 'source', 'notes', 'reasoningEffort', 'projectDate', 'modelProvider', 'agentTool')}
    if upload:
        result['source'] = 'upload:' + upload[0]
        result['originalFilename'] = upload[0]
    if len(result['modelProvider']) > 100 or len(result['agentTool']) > 100:
        raise ValueError('模型途径和 Agent 工具各不能超过 100 个字符。')
    if result['projectDate']:
        try:
            if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', result['projectDate']):
                raise ValueError()
            datetime.date.fromisoformat(result['projectDate'])
        except ValueError:
            raise ValueError('项目日期无效，请选择有效的年月日。')
    duration = body.get('durationSeconds', old.get('durationSeconds'))
    if duration is not None and (isinstance(duration, bool) or not isinstance(duration, int) or duration < 0 or duration > 9007199254740991):
        raise ValueError('完成用时必须是非负整数秒，或留空。')
    result['durationSeconds'] = duration
    if result['reasoningEffort'] not in ('', 'default', 'low', 'medium', 'high', 'xhigh', 'max'):
        raise ValueError('思考程度请选择 default、low、medium、high、xhigh 或 max。')
    if not result['title'] or not result['source']:
        raise ValueError('请填写作品名称并上传 HTML 文件。')
    result['model'] = result['model'] or '待补充'
    try:
        result['rating'] = int(body.get('rating', old.get('rating', 0)))
    except (ValueError, TypeError):
        raise ValueError('评分应为 0–5 的整数。')
    if result['rating'] not in range(6):
        raise ValueError('评分应为 0–5 的整数。')
    if upload:
        result['entry'] = result['previewUrl'] = store_upload(upload)
    elif result['source'] != old.get('source'):
        result['entry'], result['previewUrl'] = import_source(result['source'])
    return result

class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        route = urlsplit(self.path).path
        origin = self.headers.get('Origin')
        if route.startswith(('/projects/', '/preview-runtime/')):
            self.send_header('Access-Control-Allow-Origin', '*')
        elif origin in ALLOWED_ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        super().end_headers()

    def do_OPTIONS(self):
        if self.headers.get('Origin') not in ALLOWED_ORIGINS or not urlsplit(self.path).path.startswith('/api/'):
            self.send_error(403)
            return
        self.send_response(204)
        self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, POST, PATCH, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('Access-Control-Max-Age', '600')
        self.end_headers()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def bearer(self):
        value = self.headers.get('Authorization', '')
        prefix, _, token = value.partition(' ')
        return token if prefix.lower() == 'bearer' and len(token) <= 256 else ''

    def require_admin(self):
        session = AUTH.session(self.bearer())
        if not session:
            self.json_response({'error':'请先登录，或重新登录已过期的会话。'}, 401)
        return session

    def json_response(self, value, status=200):
        payload = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        if urlsplit(self.path).path == '/api/export':
            self.send_header('Content-Disposition', 'attachment; filename="library.json"')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(payload)

    def do_GET(self):
        # Accept prefixed asset URLs on the direct backend too, while reverse
        # proxies may strip this prefix before forwarding requests.
        if PUBLIC_PREFIX and self.path.startswith(PUBLIC_PREFIX + '/'):
            self.path = self.path[len(PUBLIC_PREFIX):]
        route = unquote(urlsplit(self.path).path)
        if route == '/api/health':
            self.json_response({'service': 'prompt-gallery-backend', 'ok': True})
            return
        if route == '/api/auth/session':
            session = self.require_admin()
            if session:
                self.json_response(session)
            return
        if route in ('/api/library', '/api/export'):
            session = AUTH.session(self.bearer())
            if (route == '/api/export' or self.headers.get('Authorization')) and not session:
                self.json_response({'error':'请先登录，或重新登录已过期的会话。'}, 401)
                return
            with LOCK:
                data = read()
                self.json_response(data if session else public_library(data))
            return
        if route in ('/preview-runtime/render-lifecycle.js', '/preview-runtime/preview-bridge.js'):
            payload = (RUNTIME / Path(route).name).read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', 'text/javascript; charset=utf-8')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(payload)
            return
        path = (ROOT / route.lstrip('/')).resolve()
        if not route.startswith('/projects/') or not path.is_relative_to((ROOT / 'projects').resolve()) or not path.is_file():
            self.send_error(404)
            return
        if route.startswith('/projects/') and Path(route).suffix.lower() in ('.html', '.htm'):
            path = (ROOT / route.lstrip('/')).resolve()
            if not path.is_relative_to((ROOT / 'projects').resolve()) or path.suffix.lower() not in ('.html', '.htm') or not path.is_file():
                self.send_error(404)
                return
            html = path.read_text(encoding='utf-8')
            lifecycle = f'<script src="{PUBLIC_PREFIX}/preview-runtime/render-lifecycle.js?v=2"></script>'
            head = re.search(r'<head\b[^>]*>', html, re.IGNORECASE)
            if head:
                html = html[:head.end()] + lifecycle + html[head.end():]
            else:
                doctype = re.match(r'\s*<!doctype[^>]*>', html, re.IGNORECASE)
                position = doctype.end() if doctype else 0
                html = html[:position] + lifecycle + html[position:]
            # Expose the known Songting module's controls only in the comparison response.
            # Its source and archived HTML remain unchanged.
            split = parse_qs(urlsplit(self.path).query).get('split') == ['1']
            if split and 'window.sceneDiagnostics=()=>({buildings:7' in html and 'Vn.position.copy(gl())' in html:
                adapter = ';window.__galleryCamera={camera:Vn,controls:_e,cancelMotion:()=>{ln=null;Ar()}};'
                marker = html.index('window.sceneDiagnostics=()=>({buildings:7')
                end = html.index('</script>', marker)
                html = html[:end] + adapter + html[end:]
            if split:
                html += f'<script src="{PUBLIC_PREFIX}/preview-runtime/preview-bridge.js?v=1"></script>'
            payload = html.encode('utf-8')
            etag = '"' + hashlib.sha256(payload).hexdigest() + '"'
            cached = self.headers.get('If-None-Match') == etag
            self.send_response(304 if cached else 200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Cache-Control', 'public, max-age=0, must-revalidate')
            self.send_header('ETag', etag)
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            if not cached and self.command != 'HEAD':
                self.wfile.write(payload)
            return
        if self.command == 'HEAD':
            super().do_HEAD()
        else:
            super().do_GET()

    do_HEAD = do_GET

    def do_POST(self):
        self.mutate('POST')

    def do_PATCH(self):
        self.mutate('PATCH')

    def do_DELETE(self):
        self.mutate('DELETE')

    def mutate(self, method):
        # Both JSON and file uploads require an allowed origin and admin session.
        origin = self.headers.get('Origin')
        if origin and origin not in ALLOWED_ORIGINS:
            self.json_response({'error': '来源不允许。'}, 403)
            return
        route_path = urlsplit(self.path).path
        if not (method == 'POST' and route_path == '/api/auth/login') and not self.require_admin():
            return
        uploaded_folder = None
        try:
            multipart = self.headers.get_content_type() == 'multipart/form-data'
            project_upload = method in ('POST', 'PATCH') and re.fullmatch(r'/api/projects(?:/[0-9a-f]{16})?', route_path)
            if multipart and not project_upload:
                raise ValueError('此接口不接受文件上传。')
            length = int(self.headers.get('Content-Length', 0))
            limit = MAX_HTML_BYTES + 128 * 1024 if multipart else 1024 * 1024
            if length < 0 or length > limit:
                self.json_response({'error':'上传内容过大，HTML 文件不能超过 20 MB。'}, 413)
                return
            if not multipart and method != 'DELETE' and self.headers.get_content_type() != 'application/json':
                raise ValueError('请使用 JSON 格式。')
            self.connection.settimeout(60)
            payload = self.rfile.read(length)
            if len(payload) != length:
                raise ValueError('上传中断，请重新选择文件上传。')
            body, upload = parse_upload(self.headers['Content-Type'], payload) if multipart else (json.loads(payload or b'{}'), None)
            if not isinstance(body, dict):
                raise ValueError('提交内容格式错误。')
            if method == 'POST' and route_path == '/api/auth/login':
                self.json_response(AUTH.login(body.get('password'), self.client_address[0]))
                return
            if method == 'POST' and route_path == '/api/auth/logout':
                AUTH.logout(self.bearer())
                self.json_response({'ok':True})
                return
            route = urlsplit(self.path).path.strip('/').split('/')
            if len(route) not in (2, 3) or route[0] != 'api' or route[1] not in ('groups', 'projects'):
                self.json_response({'error': '未找到接口。'}, 404)
                return
            kind = route[1]
            with LOCK:
                data = read()
                if route == ['api', 'projects', 'reorder'] and method == 'POST':
                    reorder_projects(data, body.get('ids'))
                    save(data)
                    self.json_response(data)
                    return
                old = next((p for p in data[kind] if len(route) == 3 and p['id'] == route[2]), None)
                if method != 'POST' and old is None:
                    self.json_response({'error': '记录不存在。'}, 404)
                    return
                if method == 'DELETE':
                    if kind != 'projects':
                        raise ValueError('请先保留或移走组内作品。')
                    data[kind].remove(old)
                    result = {'ok': True}
                else:
                    if kind == 'groups':
                        result = {k: str(body.get(k, (old or {}).get(k, ''))).strip() for k in ('title', 'prompt')}
                        if not result['title']:
                            raise ValueError('请填写提示词组名称。')
                    else:
                        group_id = body.get('groupId', (old or {}).get('groupId'))
                        if not any(g['id'] == group_id for g in data['groups']):
                            raise ValueError('请选择有效的提示词组。')
                        result = project_fields(body, old, upload)
                        if upload:
                            uploaded_folder = (ROOT / result['entry'].lstrip('/')).parent
                    if method == 'POST':
                        result.update(id=identity(), createdAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
                        data[kind].append(result)
                    else:
                        old.update(result)
                        result = old
                save(data)
                uploaded_folder = None
                self.json_response(result, 201 if method == 'POST' else 200)
        except AuthError as error:
            self.json_response({'error':str(error)}, error.status)
        except (ValueError, OSError) as error:
            if uploaded_folder is not None:
                (uploaded_folder / 'index.html').unlink(missing_ok=True)
                uploaded_folder.rmdir()
            self.json_response({'error': str(error)}, 400)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='127.0.0.1', help='Bind address; default stays local for use behind a reverse proxy')
    parser.add_argument('--port', type=int, default=8766)
    parser.add_argument('--frontend-origin', action='append', help='Allowed frontend origin; repeat for multiple origins')
    parser.add_argument('--public-prefix', default=os.environ.get('GALLERY_PUBLIC_PREFIX', ''), help='External reverse proxy path prefix, e.g. /model-gallery')
    args = parser.parse_args()
    prefix = args.public_prefix.rstrip('/')
    if not re.fullmatch(r'(?:/[A-Za-z0-9_~-]+)*', prefix):
        parser.error('--public-prefix must contain only slash-separated letters, digits, _, ~ or -')
    PUBLIC_PREFIX = prefix
    if args.frontend_origin:
        ALLOWED_ORIGINS = set(args.frontend_origin)
    print(f'作品库后端已启动：http://{args.host}:{args.port}', flush=True)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
