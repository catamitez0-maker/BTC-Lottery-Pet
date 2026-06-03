# BTC Lottery Pet

BTC Lottery Pet is a small Windows desktop ornament inspired by BTC lottery
miners and NerdMiner-style displays. It is built with Tauri, React, TypeScript,
and Rust.

The default mode is a local-only simulation. An experimental real mining mode
is available for education and lottery-style solo mining, but it is always off
by default and must be enabled manually in the UI for the current app session.
This project does not promise or guarantee any financial return.

## Features

- 360x260 desktop pet window
- Toggleable **Compact Mode** (default scaled-up desktop pet ornament with a mini stats line) and **Detail Mode** (complete metrics grid and log ticker)
- Always-on-top window with a user-controlled `PIN` / `FREE` toggle
- System tray icon with `Show BTC Lottery Pet` and `Quit`
- Default simulation mode with locally generated stats
- Explicitly enabled real mining mode with a CPU-use warning
- User-controlled BTC address, pool host, pool port, worker name, and CPU thread
  selector
- Safe GPU simulation mode with selectable simulated device and intensity
- Placeholder GPU benchmark that does not start a real GPU workload
- Single-instance protection per app identifier: launching the same flavor
  again focuses its existing window
- Rust Stratum v1 client and cancellable SHA-256d hash loop
- `Stop` control that signals the hash workers to exit immediately
- App log directory file logging with a 1 MiB rotation limit (`mining.log` and
  `mining.log.1`) via Tauri resolvers

BTC Lottery Pet does not hide its process, enable itself at Windows startup,
accept remote-control commands, or start mining automatically.

It never requests or stores a BTC private key or seed phrase.

## Real mining warning

Real mining mode uses CPU time, electricity, and network bandwidth. CPU mining
is not competitive with Bitcoin ASIC hardware and is extraordinarily unlikely
to find a block. Treat the feature as an educational experiment and desktop
lottery display, not an income source.

The Stratum v1 TCP presets are not encrypted. Your public BTC address, worker
name, pool traffic, and IP address are visible to the selected pool and may be
visible to networks between your computer and that pool. Only use pool
operators you trust. The app never asks for or stores a private key or seed
phrase.

The local mining log intentionally omits the pool username because that value
contains your public BTC address.

Solo pool availability, difficulty policies, payout behavior, and
compatibility can change outside this project. Verify the selected pool's
current documentation before mining.

## Supported pool presets

The settings panel includes:

| Pool host | Port | Notes |
| --- | ---: | --- |
| `public-pool.io` | `21496` | Default. Shared Public Pool low-difficulty endpoint listed by the NerdMiner project. |
| `pool.nerdminers.org` | `3333` | Official NerdMiner community pool. Its operator documents hardware restrictions, so verify compatibility before using this desktop client. |

The presets are convenience defaults, not availability guarantees. The pool
host field remains editable so you can use another trusted Stratum v1 solo
pool after reviewing its documentation.

The default worker username sent to the pool is:

```text
<btc_address>.<worker_name>
```

The password sent by the basic Stratum client is `x`.

## Technical scope

The Rust backend owns all real mining work:

1. Open a TCP socket to the configured host and port.
2. Send `mining.subscribe` and `mining.authorize`.
3. Process `mining.set_difficulty`, `mining.set_extranonce`, and
   `mining.notify`.
4. Build the coinbase transaction, Merkle root, and Bitcoin block-header
   candidate.
5. Run SHA-256d nonce loops using no more than the configured CPU thread count.
6. Send qualifying shares with `mining.submit`.
7. Emit only UI statistics: hashrate, accepted shares, rejected shares, best
   difficulty, current job ID, and connection status.

The current client is intentionally small. It supports plain Stratum v1 TCP,
not Stratum TLS, Stratum v2, proxy mode, failover pools, remote management, or
profit-switching.

To keep an untrusted or misconfigured pool from consuming unbounded local
resources, the client caps each Stratum line at 1 MiB, keeps at most 128
unanswered share submissions, and sends at most 16 queued shares before
returning to socket reads. It also rejects non-positive and pathologically low
share difficulties.

## Configuration

The repository-level [`config.json`](./config.json) contains defaults:

```json
{
  "btc_address": "",
  "pool_host": "public-pool.io",
  "pool_port": 21496,
  "worker_name": "btc-lottery-pet",
  "cpu_limit_percent": 10,
  "cpu_threads": 1,
  "real_mining_enabled": false,
  "compute_mode": "cpu",
  "gpu_enabled": false,
  "gpu_device_id": null,
  "gpu_intensity_percent": 10
}
```

On first launch, the Rust backend copies these values to the app-specific
configuration directory. Existing Phase 1 config files are normalized when
loaded. `cpu_threads` is the enforced real-mining CPU limit and defaults to one
thread. The older `cpu_limit_percent` field remains reserved for future
fine-grained throttling.

Upgrades preserve an existing saved pool selection. If you previously ran the
app with the older `pool.nerdminers.org` default, review the settings panel and
switch pools manually when appropriate.

For safety, `real_mining_enabled` remains `false` in saved configuration.
Enabling real mode is a session-only UI action. Every app launch starts in
simulation mode, and mining begins only after the user clicks `START`.

GPU settings also start conservatively. The default `compute_mode` is `cpu`,
`gpu_enabled` is `false`, and GPU intensity defaults to `10`. The backend
refuses to preserve `gpu_real_experimental` as a startup mode: loading or
saving that value resets it to `cpu`.

## CPU Threads

The settings panel asks the Rust backend for the computer's available logical
CPU thread count and presents safe choices from `1`, `2`, `4`, and the detected
maximum without exceeding that maximum. One thread remains the default.

Choosing more than the conservative recommendation displays:

```text
High CPU usage may affect your computer.
```

The UI prompt is informational. The Rust backend performs its own validation
again immediately before real mining starts, so an out-of-range thread count
cannot bypass the local limit.

## GPU framework status

GPU support is currently a safe framework, not real GPU mining:

| Compute mode | Current behavior |
| --- | --- |
| `CPU` | Local simulation, or explicitly confirmed real CPU mining. |
| `GPU Sim` | Local-only simulated higher hashrate and an `Overdrive` pet visual. It does not call a GPU API. |
| `GPU Benchmark` | Placeholder benchmark returning a simulated result. It does not connect to a pool or perform a real GPU workload. |
| `GPU Real Experimental` | Disabled and marked `Coming Soon`. It cannot be saved as the startup mode. |

The placeholder device list currently contains `Auto` and `Simulated GPU`.
GPU intensity choices are `10%`, `25%`, `50%`, `75%`, and `100%`. These values
only affect GPU simulation and the placeholder benchmark today.

## Prerequisites on Windows

Install:

1. [Node.js](https://nodejs.org/)
2. [Rust with the MSVC toolchain](https://www.rust-lang.org/tools/install)
3. [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
4. [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)

For Microsoft C++ Build Tools, select the **Desktop development with C++**
workload.

## Install dependencies

```powershell
npm install
```

## Stable and development versions

The project keeps two Windows app identities:

| Flavor | Product name | Identifier | Build directory |
| --- | --- | --- | --- |
| Stable | `BTC Lottery Pet` | `com.btc-lottery-pet.desktop` | `src-tauri\target\release` |
| Development | `BTC Lottery Pet Dev` | `com.btc-lottery-pet-dev.desktop` | `src-tauri\target-dev` |

Use the stable build for normal desktop use. The development flavor is for
local iteration and has a separate app identity, configuration directory, log
directory, and Rust target directory so it does not overwrite stable files.

Single-instance protection applies within each identifier. Starting
`BTC Lottery Pet Dev` twice focuses the existing development window instead of
creating another one. Stable and development builds deliberately use different
identifiers, so they can still run side by side for testing.

## Run and build commands

Use exactly one of these commands for the task at hand:

| Command | Purpose |
| --- | --- |
| `npm run tauri:dev` | Recommended development desktop app. Starts Vite for Tauri and opens one `BTC Lottery Pet Dev` desktop window. It does not ask Vite to open a browser. |
| `npm run dev` | Browser-only React preview at `http://localhost:1420`. It does not launch Tauri. |
| `npm run tauri:build` | Stable Windows package build for `BTC Lottery Pet`. |

If you run `npm run dev` and `npm run tauri:dev` at the same time, you may see
a browser preview and a Tauri desktop window. Other common sources of an
apparent second window are an old executable that was not closed, or running
the stable and development identifiers side by side. The application itself
declares only one main Tauri window.

## Run the development desktop app

On Windows, load the Visual Studio developer environment so Rust can find
`link.exe` and the Windows SDK libraries. With the default Build Tools install
path, run:

```powershell
cmd.exe /v:on /d /s /c 'call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" && set "PATH=%USERPROFILE%\.cargo\bin;!PATH!" && npm run tauri:dev'
```

For a browser-only preview of the React UI:

```powershell
npm run dev
```

Browser previews can exercise the simulation and settings UI. Real mining runs
only inside the Tauri app because the Rust backend owns network and hashing.

## Build the stable Windows installers

```powershell
cmd.exe /v:on /d /s /c 'call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" && set "PATH=%USERPROFILE%\.cargo\bin;!PATH!" && npm run tauri:build'
```

Tauri writes the stable executable to
`src-tauri\target\release\btc-lottery-pet.exe` and stable installer bundles
under `src-tauri\target\release\bundle`.
The generated installer may download Microsoft's WebView2 bootstrapper when
the WebView2 runtime is missing from the target computer.

`npm run tauri:build-stable` remains an alias for `npm run tauri:build`.
To package the development flavor separately, use `npm run tauri:build-dev`.
Its Rust outputs are written under `src-tauri\target-dev`.
