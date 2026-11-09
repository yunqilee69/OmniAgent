#!/usr/bin/env python3
"""Integration tests; compile the adjacent trusted source in a temporary directory."""
import errno
import os
import platform
import signal
from pathlib import Path
import subprocess
import tempfile
import unittest


class LandlockTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="landlock-test-")
        cls.root = Path(cls.temp.name)
        cls.bin = cls.root / "landlock-run"
        source = Path(__file__).resolve().with_name("landlock-run.c")
        subprocess.run(["cc", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
                        str(source), "-o", str(cls.bin)], check=True)
        cls.probe = subprocess.run([str(cls.bin), "--probe"], capture_output=True, text=True)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def setUp(self):
        if self.probe.returncode:
            if os.environ.get("OMNI_TEST_LANDLOCK") == "1":
                self.fail("Landlock unavailable: " + self.probe.stderr.strip())
            self.skipTest("Landlock unavailable: " + self.probe.stderr.strip())
        self.assertEqual(self.probe.stdout, "landlock: fully enforced\n")
        self.case = tempfile.TemporaryDirectory(dir=self.root)
        self.addCleanup(self.case.cleanup)
        self.base = Path(self.case.name)
        self.allowed = self.base / "allowed"
        self.allowed.mkdir()
        self.outside = self.base / "outside"
        self.outside.write_text("original")

    def run_launcher(self, *args, **kwargs):
        return subprocess.run([str(self.bin), *map(str, args)], capture_output=True,
                              text=True, **kwargs)

    def test_write_and_dev_null(self):
        (self.allowed / "escape").symlink_to(self.outside)
        result = self.run_launcher("--ro", "/", "--rw", "/dev/null", "--rw", self.allowed,
                                   "--", "/bin/sh", "-c",
                                   'printf yes > "$1/file" && printf ok > /dev/null && '
                                   'if printf no > "$2" 2>/dev/null; then exit 1; fi; '
                                   'if printf no > "$1/escape" 2>/dev/null; then exit 1; fi',
                                   "test", self.allowed, self.outside)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.allowed / "file").read_text(), "yes")
        self.assertEqual(self.outside.read_text(), "original")

    def test_truncate_and_reparent_denied(self):
        code = '''import errno, os, sys
p, a = sys.argv[1:]
fd = os.open(p, os.O_RDONLY)
for f in (lambda: os.ftruncate(fd, 0), lambda: os.truncate(p, 0),
          lambda: os.open(p, os.O_RDONLY | os.O_TRUNC),
          lambda: os.unlink(p), lambda: os.rename(p, a + "/moved"),
          lambda: os.link(p, a + "/linked")):
    try: f()
    except OSError as e:
        assert e.errno in (errno.EACCES, errno.EPERM, errno.EXDEV, errno.EINVAL), e
    else: raise AssertionError("operation unexpectedly allowed")
'''
        result = self.run_launcher("--ro", "/", "--rw", self.allowed, "--", "/usr/bin/python3",
                                   "-c", code, self.outside, self.allowed)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.outside.read_text(), "original")

    def test_metadata_mutation_denied(self):
        inside = self.allowed / "inside"
        inside.write_text("inside original")
        code = '''import errno, os, sys
for path in sys.argv[1:]:
    fd = os.open(path, os.O_RDONLY)
    parent = os.open(os.path.dirname(path), os.O_RDONLY | os.O_DIRECTORY)
    name = os.path.basename(path)
    operations = [
        lambda: os.chmod(path, 0o777),
        lambda: os.fchmod(fd, 0o777),
        lambda: os.chmod(name, 0o777, dir_fd=parent),
        lambda: os.chown(path, os.getuid(), os.getgid()),
        lambda: os.lchown(path, os.getuid(), os.getgid()),
        lambda: os.fchown(fd, os.getuid(), os.getgid()),
        lambda: os.chown(name, os.getuid(), os.getgid(), dir_fd=parent),
        lambda: os.utime(path, ns=(1000000000, 1000000000)),
        lambda: os.utime(fd, ns=(1000000000, 1000000000)),
        lambda: os.utime(name, ns=(1000000000, 1000000000), dir_fd=parent),
    ]
    for operation in operations:
        try: operation()
        except OSError as error: assert error.errno == errno.EPERM, error
        else: raise AssertionError("metadata mutation unexpectedly allowed")
    os.close(parent)
    os.close(fd)
'''
        before = [(p.stat().st_mode, p.stat().st_uid, p.stat().st_gid,
                   p.stat().st_mtime_ns) for p in (inside, self.outside)]
        result = self.run_launcher("--ro", "/", "--rw", self.allowed, "--",
                                   "/usr/bin/python3", "-c", code, inside, self.outside)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(before, [(p.stat().st_mode, p.stat().st_uid, p.stat().st_gid,
                                  p.stat().st_mtime_ns) for p in (inside, self.outside)])
        self.assertEqual(inside.read_text(), "inside original")
        self.assertEqual(self.outside.read_text(), "original")

    def test_xattr_mutation_denied(self):
        inside = self.allowed / "inside"
        inside.write_text("inside original")
        try:
            for path in (inside, self.outside):
                os.setxattr(path, "user.landlock_test", b"original")
        except OSError as error:
            if error.errno in (errno.ENOTSUP, errno.EOPNOTSUPP):
                self.skipTest("filesystem does not support user xattrs")
            raise
        code = '''import errno, os, sys
for path in sys.argv[1:]:
    fd = os.open(path, os.O_RDONLY)
    operations = [
        lambda: os.setxattr(path, "user.landlock_test", b"changed"),
        lambda: os.setxattr(path, "user.landlock_test", b"changed", follow_symlinks=False),
        lambda: os.setxattr(fd, "user.landlock_test", b"changed"),
        lambda: os.removexattr(path, "user.landlock_test"),
        lambda: os.removexattr(path, "user.landlock_test", follow_symlinks=False),
        lambda: os.removexattr(fd, "user.landlock_test"),
    ]
    for operation in operations:
        try: operation()
        except OSError as error: assert error.errno == errno.EPERM, error
        else: raise AssertionError("xattr mutation unexpectedly allowed")
    os.close(fd)
'''
        result = self.run_launcher("--ro", "/", "--rw", self.allowed, "--",
                                   "/usr/bin/python3", "-c", code, inside, self.outside)
        self.assertEqual(result.returncode, 0, result.stderr)
        for path, content in ((inside, "inside original"), (self.outside, "original")):
            self.assertEqual(os.getxattr(path, "user.landlock_test"), b"original")
            self.assertEqual(path.read_text(), content)

    def test_new_syscalls_and_io_uring_denied(self):
        code = '''import ctypes, errno
libc = ctypes.CDLL(None, use_errno=True)
for nr in (425, 426, 427, 452, 463, 466):
    ctypes.set_errno(0)
    result = libc.syscall(nr, -1, 0, 0, 0, 0, 0)
    assert result == -1 and ctypes.get_errno() == errno.EPERM, (nr, result, ctypes.get_errno())
'''
        result = self.run_launcher("--ro", "/", "--rw", self.allowed, "--",
                                   "/usr/bin/python3", "-c", code)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_probe_fails_when_seccomp_installation_is_blocked(self):
        if platform.machine() != "x86_64":
            self.skipTest("test filter uses the x86-64 prctl syscall number")
        code = '''import ctypes, os, sys
class Filter(ctypes.Structure):
    _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte),
                ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint)]
class Program(ctypes.Structure):
    _fields_ = [("length", ctypes.c_ushort), ("filter", ctypes.POINTER(Filter))]
f = (Filter * 6)(Filter(0x20, 0, 0, 0), Filter(0x15, 0, 3, 157),
                 Filter(0x20, 0, 0, 16), Filter(0x15, 0, 1, 22),
                 Filter(0x06, 0, 0, 0x50001), Filter(0x06, 0, 0, 0x7fff0000))
p = Program(len(f), f)
libc = ctypes.CDLL(None, use_errno=True)
assert libc.prctl(38, 1, 0, 0, 0) == 0
assert libc.prctl(22, 2, ctypes.byref(p)) == 0
os.execv(sys.argv[1], sys.argv[1:])
'''
        for args in (("--probe",), ("--ro", "/", "--", "/bin/true")):
            with self.subTest(args=args):
                result = subprocess.run(["/usr/bin/python3", "-c", code, str(self.bin), *args],
                                        capture_output=True, text=True)
                self.assertEqual(result.returncode, 125, result.stderr)
                self.assertIn("install seccomp filter", result.stderr)
                self.assertNotIn("fully enforced", result.stdout)

    def test_x32_syscall_abi_rejected(self):
        if platform.machine() != "x86_64":
            self.skipTest("x32 syscall ABI is x86-64-specific")
        code = ('import ctypes, resource; resource.setrlimit(resource.RLIMIT_CORE, (0, 0)); '
                'ctypes.CDLL(None).syscall(0x40000000 + 39)')
        result = self.run_launcher("--ro", "/", "--", "/usr/bin/python3", "-c", code)
        self.assertEqual(result.returncode, -signal.SIGSYS, result.stderr)

    def test_device_ioctl_denied(self):
        code = '''import errno, fcntl, os
fd = os.open('/dev/null', os.O_RDONLY)
try: fcntl.ioctl(fd, 0x1234)
except OSError as e: assert e.errno == errno.EACCES, e
else: raise AssertionError("device ioctl unexpectedly allowed")
'''
        result = self.run_launcher("--ro", "/", "--", "/usr/bin/python3", "-c", code)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_invalid_grants_and_protocol_fail_closed(self):
        link = self.base / "link"
        link.symlink_to(self.allowed, target_is_directory=True)
        for args in [("--ro", "/", "--rw", link, "--", "/bin/true"),
                     ("--ro", "/", "--rw", self.outside, "--", "/bin/true"),
                     ("--ro", "/", "--rw", "relative", "--", "/bin/true"),
                     ("--ro", "/", "--rw", str(self.allowed) + "/../allowed", "--", "/bin/true"),
                     ("--ro", str(self.base), "--", "/bin/true"),
                     ("--ro", "/", "--rw", self.allowed),
                     ("--probe", "extra"),
                     ("--ro", "/", "--", "/does-not-exist")]:
            with self.subTest(args=args):
                result = self.run_launcher(*args)
                self.assertEqual(result.returncode, 125, result.stderr)
                self.assertTrue(result.stderr.startswith("landlock-run: "), result.stderr)

    def test_extra_inherited_descriptor_closed(self):
        fd = os.open(self.outside, os.O_WRONLY)
        self.addCleanup(os.close, fd)
        code = 'import os,sys; os.write(int(sys.argv[1]), b"bad")'
        result = self.run_launcher("--ro", "/", "--", "/usr/bin/python3", "-c", code, fd,
                                   pass_fds=(fd,))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.outside.read_text(), "original")

    def test_child_exit_status(self):
        result = self.run_launcher("--ro", "/", "--", "/bin/sh", "-c", "exit 42")
        self.assertEqual(result.returncode, 42)


if __name__ == "__main__":
    unittest.main(verbosity=2)
