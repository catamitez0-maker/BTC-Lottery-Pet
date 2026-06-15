# Development File Policy

This repository should stay small and reproducible. Keep source, lockfiles,
configuration, tests, scripts, and docs in Git. Keep generated build outputs,
tool caches, logs, and local machine state out of Git.

## Keep In Git

- `src/`, `src-tauri/src/`, `src-tauri/capabilities/`, and project config.
- `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, and
  `src-tauri/Cargo.lock`.
- Tests, release docs, CI config, and reusable scripts under `scripts/`.
- Small checked-in assets such as icons and shader source files.

## Generated Locally

These paths are disposable and can be recreated by install, build, or run
commands:

| Path | Purpose | Recreate with |
| --- | --- | --- |
| `node_modules/` | npm dependencies | `npm install` |
| `dist/` | frontend production build | `npm run build` |
| `.test-dist/` | frontend test TypeScript output | `npm run test:frontend` |
| `src-tauri/target/` | Rust/Tauri build cache and release outputs | `npm run tauri:dev` or `npm run tauri:build` |
| `src-tauri/target-dev/` | legacy development cache from the old split-app setup | no longer used; `npm run clean:dev` removes it |
| `*.log` | local command or app troubleshooting logs | generated as needed |

Rust debug builds can become very large on Windows because `.lib`, `.rlib`,
and `.pdb` files are emitted for many crates and build modes. A large
`src-tauri/target*` directory is normal and should be treated as cache, not
source.

## Cleanup Commands

Preview the cleanup first:

```powershell
npm run clean:dev:check
```

If `npm` is not on PATH in the current shell, run the script directly:

```powershell
.\scripts\clean-dev.ps1 -WhatIf
```

Remove generated build outputs and local logs:

```powershell
npm run clean:dev
```

Direct script form:

```powershell
.\scripts\clean-dev.ps1
```

Also remove `node_modules/` when you want a fully fresh dependency install:

```powershell
npm run clean:dev -- -IncludeNodeModules
npm install
```

`clean:dev` removes release outputs under `src-tauri/target/`, including a
locally built installer. Copy any installer you intend to distribute before
running it.

## Release Artifacts

Do not keep large installers or compiled binaries as source files. The
canonical release destination should be GitHub Releases or another external
release store. If a local handoff copy is needed, use an ignored temporary
folder such as `artifacts/` and delete it after upload.
