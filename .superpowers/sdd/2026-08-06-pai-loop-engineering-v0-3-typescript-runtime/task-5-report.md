# Task 5 Report: Reproducible Manifests, WaveInput, and Verbatim Evidence

## Status

COMPLETE

Planned commit: `feat: bind manifests WaveInputs and evidence`

Base: `988ad0d`

## Changed scope

- `src/core/manifests.ts` and deterministic `dist/core/manifests.js` output: one normalized Git-aware Source/Tree/Workspace manifest implementation, mandatory control-root exclusions, explicit Source/Runtime inclusions, dirty and untracked bytes, declared ignored/external/secret inputs, safe symlink and submodule bindings, read-only Git capture, sealed WaveInput, verbatim evidence streams, exact evidence binding, and bounded process-tree termination.
- `test/unit/manifests.test.ts`: control exclusions, explicit source paths, dirty/untracked state, ignored/external/secret declarations, symlinks, runtime paths, submodules, repository identity, deterministic sealing, and byte-identical Git index coverage.
- `test/unit/evidence.test.ts`: raw non-UTF8 stdout, atomic stream files, binding rejection, and redacted/value-sensitive environment digest coverage.
- `test/cli/process-timeout.test.ts`: real parent/descendant timeout cleanup and recorded termination path.
- `package.json`: introduced `test:cli` and inserted the CLI boundary into the aggregate gate.

The untracked repository-root `findings.md`, `progress.md`, and `task_plan.md` files were left untouched and unstaged.

## RED chronology

Initial missing-API command:

```text
npm run test:unit -- --test-name-pattern "exclusion contract|non-UTF8"
```

Exit `1`. TypeScript reported `TS2307: Cannot find module '../../src/core/manifests.js'` from all three new Task 5 test files. This was the required missing-API RED, before production implementation.

Strengthened mandatory-control RED:

```text
node --test --test-name-pattern "exclusion contract" .test-dist/test/unit/manifests.test.js
```

Exit `1`; the manifest contained a control-root entry when the caller supplied only its declared Scratch root. The implementation was changed to merge the exact `.git`, `.ai-loop`, and `.codegraph` roots unconditionally.

Strengthened explicit-source/repository-identity REDs:

- An empty caller inclusion set raised `SCHEMA_INVALID` instead of still including the required Source paths.
- Adding `repositoryId` first produced `TS2353`, proving the WaveInput options did not yet bind repository identity.

Both were implemented only after their RED results.

The first aggregate run also produced a real concurrency regression: independent WaveInput views launched separate Git snapshots, and Git for Windows returned `error launching git`. Sealing now captures one sequential, read-only Git snapshot and shares it across Source, Tree, and Workspace, which both removes that resource race and prevents cross-view snapshot skew.

## GREEN evidence

Focused Task 5 units:

```text
node --test .test-dist/test/unit/manifests.test.js .test-dist/test/unit/evidence.test.js
```

Exit `0`; `8` passed, `0` failed, and the real symlink integration had one explicit Windows `EPERM` permission skip. Submodule and repository-identity follow-up tests passed `2/2` with no skips.

Focused CLI boundary:

```text
npm run test:cli -- --test-name-pattern "process timeout"
```

Exit `0`; `1/1` passed. The timed-out parent and its descendant were no longer alive, the record was `FAIL` with a null exit code, and the actual Windows best-effort taskkill path was captured.

Final verification:

- `npm run typecheck`: PASS, exit `0`.
- `npm run schema:check`: PASS; all 18 Schemas plus parity, strictness, references, generated validators, and English-only fixtures passed.
- `npm run build`: PASS, exit `0`.
- `npm run check:dist`: PASS, exit `0`; rebuilt runtime bytes matched committed `dist`.
- Fresh aggregate `npm test`: PASS, exit `0`; `71/72` unit tests passed with only the explicit Windows symlink-permission skip, CLI `1/1`, faults `17/17`, and deterministic distribution comparison passed.

## Contract notes

- Git is invoked only with executable plus argv arrays and `shell: false`; `GIT_OPTIONAL_LOCKS=0` prevents stat-cache/index refreshes. The index remained byte-identical across WaveInput sealing.
- Source, Tree, and Workspace share path normalization and exact-root exclusions. Source always adds the required TypeScript, Schema, workflow-spec, and package files; Runtime only accepts `dist/**/*.js` and `dist/**/*.js.map`.
- Tree reads staged Git blobs without changing the index. Source/Workspace hash raw working bytes, include untracked inputs, and bind declared ignored artifacts. External entries require URI, mount, version, digest, provenance, and read-only policy. Secret entries hash only provider/handle/version metadata and never accept secret bytes.
- Symlink target bytes are hashed and their resolved targets must remain contained. Submodules bind path, mode `160000`, and commit.
- Evidence stdout/stderr remain Buffers through capture and atomic durable writes. Records bind Loop, Work Item, Attempt, Actor, H1, WaveInput, Output Tree, argv, cwd, redacted environment digest, timestamps, tool metadata, raw-stream digests, artifact digest, and result.
- POSIX execution uses a detached process group, sends group `SIGTERM` then `SIGKILL`, and refuses success while the group remains alive. Windows uses argv-array `taskkill /PID ... /T /F` as best-effort behavior.

## Concerns

The current host is Windows. Windows behavior passed its best-effort CLI test, while the real symlink test skipped only on explicit `EPERM`. Linux and macOS are release-blocking per the updated platform priority; their detached process-group and real symlink paths are implemented and covered by platform-active tests, but must still execute successfully in Linux/macOS CI before release.
