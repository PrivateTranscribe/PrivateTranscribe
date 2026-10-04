# AGENTS.md

Guidance for Codex and other coding agents working in this repository.

Follow `CONTRIBUTING.md` to set up a fresh clone or prepare a pull request.

## Project

PrivateTranscribe is an Electron desktop dictation app for private/local transcription and AI-assisted text processing.

- Product name: **PrivateTranscribe**
- Legacy names (`OpenWhispr`, `Privoca`, `DictateVoice`) may appear only in historical notes, migrations, or upstream comparison docs.
- Main repo guidance for Claude Code is in `CLAUDE.md`; this file is the Codex/agent quick-start.

## Critical Rules

- **Do not merge to `main` unless explicitly asked.**
- **Do not create or switch to a new branch unless explicitly asked. Work on the current branch by default.**
- Keep commits atomic. Do not bundle unrelated changes.
- Prefer small, focused fixes with tests or a clear verification step.
- Do not introduce cloud dependencies for privacy/local features unless explicitly requested.
- Do not suggest users install the full CUDA Toolkit as the normal fix for Whisper GPU support.

## Product UI / Design Taste

Before changing product-facing UI, settings screens, onboarding, empty states, or marketing copy, read:

- `docs/DESIGN_TASTE_GUIDE.md`

Use calm operator UI: visible system state, product-specific copy, and sparse motion only when it clarifies state. Avoid generic AI SaaS polish.

## Commit Discipline

- Commit each feature, bug fix, or documentation update separately. If a task touches multiple independent behaviors, split the work into multiple commits instead of making one broad checkpoint.
- Keep each commit reviewable on its own: include the code change, the directly related tests or docs, and no unrelated formatting churn.
- Use professional commit messages. The subject should be concise, imperative, and specific, for example `Restore Whisper file temperature fallback`.
- Add a commit body when the change is non-trivial. Explain why the change is needed, what behavior changed, and how it was verified. Prefer concrete details over vague summaries.
- Do not use throwaway messages such as `fix`, `updates`, `changes`, `wip`, or `misc`.

## Common Commands

```bash
npm install
npm run dev
npm run format:check
npm run test
npm run build:renderer
```

For targeted tests, prefer the smallest meaningful set first, for example:

```bash
npm test -- tests/unit/helpers/gpuBinaryManager.test.ts tests/unit/helpers/whisperForceCpuOption.test.ts tests/unit/helpers/whisperServerCudaFallback.test.ts
```

There is no `npm run typecheck` script at the time of writing.

## Architecture Pointers

Important files:

- `main.js` — Electron main process startup/wiring
- `preload.js` — secure IPC bridge
- `src/helpers/ipcHandlers.js` — IPC handlers
- `src/hooks/useSettings.ts` — settings state
- `src/components/SettingsPage.tsx` — main settings UI
- `src/components/TranscriptionModelPicker.tsx` — transcription model/UI controls
- `src/helpers/whisper.js` — local Whisper manager
- `src/helpers/whisperServer.js` — whisper-server lifecycle/engine state
- `src/helpers/gpuBinaryManager.js` — CUDA engine download/install/versioning
- `.github/workflows/release.yml` — the Release button: Windows installer to R2 and GitHub Releases
- `.github/workflows/build-cuda-binary.yml` — CUDA engine package build/upload

## Whisper CUDA Engine: Read Before Touching

Before changing CUDA/GPU Whisper behavior, read:

- `docs/WHISPER_CUDA_ENGINE.md`

Hard-earned rules from the `0.8.2` → `0.8.4` stabilization:

- CUDA Whisper is a separately downloaded **zip package**, not just a single exe.
- Windows/Linux CUDA packages must include companion runtime libraries beside `whisper-server` (`cudart`, `cublas`, `whisper`, `ggml`, `ggml-cuda`, etc.).
- Modern `whisper.cpp` builds may use a small launcher plus large runtime DLLs/libs; validate total installed package/runtime libs, not only exe size.
- Spawn CUDA `whisper-server` from its binary directory and prepend that directory to `PATH` / `LD_LIBRARY_PATH`.
- `getCudaBinaryStatus().installed` means a CUDA engine exists, even if outdated.
- CUDA readiness/update state is `installed && upToDate`.
- CUDA update/download controls must remain visible in **General settings**.
- CUDA confirmed working on an RTX 5070 laptop after the `0.8.4` fixes.

## Release Notes

Releases run from `main` through the `Release` workflow (`release.yml`). Its build job waits in the protected `production` environment until Kristian approves it. The `production` branch is retired and triggers nothing.

Do not release unless explicitly asked. If releasing:

1. Commit the version bump in `package.json` and a `## X.Y.Z - YYYY-MM-DD` section in `CHANGELOG.md` on `main`, and push.
2. Start the workflow: `gh workflow run release.yml --ref main`.
3. The run fails early if the tag `vX.Y.Z` exists or the changelog has no entry. Otherwise it waits for the approval.
4. Verify `https://updates.privatetranscribe.com/win/latest.yml` names the new version and the installer returns HTTP 200.

## Verification Expectations

Before claiming success, run at least one meaningful gate:

- targeted unit tests for changed backend/helper logic
- `npm run format:check`
- `npm run build:renderer` for UI changes
- workflow/updater verification for releases

If a gate cannot run, state why clearly.
