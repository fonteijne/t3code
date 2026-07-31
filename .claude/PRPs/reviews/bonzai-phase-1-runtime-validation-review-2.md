---
pr: none
title: "Bonzai Phase 1 runtime validation — second review (post-fix)"
author: "Carsten de la Fonteijne"
branch: bonzai/phase-1-runtime-validation
reviewed: 2026-07-31
supersedes: bonzai-phase-1-runtime-validation-review.md
recommendation: approve
---

# Second Review: Bonzai Phase 1 runtime validation

**Branch**: `bonzai/phase-1-runtime-validation`
**Reviewed state**: uncommitted working tree on top of `f87cdbd1` (diff fingerprint `1338a4e747d0`)
**Delta**: 5 files, +336/-43 over the first-review baseline

> The working tree was still being edited when this review began — an earlier `git status` showed no `.gitignore` change and a stray untracked `apps/server/artifacts/`, both of which had resolved by the time I re-checked. Findings below reflect the settled state at fingerprint `1338a4e747d0`. Two intermediate observations I made against the mid-edit tree turned out to be already fixed and are noted as such rather than raised.

---

## Verdict

**APPROVE.** All 14 findings from the first review are resolved or explicitly documented with reasons. The four remaining items are Low, cosmetic or defensive, and none touches evidence integrity, security, or the spike's conclusions.

Two things raise this above a routine fix pass:

- **The developer found a defect the first review missed by actually running the documented workflow.** `pnpm --filter t3 run` sets cwd to `apps/server`, so the runbook's repo-root-relative `--output` wrote evidence to `apps/server/artifacts/…`, which the root-anchored `.gitignore` pattern did not cover. The documented happy path produced a committable evidence file. I independently confirmed this was real before it was fixed: `git check-ignore` returned exit 1 on that path. Fixed three ways — `**/artifacts/bonzai-runtime-validation/`, `resolveOutputPath` resolving against the workspace root, and a runbook note. Verified: `check-ignore` now exits 0, and the stray file was relocated to the ignored directory. No static review would have caught this; running the runbook did.
- **A fix that silently degraded was caught by its own regression test.** The first provenance attempt returned `"unknown"` because the SDK's `exports` map does not expose `./package.json`, so `import.meta.resolve` threw into the catch-all. The test asserting the values are _measured_ rather than merely _present_ caught it. That pairing — a defensive fallback plus a test that forbids the fallback in normal operation — is what makes the catch-all acceptable rather than a liability.

---

## Findings 1–14: Resolution

| #   | Sev  | Resolution                                                                                                                                                                                                                                              | Verified                                                                                                              |
| --- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | High | `INCONCLUSIVE_E6_CLASSIFICATIONS` now covers `result-then-exception` and `sdk-result-error` alongside the original four, plus explicit checks on `authFailureMaskedAsCompleted` and lowercased assistant auth errors. Both rationale strings rewritten. | Test enumerates three rejection shapes → all `ambiguous`                                                              |
| 2   | High | `readSdkProvenance()` resolves the SDK entry point and reads the adjacent manifest; `readLockfileVersion()` parses `pnpm-lock.yaml`; `readPnpmVersion()` falls back to `UNKNOWN_PROVENANCE`.                                                            | `claudeCodeVersion` confirmed a real manifest field (`2.1.170`), so the value is measured, not coincidentally correct |
| 3   | Med  | `chmod` applies only to `mkdirSync`'s returned created path.                                                                                                                                                                                            | Re-ran my probe: pre-existing `755` parent stays `755`; created subdir `700`                                          |
| 4   | Med  | `error.toLowerCase().includes("auth")`.                                                                                                                                                                                                                 | Test covers both casings                                                                                              |
| 5   | Med  | Split into `errorMaskedAsCompleted` (cause-agnostic) and `authFailureMaskedAsCompleted` (assistant auth error only). Schema, `skippedObservation`, and runbook row updated.                                                                             | Live evidence: E0–E2 both `true` (auth-caused), E3 timeout both `false`                                               |
| 6   | Med  | `cwdMatchesControl`/`configDirMatchesControl` compare real paths; `temporaryStateRemovedAfterRun` set from `removeTemporaryState()`, which `rmSync`es then confirms with `existsSync`.                                                                  | Live evidence records `true` from observation; see finding 15 for the residual                                        |
| 7   | Med  | `summarizeSdkMessage` takes `secrets`/`sensitivePaths` and redacts `assistantError`.                                                                                                                                                                    | —                                                                                                                     |
| 8   | Med  | Bounded to 1s–600s in `validateBonzaiRuntimeInput`, with the reason in a comment.                                                                                                                                                                       | Test covers `-1`, `0`, `900_000`, `NaN`, and a valid value                                                            |
| 9   | Med  | Defect redacted to a string (stack or message) before being attached as `cause`.                                                                                                                                                                        | —                                                                                                                     |
| 10  | Low  | E0/E1 duplication documented as deliberate — E0 is the contamination gate, E1 the recorded shape — in both code and the runbook table.                                                                                                                  | —                                                                                                                     |
| 11  | Low  | Mirror-drift documented: cites `ClaudeAdapter.ts:997` and `:300-319`, notes the helpers are module-private so this is a copy, and that fixing production invalidates the mirror by design.                                                              | Accepted risk, correctly reasoned — see note below                                                                    |
| 12  | Low  | Branch metadata corrected to `bonzai/phase-1-runtime-validation`.                                                                                                                                                                                       | —                                                                                                                     |
| 13  | Low  | `CASE_MAX_TURNS`, `CASE_MAX_BUDGET_USD`, `MIN`/`MAX_CASE_TIMEOUT_MS` named with doc comments.                                                                                                                                                           | —                                                                                                                     |
| 14  | Low  | argv strip comment names the exact invocation it compensates for.                                                                                                                                                                                       | —                                                                                                                     |

On **finding 1**, the fix is better than what I proposed. Adding `sdk-result-error` to the inconclusive set — which I raised only as a "consider" — means `unsupported` is now reachable _only_ when `classification === "success"`. That is exactly the semantics the new rationale claims ("E6 was authorized and returned a conclusive turn, but did not preserve the E4 session ID and marker"), so the code and its recorded justification are now the same statement. The reworked test asserting a fresh-session-under-authorized-turn is the right shape for it.

On **finding 11**, declining to add a mirror-pinning test is the correct call given the production helpers are module-private; exporting them purely for a probe would be worse. The residual risk stands and is now documented where the next reader will hit it.

---

## New Findings

All Low. None blocks.

**15. `bonzai-runtime-validation.ts:901-902` — `cwdMatchesControl` is now derived but still tautological.**

`input.cwd === input.controlCwd`, and all eight call sites pass `controlCwd: cwd` — the same variable. The field cannot currently be false.

This is a genuine improvement in form: a future refactor that gives a resume case its own directory would now be caught rather than silently mislabeled. But as of today the field still gives a reviewer no information, which was the substance of finding 6. Worth either a comment saying it guards future drift rather than verifying present behavior, or deriving it from E4's recorded observation (`observationById(observations, "E4")`) so the comparison crosses a real boundary.

**16. `:1057-1062` — `resolveOutputPath` silently falls back to `process.cwd()`.**

```ts
const workspaceRoot = lockfile === undefined ? NodeProcess.cwd() : NodePath.dirname(lockfile);
```

If the lockfile is not found, the function silently reinstates the exact behavior it was written to prevent — a relative output resolving against `apps/server` and landing outside the ignored directory. Unreachable in practice (the lockfile is three levels up from `apps/server/scripts`, well inside the depth-6 bound), which is why this is Low. But given the failure mode is "evidence written somewhere committable," throwing a `BonzaiRuntimeValidationInputError` would be the safer default than guessing.

**17. `:994-999` and `:1050` — two orphaned doc comments.**

Both are cases where a new function was inserted between an existing comment and its target:

- The provenance-policy block (_"Provenance is measured from the installed tree, never asserted…"_) sits above `findNearestFile`, a generic path utility. It belongs to `readSdkProvenance`.
- `readLockfileVersion`'s one-liner (_"Reads `lockfileVersion` from the workspace lockfile…"_) sits above `resolveOutputPath`, leaving `readLockfileVersion` itself undocumented and `resolveOutputPath` carrying two stacked blocks.

Cosmetic, but this file's comments are unusually good — they explain _why_ rather than restating _what_ — so a misfiled one is more misleading here than it would be elsewhere. Move each above its intended function.

**18. `:36-44` — `INCONCLUSIVE_E6_CLASSIFICATIONS` is typed `ReadonlySet<string>`.**

Typing it `ReadonlySet<ResultClassification>` would make a typo in the set literal a compile error and keep it in sync if a classification is ever renamed. As written, `.has()` accepts any string and a misspelled entry would silently never match — failing open toward `unsupported`, the more consequential verdict.

---

## Validation Results

| Check            | Status        | Details                                                                                             |
| ---------------- | ------------- | --------------------------------------------------------------------------------------------------- |
| Type check       | PASS          | 0 errors. Same 6 pre-existing suggestions in untouched `src/orchestration/decider.ts`.              |
| Lint             | PASS          | 0 findings in changed files.                                                                        |
| Format           | PASS          | 2346 files.                                                                                         |
| Tests            | PASS          | **1834 passed**, 7 skipped — 8 new tests over the 1826 baseline.                                    |
| Build            | Not re-run    | No change to the build surface; the prior run was clean and nothing in this delta touches bundling. |
| Fix verification | 5/5 confirmed | Findings 2, 3, 5, 6, and the gitignore defect verified independently, not read from the diff.       |

**Live evidence** (`artifacts/bonzai-runtime-validation/20260731T101633Z-final.json`, `0600`, ignored):

```
runtime:  agentSdkVersion 0.3.170 · bundledClaudeCodeVersion 2.1.170 · nodeVersion v22.22.3
          pnpmVersion 11.10.0 · lockfileVersion 9.0 · darwin/arm64     (all measured)
isolation: temporaryStateRemovedAfterRun true                          (observed)
decision:  supported

id | classification        | errMasked | authMasked | retries
E0 | result-then-exception | true      | true       | 0
E1 | result-then-exception | true      | true       | 0
E2 | result-then-exception | true      | true       | 0
E3 | timeout               | false     | false      | 7
E4 | success               | false     | false      | 0
E5 | success               | false     | false      | 0
E6 | success               | false     | false      | 0
E7 | skipped               | false     | false      | 0
```

Scanned for leakage: 0 `sk-`-shaped tokens, 0 raw `Bearer` headers, 0 absolute home paths, 0 redaction markers — the last meaning nothing sensitive ever entered the report rather than that redaction fired. The E0–E2 flags now correctly distinguish an auth-caused mask from E3's plain timeout, and E3's 7 retries match the documented storm. Decision remains `supported`; all substantive conclusions are unchanged, as the report claims.

Four evidence files now accumulate locally in `artifacts/bonzai-runtime-validation/`, all `0600` and all ignored. Cleanup is per the runbook's retention section and remains an operator action.

---

## What's Good

- **The response to review is disciplined.** Every finding is addressed at the level it was raised: logic findings got logic fixes plus tests, judgment findings (10, 11) got documented rationale rather than churn, and cosmetic findings got named constants. Nothing was silently dropped, and the two the developer chose _not_ to change say why.
- **Running the thing found what reading it could not.** The cwd/gitignore interaction is the kind of defect that only surfaces when someone follows their own runbook end to end. Fixing it in all three places — pattern, code, and documentation — rather than just the one that would make the symptom go away is the right instinct.
- **The regression tests target the findings, not the lines.** `readSdkProvenance` is asserted to be _measured_ (`not.toBe("unknown")`), not merely non-empty; `resolveOutputPath` asserts `not.toContain("apps/server/artifacts")`; the E6 test loops three distinct rejection shapes. These fail if the defect returns by another route, which is the only kind of regression test worth having.
- **Splitting the masked-failure flag was done properly.** Not just renamed — the cause-agnostic and auth-specific signals are now separate fields with distinct doc comments, and the runbook row an operator reads was updated to match. The live evidence shows the distinction doing real work.
- **`temporaryStateRemovedAfterRun` is now genuinely observed**, including moving cleanup ahead of encoding so the outcome is knowable, while keeping the `finally` as a guard for early exits. That ordering change is easy to get wrong and the comment explains why it exists.
- **The report's own account is honest.** It records that the first provenance fix silently degraded, and that the gitignore defect came from running the documented command — neither flattering, both useful to the next reader.

---

## Recommendation

**APPROVE.**

Findings 15–18 are optional polish; 17 (orphaned comments) is the one I would take, since it is a two-line move and this file's comments are load-bearing for the next maintainer. 16 is worth a moment's thought only because its failure mode is "evidence somewhere committable."

Two things remain outstanding and neither is a code concern:

1. **The work is uncommitted.** 5 modified files sit in the working tree on top of `f87cdbd1`.
2. **Independent second-maintainer review of the redacted evidence is still open** — the plan's Level 6 gate, and still the right gate before the PRD is treated as settled. Neither of my reviews satisfies it: I reviewed the implementation, not a re-run of the live matrix, and I did not inspect the restricted gateway-side evidence.

---

_Reviewed by Claude_
_Report: `.claude/PRPs/reviews/bonzai-phase-1-runtime-validation-review-2.md`_
