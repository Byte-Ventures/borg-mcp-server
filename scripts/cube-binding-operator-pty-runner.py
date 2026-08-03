import os
import pty
import select
import signal
import sys
import time


pid, fd = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)

payload = sys.stdin.buffer.read()
pending = payload if len(payload) > 2 else b""
if len(payload) <= 2 and payload:
    os.write(fd, payload)

deadline = time.monotonic() + 8.0
while time.monotonic() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.1)
    if not ready:
        try:
            result = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            break
        if result[0] != 0:
            break
        continue
    try:
        chunk = os.read(fd, 65536)
    except OSError:
        break
    if not chunk:
        break
    sys.stdout.buffer.write(chunk)
    sys.stdout.buffer.flush()
    if pending and b"Enrollment invitation" in chunk:
        os.write(fd, pending)
        pending = b""

if pending:
    os.write(fd, pending)

try:
    status = os.waitpid(pid, os.WNOHANG)[1]
except ChildProcessError:
    status = 1
if not os.WIFEXITED(status) and not os.WIFSIGNALED(status):
    os.kill(pid, signal.SIGINT)
    time.sleep(0.2)
    try:
        status = os.waitpid(pid, 0)[1]
    except ChildProcessError:
        status = 1
if os.WIFEXITED(status):
    raise SystemExit(os.WEXITSTATUS(status))
raise SystemExit(128 + os.WTERMSIG(status))
