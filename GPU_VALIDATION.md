# GPU Validation Matrix

Use this matrix before release candidates that change GPU enumeration,
benchmarking, compute-mode selection, or mining loop behavior. Skip hardware
rows only when the machine does not have that class of adapter, and record the
skip reason in release notes.

## Commands

```powershell
npm run test:frontend
npm run build
cargo test --manifest-path src-tauri\Cargo.toml
cargo clippy --manifest-path src-tauri\Cargo.toml -- -D warnings
$env:BTC_LOTTERY_PET_RUN_GPU_HARDWARE_TESTS = "1"
cargo test --manifest-path src-tauri\Cargo.toml gpu
```

Run hardware tests only on a machine where GPU compute load is acceptable.

## Matrix

| Scenario | Required machine | Checks | Expected result |
| --- | --- | --- | --- |
| No compatible hardware GPU | Windows VM or CPU-only system | Open Settings, choose GPU Only, click START in real mode | UI refuses real mining with a hardware GPU message; software adapters stay disabled. |
| Software adapter present | Windows system exposing WARP or CPU OpenCL | Open Settings and inspect GPU list | Software entries are disabled, Auto remains available, and real GPU mining does not select software devices. |
| wgpu hardware path | DX12/Vulkan-capable GPU | Run GPU benchmark, then GPU Only real mining | Benchmark reports a real device, detail mode shows `wgpu`, GPU dispatch fields update, CPU hash threads stay `0`. |
| OpenCL fallback path | Older GPU or driver where OpenCL is the available backend | Select an `OpenCL` device or use Auto when wgpu is unavailable | Benchmark reports OpenCL, real mining initializes, and detail mode shows OpenCL backend/device details. |
| Hybrid mining | Any compatible hardware GPU | Select CPU + GPU with Eco and start real mining | One GPU worker runs with the selected CPU preset; CPU thread count is not silently changed to GPU-only. |
| Sustained throttle | Any compatible hardware GPU | Mine for at least 5 minutes at `10%`, then at `100%` | `GPU perf` logs appear at low frequency; throttle sleep is nonzero at low limit and `Off` or near zero at `100%`. |
| Driver/backend failure | Machine where invalid GPU id or driver failure can be reproduced safely | Start GPU Only with unavailable backend/device | Status becomes `GPU unavailable`, logs contain the failure reason, and GPU-only does not appear to keep mining with zero workers. |

## Evidence To Capture

- GPU device list from Settings or diagnostic JSON.
- `RUN BENCHMARK` result: device, backend mode, hashrate, intensity, note.
- Detail mode GPU fields during real mining: backend, device, dispatch,
  throttle.
- Relevant `GPU miner initialized`, `GPU perf`, or `GPU unavailable` log lines.
- Whether the row passed, failed, or was skipped with a reason.
