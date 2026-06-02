# BTC Lottery Pet

BTC Lottery Pet is a small Windows desktop ornament inspired by BTC lottery
miners and NerdMiner-style displays. It is built with Tauri, React, TypeScript,
and Rust.

The default mode is a local-only simulation. An experimental real mining mode
is available for education and lottery-style solo mining, but it is always off
by default and must be enabled manually in the UI for the current app session.
This project does not promise or guarantee any financial return.

## Features

- 320x220 desktop pet window
- Always-on-top window with a user-controlled `PIN` / `FREE` toggle
- System tray icon with `Show BTC Lottery Pet` and `Quit`
- Default simulation mode with locally generated stats
- Explicitly enabled real mining mode with a CPU-use warning
- User-controlled BTC address, pool host, pool port, worker name, and CPU thread
  count
- Rust Stratum v1 client and cancellable SHA-256d hash loop
- `Stop` control that signals the hash workers to exit immediately

BTC Lottery Pet does not hide its process, enable itself at Windows startup,
accept remote-control commands, or start mining automatically.

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
  "real_mining_enabled": false
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

## Run locally

On Windows, load the Visual Studio developer environment so Rust can find
`link.exe` and the Windows SDK libraries. With the default Build Tools install
path, run:

```powershell
cmd.exe /v:on /d /s /c 'call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" && set "PATH=%USERPROFILE%\.cargo\bin;!PATH!" && npm run tauri dev'
```

For a browser-only preview of the React UI:

```powershell
npm run dev
```

Browser previews can exercise the simulation and settings UI. Real mining runs
only inside the Tauri app because the Rust backend owns network and hashing.

## Build Windows installers

```powershell
cmd.exe /v:on /d /s /c 'call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" && set "PATH=%USERPROFILE%\.cargo\bin;!PATH!" && npm run tauri build'
```

Tauri writes Windows bundle artifacts under `src-tauri\target\release\bundle`.
The generated installer may download Microsoft's WebView2 bootstrapper when
the WebView2 runtime is missing from the target computer.
