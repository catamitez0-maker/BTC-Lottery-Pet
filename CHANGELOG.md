# Changelog

## 0.7.0 - 2026-06-13

### Added

- GitHub Actions quality gate for frontend tests, frontend build, Rust tests,
  Rust Clippy, and production dependency audit.
- Manual Windows installer artifact workflow for `v*` tags and explicit
  workflow dispatches.
- Release checklist covering installer, browser preview, real mining, GPU,
  notification, and diagnostic privacy smoke checks.
- Frontend mining logic tests for config normalization, GPU helper behavior,
  start validation, preset ports, CPU preset bounds, and hashrate formatting.
- Sanitized diagnostic snapshot export with schema version, redaction metadata,
  recent log redaction, and `SAVE DIAG` file output.
- Local mock Stratum pool coverage for subscribe, authorize, job delivery,
  accepted shares, and rejected shares.
- Protocol tests for malformed Stratum JSON, subscribe rejection, authorize
  rejection, and unknown response IDs.
- GPU benchmark timestamp display so benchmark results are easier to interpret.

### Changed

- Migrated built-in public pool defaults to `public-pool.io:3333`.
- GPU-only mode now records zero CPU hash threads consistently in config,
  diagnostics, and startup settings.
- GPU share-target comparison uses Bitcoin hash byte order consistently across
  CPU and GPU paths.
- GPU-only backend initialization failure now stops the mining session and
  reports `GPU unavailable` instead of leaving the UI in a misleading running
  state.

### Hardened

- Real mining rejects pathological share difficulties that would make every
  nonce qualify.
- Pool rejection reasons are surfaced in logs for accepted/rejected share
  accounting and authorization failures.
- Windows notification AppID handling avoids leaking webhook URLs in failure
  logs or payloads.
- Detail diagnostics intentionally exclude BTC address and webhook URL.

### Validation

- `npm run test:frontend`
- `npm run build`
- `cargo test --manifest-path src-tauri\Cargo.toml`
- `cargo clippy --manifest-path src-tauri\Cargo.toml -- -D warnings`
- `npm audit --omit=dev`
- `npm run tauri:build`
