#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/openat2.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/sysmacros.h>
#include <unistd.h>

/* Reject unknown and compatibility syscall ABIs instead of leaving gaps. */
#if defined(__x86_64__) && !defined(__ILP32__)
#define NATIVE_AUDIT_ARCH AUDIT_ARCH_X86_64
#define REJECT_X32 1
#elif defined(__i386__)
#define NATIVE_AUDIT_ARCH AUDIT_ARCH_I386
#elif defined(__aarch64__) && !defined(__ILP32__) && defined(AUDIT_ARCH_AARCH64)
#define NATIVE_AUDIT_ARCH AUDIT_ARCH_AARCH64
#elif defined(__riscv) && __riscv_xlen == 64 && defined(AUDIT_ARCH_RISCV64)
#define NATIVE_AUDIT_ARCH AUDIT_ARCH_RISCV64
#endif

/* Stable syscall numbers for the supported Linux architectures. */
#ifndef __NR_fchmodat2
#define __NR_fchmodat2 452
#endif
#ifndef __NR_io_uring_setup
#define __NR_io_uring_setup 425
#endif
#ifndef __NR_io_uring_enter
#define __NR_io_uring_enter 426
#endif
#ifndef __NR_io_uring_register
#define __NR_io_uring_register 427
#endif
#ifndef __NR_setxattrat
#define __NR_setxattrat 463
#endif
#ifndef __NR_removexattrat
#define __NR_removexattrat 466
#endif
#ifndef SECCOMP_RET_KILL_PROCESS
#define SECCOMP_RET_KILL_PROCESS 0x80000000U
#endif

/* These UAPI bits are stable even when building against older Linux headers. */
#ifndef LANDLOCK_ACCESS_FS_REFER
#define LANDLOCK_ACCESS_FS_REFER (1ULL << 13)
#endif
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif
#ifndef LANDLOCK_ACCESS_FS_IOCTL_DEV
#define LANDLOCK_ACCESS_FS_IOCTL_DEV (1ULL << 15)
#endif

#define WRITE_RIGHTS (LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR | \
    LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR | \
    LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG | \
    LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO | \
    LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM | \
    LANDLOCK_ACCESS_FS_REFER | LANDLOCK_ACCESS_FS_TRUNCATE | LANDLOCK_ACCESS_FS_IOCTL_DEV)

static void die(const char *format, ...)
{
    va_list ap;
    va_start(ap, format);
    fputs("landlock-run: ", stderr);
    vfprintf(stderr, format, ap);
    fputc('\n', stderr);
    va_end(ap);
    exit(125);
}

static void syserr(const char *operation)
{
    int error = errno;
    die("%s: %s", operation, strerror(error));
}

static int secure_open(const char *path)
{
    struct open_how how = {
        .flags = O_PATH | O_CLOEXEC,
        .resolve = RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS,
    };
    if (path[0] != '/') die("grant path must be absolute: %s", path);
    for (const char *p = path; *p;) {
        while (*p == '/') ++p;
        const char *start = p;
        while (*p && *p != '/') ++p;
        if (p - start == 2 && start[0] == '.' && start[1] == '.')
            die("parent traversal in grant path: %s", path);
    }
    int fd = (int)syscall(SYS_openat2, AT_FDCWD, path, &how, sizeof(how));
    if (fd < 0) syserr("open grant path");
    return fd;
}

static int new_ruleset(void)
{
    int abi = (int)syscall(SYS_landlock_create_ruleset, NULL, 0,
                           LANDLOCK_CREATE_RULESET_VERSION);
    if (abi < 0) syserr("query Landlock ABI");
    if (abi < 5) die("Landlock ABI %d is insufficient; ABI 5 or newer is required", abi);
    /* Passing the first field only is compatible with all ABI versions. */
    uint64_t handled = WRITE_RIGHTS;
    int fd = (int)syscall(SYS_landlock_create_ruleset, &handled, sizeof(handled), 0);
    if (fd < 0) syserr("create Landlock ruleset");
    return fd;
}

static void add_rw(int ruleset, const char *path)
{
    int fd = secure_open(path);
    struct stat st;
    if (fstat(fd, &st) < 0) syserr("stat grant path");
    uint64_t allowed = WRITE_RIGHTS;
    if (!strcmp(path, "/dev/null")) {
        if (!S_ISCHR(st.st_mode) || major(st.st_rdev) != 1 || minor(st.st_rdev) != 3)
            die("/dev/null is not the expected character device");
        allowed = LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_TRUNCATE |
                  LANDLOCK_ACCESS_FS_IOCTL_DEV;
    } else if (!S_ISDIR(st.st_mode)) {
        die("writable grant must be a directory or the /dev/null device: %s", path);
    }
    struct landlock_path_beneath_attr rule = { .allowed_access = allowed, .parent_fd = fd };
    if (syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0) < 0)
        syserr("add Landlock rule");
    if (close(fd) < 0) syserr("close grant path");
}

/* Landlock does not mediate these operations. Deny metadata changes even
 * inside writable grants, and disallow io_uring as an alternate syscall path. */
static void restrict_syscalls(void)
{
#ifdef NATIVE_AUDIT_ARCH
#define DENY_SYSCALL(nr) \
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (nr), 0, 1), \
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)
    struct sock_filter filter[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, NATIVE_AUDIT_ARCH, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#ifdef REJECT_X32
        BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000U, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
#endif
#ifdef __NR_chmod
        DENY_SYSCALL(__NR_chmod),
#endif
#ifdef __NR_fchmod
        DENY_SYSCALL(__NR_fchmod),
#endif
#ifdef __NR_fchmodat
        DENY_SYSCALL(__NR_fchmodat),
#endif
        DENY_SYSCALL(__NR_fchmodat2),
#ifdef __NR_chown
        DENY_SYSCALL(__NR_chown),
#endif
#ifdef __NR_fchown
        DENY_SYSCALL(__NR_fchown),
#endif
#ifdef __NR_lchown
        DENY_SYSCALL(__NR_lchown),
#endif
#ifdef __NR_fchownat
        DENY_SYSCALL(__NR_fchownat),
#endif
#ifdef __NR_chown32
        DENY_SYSCALL(__NR_chown32),
#endif
#ifdef __NR_fchown32
        DENY_SYSCALL(__NR_fchown32),
#endif
#ifdef __NR_lchown32
        DENY_SYSCALL(__NR_lchown32),
#endif
#ifdef __NR_utime
        DENY_SYSCALL(__NR_utime),
#endif
#ifdef __NR_utimes
        DENY_SYSCALL(__NR_utimes),
#endif
#ifdef __NR_futimesat
        DENY_SYSCALL(__NR_futimesat),
#endif
#ifdef __NR_utimensat
        DENY_SYSCALL(__NR_utimensat),
#endif
#ifdef __NR_utimensat_time64
        DENY_SYSCALL(__NR_utimensat_time64),
#endif
#ifdef __NR_setxattr
        DENY_SYSCALL(__NR_setxattr),
#endif
#ifdef __NR_lsetxattr
        DENY_SYSCALL(__NR_lsetxattr),
#endif
#ifdef __NR_fsetxattr
        DENY_SYSCALL(__NR_fsetxattr),
#endif
#ifdef __NR_removexattr
        DENY_SYSCALL(__NR_removexattr),
#endif
#ifdef __NR_lremovexattr
        DENY_SYSCALL(__NR_lremovexattr),
#endif
#ifdef __NR_fremovexattr
        DENY_SYSCALL(__NR_fremovexattr),
#endif
        DENY_SYSCALL(__NR_setxattrat),
        DENY_SYSCALL(__NR_removexattrat),
        DENY_SYSCALL(__NR_io_uring_setup),
        DENY_SYSCALL(__NR_io_uring_enter),
        DENY_SYSCALL(__NR_io_uring_register),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program = {
        .len = (unsigned short)(sizeof(filter) / sizeof(filter[0])),
        .filter = filter,
    };
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) < 0)
        syserr("install seccomp filter");
#undef DENY_SYSCALL
#else
    die("unsupported seccomp architecture");
#endif
}

static void enforce(int ruleset)
{
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) syserr("set no_new_privs");
    restrict_syscalls();
    if (syscall(SYS_landlock_restrict_self, ruleset, 0) < 0) syserr("enforce Landlock ruleset");
    if (close(ruleset) < 0) syserr("close Landlock ruleset");
}

int main(int argc, char **argv)
{
    /* Pre-opened descriptors bypass Landlock checks; retain only stdio. */
    if (syscall(SYS_close_range, 3U, ~0U, 0U) < 0) syserr("close inherited descriptors");
    if (argc == 2 && !strcmp(argv[1], "--probe")) {
        int ruleset = new_ruleset();
        add_rw(ruleset, "/dev/null");
        enforce(ruleset);
        if (puts("landlock: fully enforced") == EOF || fflush(stdout) == EOF)
            syserr("write probe result");
        return 0;
    }

    /* Landlock grants are additive, not deny overrides. */
    if (argc < 5 || strcmp(argv[1], "--ro") || strcmp(argv[2], "/"))
        die("usage: --probe | --ro / [--rw PATH ...] -- COMMAND [ARG ...]");
    int ruleset = new_ruleset();
    int i = 3;
    while (i < argc && !strcmp(argv[i], "--rw")) {
        if (i + 1 >= argc) die("missing writable grant path");
        add_rw(ruleset, argv[i + 1]);
        i += 2;
    }
    if (i >= argc || strcmp(argv[i], "--") || i + 1 >= argc || !argv[i + 1][0])
        die("missing separator or command");
    enforce(ruleset);
    execvp(argv[i + 1], &argv[i + 1]);
    syserr("execute command");
    return 125;
}
