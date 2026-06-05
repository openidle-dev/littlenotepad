# LittleNotepad

A fast, lightweight code editor built with [Tauri 2](https://tauri.app/) — Rust backend, plain HTML/CSS/JS frontend. No Node.js, no npm required.

Features syntax highlighting for 20+ languages, multi-tab editing with session restore, an integrated multi-session terminal (CMD, PowerShell, Git Bash), LSP support (Python, Rust, JavaScript/TypeScript), live Markdown preview, multiple cursors, code folding, git status indicators, global search, and auto-save.

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Rust | ≥ 1.77.2 | [rustup.rs](https://rustup.rs) |
| Tauri CLI | ^2.11 | `cargo install tauri-cli --version "^2.11"` |
| WebView2 (Windows) | any | Ships with Windows 11; [download](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) for Windows 10 |

### Verify

```sh
rustc --version
cargo tauri --version
```

---

## Local development

```sh
git clone https://github.com/openidle-dev/littlenotepad.git
cd littlenotepad
cargo tauri dev
```

JS/CSS/HTML changes hot-reload instantly. Rust changes recompile automatically (5–30 s).

### Type-check only (no app launch)

```sh
cd src-tauri
cargo check
```

### Security audit

```sh
cd src-tauri
cargo audit
```

---

## Production build

Must be run on each target OS — Tauri cannot cross-compile.

```sh
cargo tauri build
```

Artifacts in `src-tauri/target/release/bundle/`:

| OS | Artifact |
|----|----------|
| Windows | `msi/LittleNotepad_x.y.z_x64_en-US.msi` |
| macOS | `dmg/LittleNotepad_x.y.z_x64.dmg` |
| Linux | `deb/littlenotepad_x.y.z_amd64.deb`, `appimage/LittleNotepad_x.y.z_amd64.AppImage` |

> **Windows:** Run `Unblock-File .\LittleNotepad_*.msi` in PowerShell before distributing to strip the MOTW block.

---

## Bumping the version

Two files must stay in sync:

**`src-tauri/Cargo.toml`**
```toml
[package]
version = "0.2.0"
```

**`src-tauri/tauri.conf.json`**
```json
{
  "version": "0.2.0"
}
```

Then tag and push:

```sh
git add src-tauri/Cargo.toml src-tauri/tauri.conf.json
git commit -m "chore: bump version to 0.2.0"
git tag v0.2.0
git push origin main --tags
```

Pushing a `v*` tag triggers the GitHub Actions release pipeline, which builds on Windows, macOS, and Linux and publishes a GitHub Release with installers attached.

Until then, build manually on each OS and upload via:

```sh
gh release create v0.2.0 --generate-notes \
  "src-tauri/target/release/bundle/msi/LittleNotepad_0.2.0_x64_en-US.msi"
```
