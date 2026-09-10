"""Run locally on the backend host; never pass the password on a command line."""
from getpass import getpass
from pathlib import Path
from auth import set_password

if __name__ == '__main__':
    password = getpass('设置管理员密码（至少 10 个字符）：')
    if password != getpass('再次输入密码：'):
        raise SystemExit('两次密码不一致，未修改。')
    set_password(Path(__file__).resolve().parents[1]/'data/auth.json', password)
    print('管理员密码已更新。既有登录会话将失效。')
