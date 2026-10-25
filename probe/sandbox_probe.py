"""The sandbox probe: a job that tries every door the node promises is shut, and writes what happened.

Run by `versum-node sandbox-check` on the machine and by the CI end-to-end job through the hub. Each key in
result.json is True when the sandbox held (the attempt FAILED), False when the job got through. The verdict
is read by lib/native.mjs probeVerdict(): every door must be True, and out_write_ok must be True too (the job
can still do its own work).

It writes nothing anywhere but $VERSUM_JOB_DIR/out and reads nothing it is not supposed to see — the failures
ARE the result.
"""
import json
import os
import platform
import socket
import sys
import time


def blocked(fn):
    try:
        fn()
        return False
    except Exception as e:  # noqa: BLE001 — any refusal counts
        return True


def connect(host, port):
    s = socket.create_connection((host, port), timeout=4)
    s.close()


def dns():
    socket.getaddrinfo("example.com", 443)


def users_dir():
    d = "C:\\Users" if os.name == "nt" else "/Users"
    names = os.listdir(d)
    if not names:
        raise OSError("empty listing")


def home_write():
    # a path outside the job directory: the real profile on Windows, /Users/Shared on macOS (world-writable without a sandbox)
    if os.name == "nt":
        target = os.path.join(os.environ.get("SYSTEMDRIVE", "C:") + "\\", "Users", "Public", "versum-probe.txt")
    else:
        target = "/Users/Shared/versum-probe.txt"
    with open(target, "w") as f:
        f.write("probe")
    os.remove(target)


def temp_outside():
    # the node points TEMP/TMPDIR inside the job directory; writing there must WORK
    import tempfile
    with tempfile.NamedTemporaryFile("w", delete=True) as f:
        f.write("ok")


def main():
    job_dir = os.environ.get("VERSUM_JOB_DIR", os.getcwd())
    out_dir = os.path.join(job_dir, "out")
    t0 = time.time()
    result = {
        "platform": platform.system(),
        "python": sys.version.split()[0],
        "network_blocked": blocked(lambda: connect("1.1.1.1", 443)),
        "dns_blocked": blocked(dns),
        "loopback_blocked": blocked(lambda: connect("127.0.0.1", 3311)) and blocked(lambda: connect("127.0.0.1", 80)),
        "users_dir_blocked": blocked(users_dir),
        "home_write_blocked": blocked(home_write),
        "temp_inside_ok": not blocked(temp_outside),
        "cwd": os.getcwd() == job_dir or os.path.realpath(os.getcwd()) == os.path.realpath(job_dir),
        "env_home_inside": os.environ.get("HOME", os.environ.get("USERPROFILE", "")).startswith(job_dir),
        "piece_args": None,
    }
    try:
        with open(os.path.join(job_dir, "piece.json")) as f:
            result["piece_args"] = json.load(f).get("args")
    except Exception as e:  # noqa: BLE001
        result["piece_args_error"] = str(e)
    try:
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, "result.json"), "w") as f:
            json.dump(result, f, indent=2)
        result["out_write_ok"] = True
    except Exception as e:  # noqa: BLE001
        result["out_write_ok"] = False
        result["out_error"] = str(e)
    result["seconds"] = round(time.time() - t0, 3)
    with open(os.path.join(out_dir, "result.json"), "w") as f:
        json.dump(result, f, indent=2)
    print("PROGRESS probe done", json.dumps({k: v for k, v in result.items() if k != "piece_args"}))


if __name__ == "__main__":
    main()
