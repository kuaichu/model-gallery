"""Compatibility launcher: start the independently runnable frontend and backend."""
from pathlib import Path
import argparse
import socket
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent

def main():
    parser = argparse.ArgumentParser(description='Launch both Prompt Gallery services')
    parser.add_argument('--port', type=int, default=8765, help='Frontend port')
    parser.add_argument('--backend-port', type=int, default=8766)
    args = parser.parse_args()
    if args.port == args.backend_port:
        parser.error('前端和后端需要不同端口。')
    for port in (args.port, args.backend_port):
        try:
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', port))
        except OSError:
            parser.error(f'端口 {port} 已占用，请关闭旧服务或选择其他端口。')
    processes = []
    try:
        processes.append(subprocess.Popen([sys.executable, str(ROOT/'backend/server.py'), '--port', str(args.backend_port),
            '--frontend-origin', f'http://127.0.0.1:{args.port}', '--frontend-origin', f'http://localhost:{args.port}'], cwd=ROOT))
        processes.append(subprocess.Popen([sys.executable, str(ROOT/'frontend/serve.py'), '--port', str(args.port),
            '--api-url', f'http://127.0.0.1:{args.backend_port}'], cwd=ROOT))
        print(f'前端：http://127.0.0.1:{args.port}\n后端：http://127.0.0.1:{args.backend_port}\n按 Ctrl+C 同时停止两个服务。', flush=True)
        while all(process.poll() is None for process in processes):
            time.sleep(.5)
        raise SystemExit('一个服务已退出，已停止另一个服务。请检查上方错误信息。')
    except KeyboardInterrupt:
        pass
    finally:
        for process in processes:
            if process.poll() is None:
                process.terminate()
        for process in processes:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()

if __name__ == '__main__':
    main()
