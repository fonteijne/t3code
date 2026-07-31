# Implementation Report

**Plan**: `.claude/PRPs/plans/completed/bonzai-runtime-validation-spike.plan.md`
**Source PRD**: `.claude/PRPs/prds/bonzai-project-keys.prd.md`
**Branch**: `bonzai/phase-1-runtime-validation`
**Date**: 2026-07-31
**Status**: COMPLETE — Level 6 evidence gate closed by project-owner risk acceptance on 2026-07-31. The live matrix was run by this report's author rather than independently re-run, and restricted gateway-side correlation was not performed; both auditability gaps were explicitly accepted and recorded in `.claude/PRPs/reviews/bonzai-phase-1-level-6-closure.md`.

---

## Summary

Built the opt-in, maintainer-only Bonzai Agent SDK validation harness, executed the live E0–E6 matrix against the approved endpoint with two disposable keys, and recorded redacted evidence. Both Phase 1 unknowns are now answered, and the Phase 3 continuity behavior is selected.

Replacement-key resume **works**. Authorization failures **do not surface usefully today**, which contradicts the PRD's MVP assumption and adds required Phase 3 work.

---

## Live Evidence

Run `20260731T063558Z-long` against `https://api-v2.bonzai.iodigital.com`, SDK `0.3.170`, model `claude-sonnet-4-5`, 180s per-case budget.

| ID  | Credential        | Classification        | Retries | Outcome                                                     |
| --- | ----------------- | --------------------- | ------- | ----------------------------------------------------------- |
| E0  | none              | result-then-exception | 0       | `authentication_failed`; local failure, no gateway contact  |
| E1  | absent            | result-then-exception | 0       | identical to E0                                             |
| E2  | explicitly empty  | result-then-exception | 0       | identical to E0; inherited credentials did not fill the gap |
| E3  | invalid synthetic | timeout               | 10      | no terminal result within 180s                              |
| E4  | K1                | success               | 0       | session created, marker stored, durable ID issued           |
| E5  | K1                | success               | 0       | same session ID, marker recovered                           |
| E6  | **K2**            | success               | 0       | **same session ID, marker recovered**                       |
| E7  | cross-scope       | skipped               | 0       | excluded by default; requires separate authorization        |

### Falsification controls

E6 succeeding proves nothing unless the same resume fails without a valid credential. Verified separately in one isolated transcript:

| Check  | Credential    | Result                                                         |
| ------ | ------------- | -------------------------------------------------------------- |
| resume | K2            | success, same session ID, marker recovered (2.6s)              |
| resume | invalid token | failed, 8 retries, no result (77s)                             |
| resume | no token      | failed immediately, `Not logged in · Please run /login` (0.2s) |
| fresh  | invalid token | never terminated, 10 retries (152s)                            |

The credential is enforced per request, so E6 is meaningful rather than an artifact of local transcript replay.

---

## Answers

**1. Does resume work under a replacement key? Yes.**

Conversation state lives in the local transcript, not at the gateway; the credential authorizes each request rather than the session. Phase 3 may preserve the resume cursor across key rotation.

Caveat recorded in the PRD: resume re-sends prior context under the new credential. Correct for same-client rotation, but a key change representing a _different_ client should start a fresh session to avoid transmitting one client's context under another's billing identity.

**2. What does a rejected key look like? Two paths, neither acceptable.**

_Missing or empty_: `SDKAssistantMessage.error = "authentication_failed"`, then a result with `subtype: "success"` and `is_error: true`, then a throw carrying `Not logged in · Please run /login`. `turnStatusFromResult` (`apps/server/src/provider/Layers/ClaudeAdapter.ts:997`) keys only on `subtype`, so T3 Code projects a **completed** turn and shows only the generic `Claude runtime stream failed.`

_Invalid_: unbounded `api_retry` storm, no terminal result past 180s. The user sees an indefinite spinner and no error.

Phase 3 therefore needs dedicated auth-error mapping (inspecting `is_error` and `SDKAssistantMessage.error`) plus a retry or deadline cap.

---

## Gateway Contract Confirmed

The OpenAI-compatible `/v1/chat/completions` surface is not what Claude Code uses; `/v1/messages` was confirmed separately.

| Item                                             | Result                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| Anthropic-native `/v1/messages` at root base URL | ✅ HTTP 200                                                        |
| Bearer credential via `ANTHROPIC_AUTH_TOKEN`     | ✅                                                                 |
| `anthropic-version: 2023-06-01`                  | ✅                                                                 |
| Anthropic-style model IDs advertised             | ✅ `claude-sonnet-4-5`, `claude-sonnet-4-5-20250929`, plus aliases |
| Missing-credential gateway response              | ✅ HTTP 401, LiteLLM-flavored prose (no product name leaked)       |

---

## Tasks Completed

| #   | Task                                        | Status |
| --- | ------------------------------------------- | ------ |
| 1   | Schemas, redaction, leak guard              | ✅     |
| 2   | Synthetic unit suite                        | ✅     |
| 3   | Isolated bounded live runner                | ✅     |
| 4   | E0–E7 orchestration and decision derivation | ✅     |
| 5   | Opt-in package command, ignored artifacts   | ✅     |
| 6   | Operator runbook                            | ✅     |
| 7   | Live run and PRD decision record            | ✅     |

---

## Validation Results

| Check                | Result | Details                                                                     |
| -------------------- | ------ | --------------------------------------------------------------------------- |
| Type check           | ✅     | zero errors; six pre-existing suggestions in `src/orchestration/decider.ts` |
| Lint                 | ✅     | targeted, zero findings                                                     |
| Format               | ✅     | script, tests, runbook, PRD, report                                         |
| Unit tests           | ✅     | 18 passed                                                                   |
| Focused regressions  | ✅     | 124 passed across Claude adapter, runtime ingestion, environment, probe     |
| Build                | ✅     | server bundle                                                               |
| Acknowledgement gate | ✅     | refuses before reading credentials; writes no report                        |
| Live matrix          | ✅     | E0–E6 executed; one explicit classification                                 |
| Leak scan            | ✅     | independent check: no test key in raw, URL-encoded, or base64 form          |
| Temp state cleanup   | ✅     | no `t3-bonzai-runtime-*` directories remain                                 |

---

## Deviations from Plan

- Added a `--model` flag (not in the plan). Without pinning, the SDK's default model ID risked not being advertised by the gateway, which would have failed E4 for model reasons and left the resume question unanswered.
- Added `--case-timeout-ms`. The planned fixed 30s budget truncated E3 before its retry behavior was characterized.
- Added falsification controls beyond the plan's matrix. The plan's decision rule would have accepted E6 without proving that an unauthorized credential fails the same resume.
- Corrected the harness after the first run: `productionTurnStatusFromResult` now mirrors the real adapter including its subtype-only behavior, and `authFailureMaskedAsCompleted`, `apiRetryCount`, and `assistantErrors` were added. The first run's `supported` label was correct but its rationale misdescribed the mechanism.

---

## Issues Encountered

- Dependencies were absent and `vp` unavailable; `pnpm install --frozen-lockfile` restored the toolchain without changing the lockfile.
- The package runner forwards a literal `--`; the CLI entry point now strips it.
- Effect diagnostics rejected global timers, `new Date()`, and direct `process.platform` access; resolved with explicit Node timers, shared host-process services, and scoped exceptions.
- Two runs hung on `op read` awaiting biometric approval, not on the probe. Consolidated to a single secret read per run.
- `timeout(1)` is unavailable on macOS; replaced with a PID-tracked watchdog.

---

## Post-Review Fixes (2026-07-31)

An independent implementation review recorded 14 findings; all are resolved or documented.

| Finding                                              | Resolution                                                                                                                                                                                               |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — rejected E6 credential recorded as `unsupported` | `unsupported` now requires an authorized, conclusive turn. Rejections, masked auth failures, result errors, and timeouts all route to `ambiguous`. Three rejection shapes covered by test.               |
| 2 — hardcoded provenance                             | SDK and bundled Claude Code versions read from the installed manifest, `lockfileVersion` parsed from the lockfile, unmeasurable values recorded as `unknown`. Regression test asserts they are measured. |
| 3 — pre-existing output directory re-permissioned    | `chmod` applies only to a directory the probe created.                                                                                                                                                   |
| 4 — case-sensitive auth match                        | Lowercased before matching, both casings tested.                                                                                                                                                         |
| 5 — masked-failure flag too broad                    | Split into `errorMaskedAsCompleted` (cause-agnostic) and `authFailureMaskedAsCompleted` (assistant auth error only).                                                                                     |
| 6 — isolation claims were constants                  | `cwdMatchesControl`/`configDirMatchesControl` compare real paths; `temporaryStateRemovedAfterRun` reflects the observed cleanup.                                                                         |
| 7 — message summaries bypassed redaction             | `assistantError` is redacted with the same secrets and paths as every other free-text field.                                                                                                             |
| 8 — `--case-timeout-ms` unvalidated                  | Bounded to 1s–600s; a non-positive value is rejected before any case runs.                                                                                                                               |
| 9 — unredacted defect reachable on stderr            | The defect is redacted before being attached as `cause`.                                                                                                                                                 |
| 10, 11 — E0/E1 duplication, mirror drift             | Documented as deliberate and as accepted risk respectively, with reasons in code and runbook.                                                                                                            |
| 12, 13, 14                                           | Stale branch metadata corrected, magic numbers named, argv strip explained.                                                                                                                              |

### Additional defect found while re-running

The first provenance fix silently degraded to `"unknown"`: the SDK's `exports` map does not expose `./package.json`, so `import.meta.resolve` threw. Corrected by resolving the entry point and walking up to the adjacent manifest, and covered by a test that asserts the values are measured rather than merely present.

Running the runbook's own command surfaced a defect no static review would catch: `pnpm --filter t3 run` executes with the working directory set to `apps/server`, so a repo-root-relative `--output` wrote to `apps/server/artifacts/…`, which the root-anchored `.gitignore` pattern did **not** cover — the documented workflow produced a committable evidence file. Fixed three ways: the ignore pattern is now `**/artifacts/bonzai-runtime-validation/`, relative output paths resolve against the workspace root, and the runbook states the behavior. The stray report was relocated into the ignored directory.

### Second review (approved, 4 low findings taken)

| Finding                                                 | Resolution                                                                                                                                                                                                 |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 15 — `cwdMatchesControl` derived but still tautological | Now compares resolved real paths via `realPathsMatch`, so a moved temp root, a symlink resolving elsewhere, or an unreadable transcript directory makes it false. Resolution failure counts as a mismatch. |
| 16 — `resolveOutputPath` fell back to `process.cwd()`   | Fails closed with `BonzaiRuntimeValidationInputError` instead of silently reinstating the committable-evidence bug. Test asserts the throw.                                                                |
| 17 — two orphaned doc comments                          | Provenance-policy block moved onto `readSdkProvenance`; `readLockfileVersion` has its own comment back.                                                                                                    |
| 18 — `ReadonlySet<string>`                              | Typed `ReadonlySet<ResultClassification>`, so a typo is a compile error rather than a silent fail-open toward `unsupported`.                                                                               |

Verification run `20260731T121255Z-review2` confirms the output-path fix in the real invocation: `pnpm --filter t3 run` executed with cwd `apps/server`, and evidence still landed at the repo root with no `apps/server/artifacts` created.

Earlier evidence of record: `20260731T101633Z-final.json`, provenance fully measured (`agentSdkVersion: 0.3.170`, `bundledClaudeCodeVersion: 2.1.170`, `pnpmVersion: 11.10.0`, `lockfileVersion: 9.0`), decision `supported`, all substantive conclusions unchanged.

---

## Follow-ups

- [x] Level 6 evidence gate closed by project-owner risk acceptance; independent re-run and gateway-log correlation explicitly waived as non-blocking auditability gaps
- [ ] Phase 3: auth-error mapping and retry/deadline cap
- [ ] Phase 3: fresh-session fallback when a key change crosses billing contexts
- [ ] Consider reporting the `is_error` gap in `turnStatusFromResult` as a provider-agnostic bug — it affects any gateway returning `subtype: "success"` with `is_error: true`
- [ ] Optional E7 cross-scope test, only under separate written authorization

---

## Unrelated Security Finding

Eight processes on this machine carry a Bonzai-style key inline in their arguments (`docker compose exec … ANTHROPIC_AUTH_TOKEN=sk-… claude --dangerously-skip-permissions`), launched from `~/Documents/ObsidianVaults/second-brain`, sourced from that directory's `.env`, some running since 2026-07-28. Process arguments are world-readable, unlike environment variables. Recommended: pass `-e ANTHROPIC_AUTH_TOKEN` (no value) or use compose `env_file`, then rotate the key. Not touched; outside this repository.
