# Whisper CUDA Engine Notes

Last updated: 2026-05-01

This documents the CUDA engine fixes shipped in PrivateTranscribe `0.8.2` → `0.8.4`, and the important lessons for future agents/devs.

## TL;DR

PrivateTranscribe uses a separate downloadable Whisper CUDA engine for GPU-accelerated local Whisper transcription. The Windows/Linux CUDA engine must be a **zip package** containing both the `whisper-server` launcher and its required runtime libraries beside it.

Do **not** assume the CUDA executable is self-contained. Modern `whisper.cpp` builds can produce a small launcher executable plus adjacent `whisper`/`ggml`/CUDA runtime DLLs or `.so` files.

## Production state

- Latest confirmed working release: `0.8.4`
- CUDA binary package version: `v0.0.9`
- Windows CUDA package:
  - `https://updates.privatetranscribe.com/binaries/v0.0.9/whisper-server-win32-x64-cuda.zip`
- Linux CUDA package:
  - `https://updates.privatetranscribe.com/binaries/v0.0.9/whisper-server-linux-x64-cuda.zip`
- Confirmed real hardware success:
  - Kristian's RTX 5070 laptop now runs CUDA after the fixes.

## Root cause of the laptop CUDA failure

CUDA worked on the development/workstation machine but failed or fell back to CPU on laptops.

The likely reason: the workstation had CUDA Toolkit/runtime DLLs globally installed, so the CUDA `whisper-server` could find `cudart`, `cublas`, etc. The laptops did not, so CUDA startup failed and the app fell back to CPU.

Fix: ship the CUDA engine as a self-contained package with the required runtime libraries next to the server binary.

## Important implementation details

### CUDA package build

Workflow: `.github/workflows/build-cuda-binary.yml`

The workflow builds/uploads CUDA zip packages to PrivateTranscribe's own R2 bucket. Do not depend on OpenWhispr assets.

Package contents must include:

- `whisper-server-win32-x64-cuda.exe` on Windows, or Linux equivalent
- Windows companion DLLs, including examples like:
  - `cudart64_12.dll`
  - `cublas64_12.dll`
  - `cublasLt64_12.dll`
  - `whisper.dll`
  - `ggml*.dll`
  - `ggml-cuda.dll`
- Linux companion shared objects:
  - `libwhisper.so*`
  - `libggml*.so*`
  - CUDA/runtime `.so` dependencies when packaged by the build

### App-side install and validation

Primary files:

- `src/helpers/gpuBinaryManager.js`
- `src/helpers/whisperServer.js`
- `src/helpers/whisper.js`
- `src/helpers/ipcHandlers.js`
- `src/components/SettingsPage.tsx`
- `tests/unit/helpers/gpuBinaryManager.test.ts`
- `tests/unit/helpers/whisperForceCpuOption.test.ts`
- `tests/unit/helpers/whisperServerCudaFallback.test.ts`

Important rules:

1. CUDA engine packages are downloaded as zip files and extracted into the user binary directory.
2. Companion libraries must be extracted beside the server binary.
3. `whisperServer.js` must spawn from the binary directory and prepend that directory to:
   - `PATH` on Windows
   - `LD_LIBRARY_PATH` on Linux
4. Do not validate CUDA readiness only by executable size. Modern builds may use a small launcher plus large runtime libraries.
5. Validate installed package size/companion libraries instead of assuming the `.exe` must be >10 MB.
6. `getCudaBinaryStatus().installed` means a CUDA engine exists. It must **not** require `upToDate === true`.
7. Readiness/update state is `installed && upToDate`.
8. If CUDA startup fails (`spawn UNKNOWN`, missing DLL, startup crash), fallback to CPU and expose diagnostics rather than crashing.
9. The CPU fallback is **temporary, not session-sticky**. A CUDA startup failure arms a retry backoff (1 min → 5 min → 30 min per consecutive failure); the next server start after the window retries the CUDA binary, and a warm CPU-fallback server is restarted once the retry is due. A successful CUDA start resets the failure state. Rationale: transient failures (NVIDIA driver update in progress, GPU reset) resolve on their own — before this, the app silently stayed on CPU until an app restart or a manual CPU→GPU toggle.
10. Fallback transitions must be user-visible: `whisperServer.js` fires `onEngineFallbackChanged`, broadcast to all windows as `whisper-engine-fallback-changed`, and both the overlay and control panel show a toast when the fallback engages and when CUDA recovers. Do not remove this in favor of passive status text only.

### Engine version pinning and the latest-cuda manifest

Each app build pins the engine it installs via `BINARY_VERSION` in `gpuBinaryManager.js`; downloads always come from `binaries/<BINARY_VERSION>/`. A released app therefore shows "Current" even when a newer engine has been uploaded to R2 — the newer engine only becomes *required* when an app release with the bumped `BINARY_VERSION` ships.

To make that state visible, the `build-cuda-binary.yml` workflow also publishes `binaries/latest-cuda.json` (`{"version":"v0.0.9", ...}`) after both platform packages upload. `GpuBinaryManager.fetchLatestAvailableVersion()` reads it (cached, fail-soft), `get-cuda-binary-status` returns it as `latestAvailableVersion`, and the Settings CUDA card tells the user a newer engine is published and installs with the next app update. The manifest never changes which version gets downloaded.

Release checklist for a new engine version:

1. Run the workflow with `engine_version: vX.Y.Z` and `upload_to_r2: true` (uploads both packages + manifest).
2. Bump `BINARY_VERSION` in `gpuBinaryManager.js` to the same value.
3. Ship the app release; its CUDA auto-update installs the new engine.

## UI/UX lessons

CUDA engine updates are separate from the main app update. Users may update PrivateTranscribe and still need to download/update the CUDA engine package.

This was confusing when CUDA controls were hidden in model/transcription settings. As of `0.8.4`, General settings includes a CUDA Engine card showing:

- installed CUDA engine version
- required/latest CUDA engine version
- backend state (`cuda active`, `cpu fallback`, `idle`, etc.)
- download/update/retry/reinstall controls
- download progress, cancel, and refresh
- auto-update failure messaging

Keep this visible. Do not bury CUDA update controls only inside advanced/model-specific UI.

## Release timeline

### `0.8.2`

- Added self-hosted CUDA zip package approach.
- Built and uploaded `v0.0.8` Windows/Linux CUDA packages to PrivateTranscribe R2.
- Added runtime library extraction and spawn environment setup.

### `0.8.3`

- Fixed app-side validation for split runtime builds.
- Explicitly passed `--language auto` to Whisper server.
- Released for laptop retesting.

### `0.8.4`

- Fixed CUDA status bug where an outdated CUDA engine was reported as `installed: false`.
- Added CUDA Engine update controls/status to General settings.
- Confirmed public updater and installer.
- Kristian confirmed CUDA works on RTX 5070 laptop.

## If CUDA becomes slow again

Ask for or inspect:

1. App version.
2. CUDA engine version shown in Settings → General → CUDA Engine.
3. Whether the card says CUDA active or CPU fallback.
4. `getEngineStatus().effectiveEngine`.
5. `getEngineStatus().fallback.diagnostic`.
6. App logs around CUDA startup.
7. Benchmark speed. GPU-like should be many times real-time, not ~0.3x–0.5x.

Most likely failure classes:

- CUDA package not downloaded/updated.
- Outdated CUDA package version.
- Missing companion DLL/`.so` files.
- Spawn environment not including the binary directory.
- CUDA startup failure causing CPU fallback (auto-retries with backoff; check `getEngineStatus().fallback.nextRetryAt` and `failureCount`).
- User selected CPU-only mode.
- GPU VRAM/model-size issue, especially with Large models.

## Do not repeat these mistakes

- Do not suggest that users install the full CUDA Toolkit as the normal fix.
- Do not rely on globally installed CUDA DLLs.
- Do not depend on OpenWhispr downloads/assets.
- Do not treat small `whisper-server` launcher size as a failed build by itself.
- Do not hide CUDA updates only in advanced transcription/model settings.
- Do not use `installed: false` to mean "installed but outdated".
