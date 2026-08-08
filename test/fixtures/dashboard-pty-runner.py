import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


pid, fd = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))

marker = os.environ.get("BORG_PTY_READY_MARKER", "online").encode().lower()
output = bytearray()
sent_interrupt = False
deadline = time.monotonic() + 10.0

while time.monotonic() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.1)
    if ready:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        output.extend(chunk)
        if not sent_interrupt and marker in output.lower():
            os.write(fd, b"\x03")
            sent_interrupt = True

    try:
        waited, status = os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        break
    if waited != 0:
        break

try:
    waited, status = os.waitpid(pid, os.WNOHANG)
except ChildProcessError:
    waited, status = pid, 1
if waited == 0:
    os.kill(pid, signal.SIGKILL)
    _, status = os.waitpid(pid, 0)

sys.stdout.buffer.write(output)
sys.stdout.buffer.flush()
if os.WIFEXITED(status):
    raise SystemExit(os.WEXITSTATUS(status))
raise SystemExit(128 + os.WTERMSIG(status))
