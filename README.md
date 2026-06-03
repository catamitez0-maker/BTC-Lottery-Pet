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
- System tray icon with `Show`, `Hide`, `Open Logs`, and `Quit`
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
- Jackpot / block-candidate detection when a header hash meets the network
  target from the current Stratum job's `nbits`
- App log directory file logging with a 1 MiB rotation limit (`mining.log` and
  `mining.log.1`) plus `found_block.json` for a block candidate event
- Optional one-way notifications for Jackpot, share accepted, connection error,
  and coarse heartbeat status via local Windows notification or webhook

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
   difficulty, current job ID, and connection status. Mining stats are emitted
   at most once per second during real mining, except for the immediate local
   `Stopped` state emitted after the user clicks `STOP`.
8. Compare each candidate header hash against the network target derived from
   `nbits`; if it meets that target, emit a local `block-found` event, write
   `found_block.json`, and keep the normal share-submission path active.

The current client is intentionally small. It supports plain Stratum v1 TCP,
not Stratum TLS, Stratum v2, proxy mode, failover pools, remote management, or
profit-switching.

The block-candidate record contains job ID, nonce, ntime, extranonce2, block
hash, best difficulty estimate, timestamp, and pool host/port. It intentionally
does not include the BTC address, private keys, seed phrases, or any remote
control data.

To keep an untrusted or misconfigured pool from consuming unbounded local
resources, the client caps each Stratum line at 1 MiB, keeps at most 128
unanswered share submissions, and sends at most 16 queued shares before
returning to socket reads. It also rejects non-positive and pathologically low
share difficulties.

Mining logs are event-driven rather than hash-driven. The app logs connection,
authorization, job, share, stop, warning, and error events; it does not emit UI
events for every hash or nonce. When `STOP` is clicked, the backend logs
`Mining stop requested`, sets the stop signal immediately, emits a zero-hashrate
`Stopped` stats snapshot, and avoids submitting queued shares after the stop
signal is observed. Worker cleanup continues on the background mining thread so
the UI is not blocked by worker joins.

Notifications are one-way only. Local Windows notifications and webhooks can be
triggered by app events, but there is no remote command polling, remote control,
or inbound webhook listener.

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
  "performance_preset": "eco",
  "real_mining_enabled": false,
  "enable_notifications": true,
  "notify_on_jackpot": true,
  "notify_on_share_accepted": false,
  "notify_on_connection_error": true,
  "heartbeat_interval": "off",
  "notification_channel": "local_windows_toast",
  "webhook_url": "",
  "compute_mode": "cpu",
  "gpu_enabled": false,
  "gpu_device_id": null,
  "gpu_intensity_percent": 10
}
```

On first launch, the Rust backend copies these values to the app-specific
configuration directory. Existing Phase 1 config files are normalized when
loaded. `performance_preset` and `cpu_threads` are the enforced real-mining CPU
limits. The default `eco` preset uses one CPU thread. The older
`cpu_limit_percent` field remains reserved for future fine-grained throttling.

Upgrades preserve an existing saved pool selection. If you previously ran the
app with the older `pool.nerdminers.org` default, review the settings panel and
switch pools manually when appropriate.

For safety, `real_mining_enabled` remains `false` in saved configuration.
Enabling real mode is a session-only UI action. Every app launch starts in
simulation mode, and mining begins only after the user clicks `START`.

GPU settings also start conservatively. The default `compute_mode` is `cpu`,
the internal `gpu_enabled` flag is `false`, and GPU intensity defaults to `10`.
The backend refuses to preserve `gpu_real_experimental` as a startup mode:
loading or saving that value resets it to `cpu`.

## Performance presets

The settings panel asks the Rust backend for the computer's available logical
CPU thread count and presents safe choices from `1`, `2`, `4`, and the detected
maximum without exceeding that maximum.

| Preset | Real CPU mining threads |
| --- | ---: |
| `Eco` | `1` |
| `Normal` | Backend recommended thread count, currently up to `2` |
| `Turbo` | Detected logical CPU thread count |
| `Custom` | User-selected `CPU THREADS` value |

Starting real CPU mining with `Turbo` or a custom thread count above the
backend recommendation displays:

```text
High CPU usage may heat your computer. Continue?
```

The UI prompt is informational. The Rust backend performs its own normalization
and validation, so an out-of-range thread count cannot bypass the local limit.

## Notifications

Notification settings are local configuration. `Notify on Jackpot` and
`Notify on Connection Error` default to enabled, `Notify on Share Accepted`
defaults to disabled, and heartbeat defaults to `off`.

Supported channels today:

| Channel | Current behavior |
| --- | --- |
| `Local Windows Toast` | Shows a local Windows notification-style balloon. Jackpot and connection warnings also play a short system sound. |
| `Webhook` | Sends one-way JSON POST notifications for Jackpot and heartbeat events. |
| `Telegram Bot` | Listed as `Coming Soon`; not enabled. |
| `ntfy.sh` | Listed as `Coming Soon`; not enabled. |

The Jackpot webhook body is intentionally narrow:

```json
{
  "event": "jackpot",
  "pool": "...",
  "job_id": "...",
  "hash": "...",
  "difficulty": 0,
  "timestamp": "...",
  "note": "found_block.json saved locally"
}
```

Webhook notifications never include the BTC address, pool username, private
keys, or seed phrases. If a webhook fails, the app writes a local warning
without the webhook URL and mining continues.

Heartbeat notifications are coarse-grained only: `off`, `30min`, `1h`, or
`6h`. They include status, hashrate, accepted/rejected shares, best difficulty,
uptime, and pool host/port. They are never sent once per second.

## GPU framework status

GPU support is currently a safe framework, not real GPU mining:

| Compute mode | Current behavior |
| --- | --- |
| `CPU` | Local simulation, or explicitly confirmed real CPU mining. |
| `GPU Sim` | Local-only simulated higher hashrate and an `Overdrive` pet visual. It does not call a GPU API. |
| `GPU Benchmark` | Placeholder benchmark returning a simulated result. It does not connect to a pool and no real GPU workload is started. |
| `GPU Real Experimental` | Disabled and marked `Coming Soon`. It cannot be saved as the startup mode. |

The placeholder device list currently contains `Auto` and `Simulated GPU`.
GPU intensity choices are `10%`, `25%`, `50%`, `75%`, and `100%`. These values
only affect GPU simulation and the placeholder benchmark today.

Compute Mode is the only GPU control in the settings panel. There is no separate
user-controlled GPU checkbox: `CPU` keeps GPU features disabled, `GPU Sim`
enables simulation, and `GPU Benchmark` enables only the placeholder benchmark.

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

## Tray and logs

Closing the pet window with `X` hides it to the system tray. It does not start
or stop mining by itself. Use the tray `Show` item or left-click the tray icon
to show the window again. Use `Quit` from the tray menu to exit the app.

The tray `Open Logs` item and the Detail Mode `OPEN LOGS` button open the
app-specific log folder. The Detail Mode `COPY LOG PATH` button copies that
local log folder path. The regular mining log is `mining.log`; if a block
candidate is detected, the event is also saved as `found_block.json`.

## Run and build commands

Use exactly one of these commands for the task at hand:

| Command | Purpose |
| --- | --- |
| `npm run tauri:dev` | Recommended development desktop app. Starts Vite for Tauri and opens one `BTC Lottery Pet Dev` desktop window. It does not ask Vite to open a browser. |
| `npm run dev` | Browser-only React preview at `http://localhost:1420`. It does not launch Tauri. |
| `npm run tauri:build` | Stable Windows NSIS package build for `BTC Lottery Pet`. |

Release builds use the Windows GUI subsystem, so the packaged app should not
open an extra black console window next to the pet window. `npm run tauri:dev`
is different: it runs from a development terminal, and that terminal staying
open while the dev app runs is normal.

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

## Build the stable Windows installer

```powershell
cmd.exe /v:on /d /s /c 'call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" && set "PATH=%USERPROFILE%\.cargo\bin;!PATH!" && npm run tauri:build'
```

Tauri writes the stable executable to
`src-tauri\target\release\btc-lottery-pet.exe` and the stable NSIS installer
under `src-tauri\target\release\bundle\nsis`.
The generated installer may download Microsoft's WebView2 bootstrapper when
the WebView2 runtime is missing from the target computer.

`npm run tauri:build-stable` remains an alias for `npm run tauri:build`.
To package the development flavor separately, use `npm run tauri:build-dev`.
Its Rust outputs are written under `src-tauri\target-dev`.

## Release candidate checks

For the v0.4 release candidate, verify:

1. `cargo test --manifest-path src-tauri\Cargo.toml` passes, including the
   compact `nbits` target and block-candidate event tests.
2. `npm run build` passes TypeScript and Vite production builds.
3. `npm run tauri:build` produces the stable Windows executable and installer.
4. The release executable uses the Windows GUI subsystem and should not open an
   extra black console window. The development command `npm run tauri:dev` can
   still keep its development terminal open; that is expected.
5. Detail Mode `OPEN LOGS` opens the local app log folder, and
   `COPY LOG PATH` copies that folder path.
