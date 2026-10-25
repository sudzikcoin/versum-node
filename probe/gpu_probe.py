"""The GPU probe: does CUDA work from where this interpreter runs, and what exactly fails if not.

Run twice by the node itself (lib/gpu-probe.mjs, 0.4.4) on first start when an NVIDIA GPU is found and again once
the GPU package set is in — once bare (the owner's own token) and once inside the AppContainer — and by hand through
probe/gpu_probe.ps1 or `versum-node gpu-check`. Writes result.json into
$VERSUM_JOB_OUT (fallback: ./out). Every step records ok, milliseconds and the exact error text, so the two runs
can be diffed line by line: a step that passes bare and fails in the container IS the sandbox's answer.

Steps, in order (each independent of the previous one):
  nvcuda        ctypes-load nvcuda.dll, cuInit(0), cuDriverGetVersion, cuDeviceGetCount, cuDeviceGetName — the
                driver alone, no Python package involved; a CUDA error code here names the real obstacle
                (100 NO_DEVICE, 304 OPERATING_SYSTEM, 999 UNKNOWN, 3 NOT_INITIALIZED, 35 INSUFFICIENT_DRIVER)
  torch         import, torch.version.cuda, torch.cuda.is_available(), device name, a 2048x2048 matmul on the device
                checked against a CPU slice — the one step that must pass for gpu_packages: ok
  cupy          import + a small matmul (informational: cupy finds its CUDA libraries through cuda-pathfinder)
  numba         import + a CPU njit (informational; numba-cuda is not shipped in 0.4.4)
Verdicts: gpu_ok (torch ran on the device), driver_ok (the driver answered — cuInit, cuCtxCreate — but torch is
not here or failed: the answer the node wants on FIRST start, before the 2.8 GB set exists), no_gpu (no driver
library or no device), gpu_blocked (a driver that works elsewhere fails here: the sandbox's answer).
Exit 0 gpu_ok, 3 driver_ok, 2 no_gpu, 1 gpu_blocked.
"""
import ctypes
import json
import os
import platform
import sys
import time


def step(name, fn, result):
    t0 = time.perf_counter()
    r = {"ok": False, "ms": 0}
    try:
        out = fn()
        r["ok"] = True
        if isinstance(out, dict):
            r.update(out)
    except Exception as e:  # noqa: BLE001 — the error text is the result
        r["error"] = "%s: %s" % (type(e).__name__, str(e)[:600])
        if isinstance(e, OSError) and getattr(e, "winerror", None) is not None:
            r["winerror"] = e.winerror
    r["ms"] = int((time.perf_counter() - t0) * 1000)
    result[name] = r
    return r


CUDA_ERRORS = {0: "SUCCESS", 1: "INVALID_VALUE", 2: "OUT_OF_MEMORY", 3: "NOT_INITIALIZED", 4: "DEINITIALIZED",
               35: "INSUFFICIENT_DRIVER", 100: "NO_DEVICE", 101: "INVALID_DEVICE", 304: "OPERATING_SYSTEM",
               999: "UNKNOWN"}


def nvcuda():
    if os.name != "nt":
        lib = ctypes.CDLL("libcuda.so.1")
    else:
        lib = ctypes.WinDLL("nvcuda.dll")
    out = {"loaded": True}
    rc = lib.cuInit(0)
    out["cuInit"] = "%d %s" % (rc, CUDA_ERRORS.get(rc, "?"))
    if rc != 0:
        raise RuntimeError("cuInit returned %d %s" % (rc, CUDA_ERRORS.get(rc, "?")))
    v = ctypes.c_int(0)
    lib.cuDriverGetVersion(ctypes.byref(v))
    out["driver_cuda"] = "%d.%d" % (v.value // 1000, (v.value % 1000) // 10)
    n = ctypes.c_int(0)
    rc = lib.cuDeviceGetCount(ctypes.byref(n))
    if rc != 0:
        raise RuntimeError("cuDeviceGetCount returned %d %s" % (rc, CUDA_ERRORS.get(rc, "?")))
    out["devices"] = n.value
    if n.value == 0:
        raise RuntimeError("no CUDA device")
    name = ctypes.create_string_buffer(256)
    dev = ctypes.c_int(0)
    lib.cuDeviceGet(ctypes.byref(dev), 0)
    lib.cuDeviceGetName(name, 256, dev)
    out["name"] = name.value.decode("utf-8", "replace")
    # a context is where the driver talks to the kernel-mode side: the step an AppContainer is most likely to fail
    ctx = ctypes.c_void_p()
    rc = lib.cuCtxCreate_v2(ctypes.byref(ctx), 0, dev) if hasattr(lib, "cuCtxCreate_v2") else lib.cuCtxCreate(ctypes.byref(ctx), 0, dev)
    out["cuCtxCreate"] = "%d %s" % (rc, CUDA_ERRORS.get(rc, "?"))
    if rc != 0:
        raise RuntimeError("cuCtxCreate returned %d %s" % (rc, CUDA_ERRORS.get(rc, "?")))
    free = ctypes.c_size_t(0)
    total = ctypes.c_size_t(0)
    lib.cuMemGetInfo_v2(ctypes.byref(free), ctypes.byref(total))
    out["vram_mb"] = total.value // 1048576
    return out


def torch_matmul():
    import torch  # noqa: PLC0415

    out = {"version": torch.__version__, "cuda_build": torch.version.cuda, "available": bool(torch.cuda.is_available())}
    if not out["available"]:
        raise RuntimeError("torch.cuda.is_available() is False")
    out["device"] = torch.cuda.get_device_name(0)
    out["capability"] = "%d.%d" % torch.cuda.get_device_capability(0)
    n = 2048
    a = torch.rand(n, n, device="cuda")
    b = torch.rand(n, n, device="cuda")
    torch.cuda.synchronize()
    t0 = time.perf_counter()
    c = a @ b
    torch.cuda.synchronize()
    out["matmul_ms"] = int((time.perf_counter() - t0) * 1000)
    ref = (a[:64].cpu() @ b.cpu())
    err = (c[:64].cpu() - ref).abs().max().item()
    out["max_abs_error"] = err
    if err > 1e-1:
        raise RuntimeError("device result differs from CPU by %g" % err)
    return out


def cupy_matmul():
    import cupy  # noqa: PLC0415

    a = cupy.random.rand(512, 512, dtype=cupy.float32)
    s = float((a @ a).sum())
    return {"version": cupy.__version__, "sum": s}


def numba_jit():
    import numba  # noqa: PLC0415

    @numba.njit
    def f(n):
        s = 0
        for i in range(n):
            s += i
        return s

    return {"version": numba.__version__, "sum": int(f(1000))}


def main():
    out_dir = os.environ.get("VERSUM_JOB_OUT") or os.path.join(os.getcwd(), "out")
    os.makedirs(out_dir, exist_ok=True)
    result = {
        "python": sys.version.split()[0], "platform": platform.platform(), "exe": sys.executable,
        "in_sandbox": os.environ.get("VERSUM_PROBE_MODE", "unknown"),
        "env": {k: os.environ.get(k) for k in ("PATH", "PYTHONPATH", "CUDA_PATH", "VERSUM_JOB_OUT")},
    }
    step("nvcuda", nvcuda, result)
    step("torch", torch_matmul, result)
    step("cupy", cupy_matmul, result)
    step("numba", numba_jit, result)
    err = result["nvcuda"].get("error", "").lower()
    # no driver library at all (a CI runner, a machine without NVIDIA) or a driver with no device: NOT a sandbox verdict
    no_device = (not result["nvcuda"]["ok"]) and ("no_device" in err or "could not be found" in err or "no such file" in err or "cannot open shared object" in err or result["nvcuda"].get("winerror") == 126)
    if result["torch"]["ok"]:
        result["verdict"] = "gpu_ok"
    elif result["nvcuda"]["ok"]:
        result["verdict"] = "driver_ok"
    else:
        result["verdict"] = "no_gpu" if no_device else "gpu_blocked"
    with open(os.path.join(out_dir, "result.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, indent=1)
    for k in ("nvcuda", "torch", "cupy", "numba"):
        r = result[k]
        print("GPUPROBE %-7s %s %s" % (k, "ok  " if r["ok"] else "FAIL", r.get("error", "") if not r["ok"] else json.dumps({kk: vv for kk, vv in r.items() if kk not in ("ok", "ms")})))
    print("GPUPROBE verdict", result["verdict"])
    return {"gpu_ok": 0, "driver_ok": 3, "no_gpu": 2}.get(result["verdict"], 1)


if __name__ == "__main__":
    sys.exit(main())
