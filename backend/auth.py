"""Single-admin passwords and revocable, expiring opaque bearer sessions."""
from collections import deque
import hashlib
import hmac
import json
from pathlib import Path
import secrets
import threading
import time

def derive(password, salt):
    return hashlib.scrypt(password.encode('utf-8'), salt=salt, n=32768, r=8, p=3, dklen=64, maxmem=64*1024*1024)

class AuthError(Exception):
    def __init__(self, message, status=401):
        super().__init__(message)
        self.status = status

def password_record(password):
    if not isinstance(password, str) or not 10 <= len(password) <= 1024:
        raise ValueError('密码长度需要为 10–1024 个字符。')
    salt = secrets.token_bytes(32)
    digest = derive(password, salt)
    return {'version':1, 'kdf':'scrypt', 'salt':salt.hex(), 'digest':digest.hex()}

def set_password(path, password):
    path = Path(path)
    record = password_record(password)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(record, indent=2), encoding='utf-8')
    temporary.chmod(0o600)
    temporary.replace(path)
    path.chmod(0o600)

class AuthStore:
    def __init__(self, path, ttl=12*60*60, clock=time.time):
        self.path = Path(path)
        self.ttl = ttl
        self.clock = clock
        self.sessions = {}
        self.failures = {}
        self.attempts = deque()
        self.lock = threading.RLock()

    def config(self):
        try:
            raw = self.path.read_bytes()
            value = json.loads(raw)
            if value.get('version') != 1 or value.get('kdf') != 'scrypt':
                raise ValueError()
            salt, digest = bytes.fromhex(value['salt']), bytes.fromhex(value['digest'])
            if len(salt) != 32 or len(digest) != 64:
                raise ValueError()
            return salt, digest, hashlib.sha256(raw).hexdigest()
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            raise AuthError('管理员密码尚未配置或配置无效，请联系管理员。', 503)

    def login(self, password, client):
        if not isinstance(password, str) or not password or len(password) > 1024:
            raise AuthError('请输入有效的管理员密码。', 400)
        with self.lock:
            now = self.clock()
            self.failures = {key:value for key,value in self.failures.items() if now-value[-1] < 300}
            while self.attempts and now-self.attempts[0] >= 60:
                self.attempts.popleft()
            if len(self.attempts) >= 30 or len(self.failures.get(client, [])) >= 5:
                raise AuthError('登录尝试过于频繁，请稍后再试。', 429)
            self.attempts.append(now)
            salt, expected, version = self.config()
            actual = derive(password, salt)
            if not hmac.compare_digest(actual, expected):
                if len(self.failures) >= 1024 and client not in self.failures:
                    self.failures.pop(next(iter(self.failures)))
                self.failures.setdefault(client, []).append(now)
                raise AuthError('密码不正确。')
            self.failures.pop(client, None)
            self.sessions = {key:value for key,value in self.sessions.items() if value['expiresAt'] > now and value['version'] == version}
            if len(self.sessions) >= 128:
                self.sessions.pop(next(iter(self.sessions)))
            token = secrets.token_urlsafe(32)
            expires = int(now + self.ttl)
            self.sessions[self.token_key(token)] = {'expiresAt':expires, 'version':version}
            return {'authenticated':True, 'token':token, 'expiresAt':expires}

    @staticmethod
    def token_key(token):
        return hashlib.sha256(token.encode('utf-8')).hexdigest()

    def session(self, token):
        if not isinstance(token, str) or not token or len(token) > 256:
            return None
        with self.lock:
            key = self.token_key(token)
            session = self.sessions.get(key)
            if not session:
                return None
            try:
                version = self.config()[2]
            except AuthError:
                version = None
            if session['expiresAt'] <= self.clock() or session['version'] != version:
                self.sessions.pop(key, None)
                return None
            return {'authenticated':True, 'expiresAt':session['expiresAt']}

    def logout(self, token):
        if token:
            with self.lock:
                self.sessions.pop(self.token_key(token), None)
