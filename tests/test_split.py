"""Run: python -m unittest discover -s tests -v. Uses isolated temporary data."""
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

PROJECT = Path(__file__).resolve().parents[1]

def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

class SplitIntegration(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.backend = module('backend_under_test', PROJECT/'backend/server.py')
        self.frontend = module('frontend_under_test', PROJECT/'frontend/serve.py')
        self.backend.ROOT = Path(self.temp.name)/'gallery'
        self.backend.ROOT.mkdir()
        self.backend.DB = self.backend.ROOT/'data/library.json'
        self.auth_module = module('auth_helpers', PROJECT/'backend/auth.py')
        self.auth_path = Path(self.temp.name)/'auth.json'
        self.test_password = 'unit-test-password'
        self.auth_module.set_password(self.auth_path, self.test_password)
        self.backend.AUTH = self.backend.AuthStore(self.auth_path)
        self.token = ''
        self.back = self.backend.ThreadingHTTPServer(('127.0.0.1', 0), self.backend.Handler)
        self.front = self.frontend.ThreadingHTTPServer(('127.0.0.1', 0), self.frontend.FrontendHandler)
        self.backend_url = f'http://127.0.0.1:{self.back.server_port}'
        self.frontend_url = f'http://127.0.0.1:{self.front.server_port}'
        self.front.api_url = self.backend_url
        self.backend.ALLOWED_ORIGINS = {self.frontend_url}
        for server in (self.back, self.front):
            threading.Thread(target=server.serve_forever, daemon=True).start()

    def tearDown(self):
        for server in (self.back, self.front):
            server.shutdown()
            server.server_close()
        self.temp.cleanup()

    def request(self, base, route, method='GET', body=None, origin=None, token=None, extra_headers=None):
        headers = {'Content-Type':'application/json'}
        auth_token = self.token if token is None else token
        if auth_token:
            headers['Authorization'] = 'Bearer '+auth_token
        if origin:
            headers['Origin'] = origin
        if extra_headers:
            headers.update(extra_headers)
        if method == 'OPTIONS':
            headers.update({'Access-Control-Request-Method':'PATCH', 'Access-Control-Request-Headers':'content-type'})
        req = urllib.request.Request(base+route, method=method, headers=headers,
            data=json.dumps(body).encode() if body is not None else None)
        try:
            response = urllib.request.urlopen(req, timeout=4)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            content = response.read()
            if response.headers.get_content_type() == 'application/json' and content:
                content = json.loads(content)
            return response.status, response.headers, content

    def test_services_cors_crud_and_preview(self):
        f, b, origin = self.frontend_url, self.backend_url, self.frontend_url
        config_before = (PROJECT/'frontend/config.js').read_bytes()
        status, _, html = self.request(f, '/')
        self.assertEqual(status, 200)
        self.assertIn(b'/config.js', html)
        self.assertNotIn(b'/static/', html)
        self.assertIn(b.encode(), self.request(f, '/config.js')[2])
        self.assertEqual(config_before, (PROJECT/'frontend/config.js').read_bytes())
        for route in ('/app.js', '/style.css', '/theme.js'):
            self.assertEqual(self.request(f, route)[0], 200)
        for method in ('GET', 'HEAD'):
            for route in ('/api/library', '/data/library.json', '/projects/sample/index.html', '/serve.py', '/../backend/server.py'):
                self.assertEqual(self.request(f, route, method)[0], 404)
            for route in ('/', '/index.html', '/static/app.js', '/server.py', '/data/library.json'):
                self.assertEqual(self.request(b, route, method)[0], 404)
        self.assertEqual(self.request(b, '/api/health')[2]['service'], 'prompt-gallery-backend')
        status, headers, _ = self.request(b, '/api/projects/x', 'OPTIONS', origin=origin)
        self.assertEqual(status, 204)
        self.assertEqual(headers['Access-Control-Allow-Origin'], origin)
        self.assertIn('PATCH', headers['Access-Control-Allow-Methods'])
        self.assertEqual(self.request(b, '/api/groups', 'OPTIONS', origin='https://other.example')[0], 403)
        self.assertEqual(self.request(b, '/api/groups', 'POST', {'title':'no'}, 'null')[0], 403)
        self.assertEqual(self.request(b, '/api/groups', 'POST', {'title':'no'}, origin)[0], 401)
        status, _, session = self.request(b, '/api/auth/login', 'POST', {'password':self.test_password}, origin)
        self.assertEqual(status, 200)
        self.token = session['token']
        status, headers, group = self.request(b, '/api/groups', 'POST', {'title':'test', 'prompt':'same prompt'}, origin)
        self.assertEqual(status, 201)
        self.assertEqual(headers['Access-Control-Allow-Origin'], origin)
        source = Path(self.temp.name)/'source'
        source.mkdir()
        original = '<!doctype html><html><head><script type="module" src="scene.js"></script></head><body>Scene</body></html>'
        (source/'index.html').write_text(original)
        (source/'scene.js').write_text('window.sceneReady=true;')
        payload = {'title':'one', 'model':'GPT6 Astra', 'groupId':group['id'], 'source':str(source),
            'modelProvider':'official', 'agentTool':'Codex', 'projectDate':'2026-09-10', 'durationSeconds':330, 'reasoningEffort':'high'}
        status, _, project = self.request(b, '/api/projects', 'POST', payload, origin)
        self.assertEqual(status, 201)
        preview = project['previewUrl']
        self.assertTrue(preview.startswith('/projects/'))
        for query in ('', '?split=1'):
            status, headers, html = self.request(b, preview+query)
            self.assertEqual(status, 200)
            self.assertEqual(headers['Access-Control-Allow-Origin'], '*')
            self.assertLess(html.index(b'render-lifecycle.js'), html.index(b'type="module"'))
            self.assertEqual(b'preview-bridge.js' in html, bool(query))
            self.assertIn('must-revalidate', headers['Cache-Control'])
            cached_status, _, cached_body = self.request(b, preview+query, extra_headers={'If-None-Match':headers['ETag']})
            self.assertEqual(cached_status, 304)
            self.assertEqual(cached_body, b'')
        self.assertEqual(self.request(b, preview.replace('index.html','scene.js'))[2], b'window.sceneReady=true;')
        for name in ('render-lifecycle.js', 'preview-bridge.js'):
            self.assertEqual(self.request(b, '/preview-runtime/'+name)[0], 200)
        updated = self.request(b, '/api/projects/'+project['id'], 'PATCH', {'notes':'changed', 'rating':4}, origin)[2]
        self.assertEqual(updated['agentTool'], 'Codex')
        self.assertEqual(updated['durationSeconds'], 330)
        self.assertEqual(updated['notes'], 'changed')
        self.assertEqual(self.request(b, '/api/projects/reorder', 'POST', {'ids':[project['id']]}, origin)[0], 200)
        self.assertIn('displayOrder', self.request(b, '/api/library', origin=origin)[2]['projects'][0])
        self.assertEqual(self.request(b, '/api/export', origin=origin)[0], 200)
        self.assertEqual((source/'index.html').read_text(), original)
        self.assertEqual(self.request(b, '/api/projects/'+project['id'], 'DELETE', origin=origin)[0], 200)
        self.assertEqual(self.request(b, '/api/library', origin=origin)[2]['projects'], [])
        self.assertEqual(self.request(b, preview)[0], 200)
        self.backend.PUBLIC_PREFIX = '/model-gallery'
        prefixed = self.request(b, preview+'?split=1')[2]
        self.assertIn(b'src="/model-gallery/preview-runtime/render-lifecycle.js', prefixed)
        self.assertIn(b'src="/model-gallery/preview-runtime/preview-bridge.js', prefixed)

    def test_authentication_and_public_view(self):
        b, origin = self.backend_url, self.frontend_url
        self.backend.save({'groups':[{'id':'g','title':'demo','prompt':'test'}],
            'projects':[{'id':'p','groupId':'g','title':'demo','source':'/private/source/scene.html',
                         'previewUrl':'/projects/sample/index.html','model':'Qwen','internal_secret':'not public'}]})
        original = self.backend.DB.read_bytes()
        public = self.request(b, '/api/library', origin=origin)[2]
        self.assertNotIn('source', public['projects'][0])
        self.assertNotIn('internal_secret', public['projects'][0])
        routes = [('POST','/api/groups'),('PATCH','/api/groups/g'),('DELETE','/api/groups/g'),
                  ('POST','/api/projects'),('PATCH','/api/projects/p'),('DELETE','/api/projects/p'),
                  ('POST','/api/projects/reorder'),('GET','/api/export'),('HEAD','/api/export')]
        for method, route in routes:
            with self.subTest(method=method, route=route):
                status = self.request(b, route, method, {} if method not in ('GET','HEAD') else None, origin)[0]
                self.assertEqual(status, 401)
                self.assertEqual(self.backend.DB.read_bytes(), original)
        self.assertEqual(self.request(b, '/data/auth.json')[0], 404)
        self.assertEqual(self.request(b, '/api/auth/session', origin=origin)[0], 401)
        self.assertEqual(self.request(b, '/api/auth/login', 'POST', {'password':'wrong'}, origin)[0], 401)
        status, headers, logged_in = self.request(b, '/api/auth/login', 'POST', {'password':self.test_password}, origin)
        self.assertEqual(status, 200)
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(headers['Access-Control-Allow-Origin'], origin)
        self.token = logged_in['token']
        self.assertGreater(len(self.token), 32)
        self.assertNotIn(self.token, self.backend.AUTH.sessions)
        self.assertEqual(self.request(b, '/api/auth/session', origin=origin)[2]['authenticated'], True)
        self.assertIn('source', self.request(b, '/api/library', origin=origin)[2]['projects'][0])
        self.assertEqual(self.request(b, '/api/export', origin=origin)[0], 200)
        preflight = self.request(b, '/api/projects/p', 'OPTIONS', origin=origin)[1]
        self.assertIn('Authorization', preflight['Access-Control-Allow-Headers'])
        self.assertEqual(self.request(b, '/api/projects/p', 'PATCH', {}, 'https://untrusted.example')[0], 403)
        self.assertEqual(self.request(b, '/api/auth/logout', 'POST', {}, origin)[0], 200)
        self.assertEqual(self.request(b, '/api/auth/session', origin=origin)[0], 401)
        self.assertEqual(self.request(b, '/api/projects/p', 'DELETE', origin=origin)[0], 401)
        self.assertEqual(self.request(b, '/api/library', origin=origin)[0], 401)
        self.token = ''
        self.assertEqual(self.request(b, '/api/library', origin=origin)[0], 200)

    def test_password_hash_rate_limit_and_expiry(self):
        now = [1000]
        auth = self.backend.AuthStore(self.auth_path, ttl=10, clock=lambda:now[0])
        self.assertNotIn(self.test_password, self.auth_path.read_text())
        session = auth.login(self.test_password, 'client-a')
        self.assertTrue(auth.session(session['token']))
        now[0] += 11
        self.assertIsNone(auth.session(session['token']))
        for _ in range(5):
            with self.assertRaises(self.backend.AuthError) as error:
                auth.login('incorrect', 'client-b')
            self.assertEqual(error.exception.status, 401)
        with self.assertRaises(self.backend.AuthError) as error:
            auth.login(self.test_password, 'client-b')
        self.assertEqual(error.exception.status, 429)
        now[0] += 301
        session = auth.login(self.test_password, 'client-b')
        self.auth_module.set_password(self.auth_path, 'changed-test-password')
        self.assertIsNone(auth.session(session['token']))
        self.auth_path.unlink()
        with self.assertRaises(self.backend.AuthError) as error:
            auth.login(self.test_password, 'client-c')
        self.assertEqual(error.exception.status, 503)

    def test_html_upload_create_replace_and_failures(self):
        b, origin = self.backend_url, self.frontend_url
        self.backend.save({'groups':[{'id':'g','title':'test'}], 'projects':[]})
        def upload(filename, content, metadata, method='POST', route='/api/projects', token=None):
            boundary = 'test-browser-upload-boundary'
            raw = (f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n'.encode()
                   + json.dumps(metadata, ensure_ascii=False).encode('utf-8')
                   + f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\nContent-Type: text/html\r\n\r\n'.encode('utf-8')
                   + content + f'\r\n--{boundary}--\r\n'.encode())
            headers = {'Origin':origin,'Content-Type':f'multipart/form-data; boundary={boundary}'}
            if token:
                headers['Authorization'] = 'Bearer '+token
            req = urllib.request.Request(b+route, data=raw, method=method, headers=headers)
            try:
                response = urllib.request.urlopen(req, timeout=5)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                return response.status, json.load(response)
        data = {'title':'上传作品','groupId':'g','model':'Qwen','modelProvider':'官方','agentTool':'test',
                'reasoningEffort':'default','durationSeconds':120,'projectDate':'2026-09-11'}
        html = '<!doctype html>\r\n<html><body><h1>测试</h1><script>window.demo=1;</script></body></html>'.encode('utf-8')
        self.assertEqual(upload('作品.html', html, data)[0], 401)
        self.token = self.request(b, '/api/auth/login','POST',{'password':self.test_password},origin)[2]['token']
        status, project = upload('作品.html', html, data, token=self.token)
        self.assertEqual(status, 201)
        self.assertEqual(project['originalFilename'], '作品.html')
        old_path = self.backend.ROOT/project['entry'].lstrip('/')
        self.assertEqual(old_path.read_bytes(), html)
        status, _, edited = self.request(b, '/api/projects/'+project['id'], 'PATCH', {'notes':'仅改说明'}, origin)
        self.assertEqual(status, 200)
        self.assertEqual(edited['previewUrl'], project['previewUrl'])
        replacement = b'<!DOCTYPE html><html><body>new</body></html>'
        status, replaced = upload('new.htm', replacement, {'notes':'替换文件'}, 'PATCH', '/api/projects/'+project['id'], self.token)
        self.assertEqual(status, 200)
        self.assertNotEqual(replaced['previewUrl'], project['previewUrl'])
        self.assertEqual(replaced['model'], 'Qwen')
        self.assertEqual(replaced['durationSeconds'], 120)
        self.assertEqual(old_path.read_bytes(), html)
        self.assertEqual((self.backend.ROOT/replaced['entry'].lstrip('/')).read_bytes(), replacement)
        folders = set((self.backend.ROOT/'projects').iterdir())
        for filename, content in [('bad.js',html),('empty.html',b''),('binary.html',b'\x00\xff'),('not.html',b'not html')]:
            self.assertEqual(upload(filename,content,data,token=self.token)[0],400)
            self.assertEqual(set((self.backend.ROOT/'projects').iterdir()),folders)
        self.assertEqual(upload('bad.html',html,{**data,'groupId':'missing'},token=self.token)[0],400)
        self.assertEqual(upload('bad.html',html,{**data,'rating':9},token=self.token)[0],400)
        original_db = self.backend.DB.read_bytes()
        with patch.object(self.backend, 'save', side_effect=OSError('test disk write failure')):
            self.assertEqual(upload('bad.html',html,data,token=self.token)[0],400)
        self.assertEqual(self.backend.DB.read_bytes(),original_db)
        self.assertEqual(set((self.backend.ROOT/'projects').iterdir()),folders)
        self.backend.MAX_HTML_BYTES = 32
        self.assertEqual(upload('large.html', html, data, token=self.token)[0],400)
        self.assertEqual(upload('large.html', b'x'*(140*1024), data, token=self.token)[0],413)

if __name__ == '__main__':
    unittest.main()
