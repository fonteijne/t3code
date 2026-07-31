---
pr: none
title: "docs: add Bonzai runtime validation spike evidence and Phase 1 completion"
author: "Carsten de la Fonteijne"
branch: bonzai/phase-1-runtime-validation
commit: b9058a20
reviewed: 2026-07-31
recommendation: request-changes
---

# Review: `bonzai/phase-1-runtime-validation` (b9058a20)

**Branch**: `bonzai/phase-1-runtime-validation` → `main`
**Files Changed**: 8 (+3024/-1)
**No pull request exists** for this branch — reviewed as a local branch diff against `main`. Nothing was posted to GitHub.

---

## Summary

Adds an opt-in, maintainer-only harness that validates Bonzai gateway behavior through the pinned Claude Agent SDK: an E0–E7 experiment matrix recording how missing/empty/invalid credentials terminate, and whether a session created under key K1 can resume under replacement key K2. Ships the script, a synthetic unit suite, an operator runbook, redacted live evidence, and PRD decision updates.

The security engineering is the strongest part of this change: credentials are env-only, the child environment is an allowlist rather than a denylist, and an independent sentinel leak guard fails closed before any evidence is written. The harness also surfaced a genuine production bug in `ClaudeAdapter.turnStatusFromResult` — I verified that independently.

My findings cluster on one theme rather than many: **the evidence artifact asserts several facts it never measures**, and the decision function contradicts the decision rule its own runbook documents. For a deliverable whose entire value is auditable evidence, those matter more than they would in ordinary code. All are contained to a non-production, opt-in script — nothing here reaches users.

---

## Implementation Context

| Artifact              | Path                                                                   |
| --------------------- | ---------------------------------------------------------------------- |
| Implementation Report | `.claude/PRPs/reports/bonzai-runtime-validation-spike-report.md`       |
| Original Plan         | `.claude/PRPs/plans/completed/bonzai-runtime-validation-spike.plan.md` |
| Source PRD            | `.claude/PRPs/prds/bonzai-project-keys.prd.md`                         |
| Documented Deviations | 4 (all justified)                                                      |

Deviation documentation quality is high. The four recorded deviations (`--model`, `--case-timeout-ms`, added falsification controls, and a post-first-run correction of the projection mirror) each state _why_, and the fourth is a candid self-correction of an earlier wrong rationale. None of my findings below duplicate a documented deviation.

---

## Changes Overview

| File                                                    | Changes | Assessment                                                       |
| ------------------------------------------------------- | ------- | ---------------------------------------------------------------- |
| `apps/server/scripts/bonzai-runtime-validation.ts`      | +1243   | WARN — findings 1–9                                              |
| `apps/server/scripts/bonzai-runtime-validation.test.ts` | +418    | PASS — 18 focused tests, good adversarial cases                  |
| `docs/operations/bonzai-runtime-validation.md`          | +137    | PASS — genuinely operational                                     |
| `.claude/PRPs/plans/completed/…spike.plan.md`           | +787    | PASS                                                             |
| `.claude/PRPs/prds/bonzai-project-keys.prd.md`          | +293    | PASS                                                             |
| `.claude/PRPs/reports/…spike-report.md`                 | +143    | WARN — finding 12                                                |
| `apps/server/package.json`                              | +2/-1   | PASS — `probe:bonzai-runtime`, package name `t3` matches runbook |
| `.gitignore`                                            | +1      | PASS — `artifacts/bonzai-runtime-validation/` ignored            |

---

## Issues Found

### Critical

No critical issues found. No credential reaches the evidence file, the acknowledgement gate precedes every secret read, and the leak guard fails closed.

---

### High Priority

**1. `bonzai-runtime-validation.ts:603-627` — a rejected E6 credential is recorded as `unsupported`, contradicting the documented decision rule.**

The ambiguity list checks four classifications:

```ts
["stream-exception", "no-terminal-result", "timeout", "skipped"].includes(input.e6.classification);
```

`result-then-exception` is absent, so it falls through to `successfulContinuity(e6, true)` → false → `unsupported`, with rationale _"E6 returned a conclusive result without preserving the E4 session and marker."_

But `result-then-exception` is **exactly** the shape this run recorded for every rejected credential (E0/E1/E2), and the report itself (lines 59-63) documents that this shape carries no conclusive gateway signal — production shows only the generic `Claude runtime stream failed.`

- **Why it matters**: Both the plan (`:363-364`) and runbook (`:103-104`) reserve `unsupported` for a **clear** authorization rejection, and assign _"only a generic process/transport error"_ to `ambiguous`. So if K2 were rejected, the harness would record "replacement-key resume does not work" when the truth is "K2 was rejected outright" — two conclusions that imply different Phase 3 designs. The harness already computes the signal needed to tell them apart (`authFailureMaskedAsCompleted`) and then ignores it.
- **Verified**: a synthetic E6 carrying `classification: "result-then-exception"`, `assistantErrors: ["authentication_failed"]`, `authFailureMaskedAsCompleted: true` yields `value: "unsupported"`.
- **Bounded by**: Phase 3 maps `unsupported` and `ambiguous` to the same fresh-session fallback (plan `:367`), so the _action_ is unaffected. The recorded rationale is what misleads.
- **Fix**: treat a masked auth failure as inconclusive before the fall-through:
  ```ts
  if (input.e6.t3Projection.authFailureMaskedAsCompleted ||
      ["stream-exception", "no-terminal-result", "timeout", "skipped"].includes(input.e6.classification)) {
    return { value: "ambiguous", rationale: "E6 did not produce a conclusive gateway result…", … };
  }
  ```
  Consider `sdk-result-error` too — a gateway 500 currently also reads as `unsupported`.

**2. `bonzai-runtime-validation.ts:25-26, 906-908, 1136` — four report provenance fields are hardcoded constants, not measurements.**

```ts
const SDK_VERSION = "0.3.170";
const CLAUDE_CODE_VERSION = "2.1.170";
…
return NodeProcess.env.npm_config_user_agent?.match(/pnpm\/([^\s]+)/u)?.[1] ?? "11.10.0";
…
lockfileVersion: "9.0",
```

- **Why it matters**: runbook review step 1 instructs the reviewer to _"Confirm the SDK, bundled Claude Code, Node, pnpm, lockfile, OS, and architecture metadata."_ Four of those seven can never fail to match, because the report states them rather than observes them. `package.json` pins `^0.3.170` — a caret range — so a routine `pnpm update` yields a report that still claims 0.3.170 while testing something else. The `?? "11.10.0"` fallback is worse than `"unknown"`: it fabricates a plausible value that reads as measured.
- **Verified today**: installed SDK is `0.3.170`, lockfile is `9.0`, pnpm is `11.10.0` — all four constants are _currently correct_, which is precisely why the drift would go unnoticed.
- **Fix**: read the SDK version from its installed `package.json`, parse `lockfileVersion` from `pnpm-lock.yaml`, and make unavailable provenance explicit (`"unknown"`) rather than assumed. `CLAUDE_CODE_VERSION` should be read from the SDK's bundled CLI if it exposes it; if not, name the constant so its provenance is obvious (e.g. `DECLARED_CLAUDE_CODE_VERSION`) and say so in the runbook.

---

### Medium Priority

**3. `bonzai-runtime-validation.ts:1166-1167` — the probe silently re-permissions a pre-existing output directory.**

```ts
NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true, mode: 0o700 });
NodeFS.chmodSync(NodePath.dirname(output), 0o700);
```

`mode:` applies only to directories `mkdirSync` actually creates. The unconditional `chmodSync` then tightens whatever directory already exists. Verified: a pre-existing `artifacts/` at `755` becomes `700`.

- **Why**: `--output docs/run.json` would re-permission `docs/`. On a shared machine or CI runner this can break other tooling or other users' access, and it is an unrequested side effect on a directory the probe does not own.
- **Fix**: chmod only when the probe created the directory (`mkdirSync` returns the first path it created when `recursive: true`), or validate that the output directory is empty/probe-owned before adjusting it.

**4. `bonzai-runtime-validation.ts:524` — the auth heuristic is case-sensitive, unlike the production code it mirrors.**

```ts
(input.assistantErrors ?? []).some((error) => error.includes("auth"));
```

Production lowercases before matching (`resultErrorsText`, `ClaudeAdapter.ts:300-304`), and this file lowercases at line 492 — but not here. Verified: `"authentication_failed"` sets the flag; `"Authentication_Failed"` does not.

- **Fix**: `error.toLowerCase().includes("auth")`. Add a fixture asserting the capitalized form.

**5. `bonzai-runtime-validation.ts:522-525` — `authFailureMaskedAsCompleted` fires on any `is_error`, not just authorization errors.**

`authSignalled` is true whenever `terminalResult.isError === true`, regardless of cause. Verified: a result with `subtype: "success"`, `is_error: true`, `errors: ["disk quota exceeded"]` is reported as a _masked auth failure_.

- **Why**: the runbook's troubleshooting table (`:131`) tells operators to read this flag as _"The credential failed."_ A quota or transport error would be misfiled as an authorization finding — and finding 1 above proposes routing decisions through this same flag, which compounds it.
- **Fix**: rename to `errorMaskedAsCompleted` for the general case and gate a separate `authFailureMaskedAsCompleted` on the assistant-error signal only; update the runbook row to match.

**6. `bonzai-runtime-validation.ts:830-831, 1150` — isolation claims are constants, same class as finding 2.**

`cwdMatchesControl: true`, `configDirMatchesControl: true`, and `temporaryStateRemovedAfterRun: true` are literals. The last is set at line 1150, _before_ the `finally` at line 1171 that performs the removal — so the report asserts cleanup succeeded even if `rmSync` throws. Field names ending in `MatchesControl` read as verification results; runbook step 6 asks reviewers to confirm them.

- **Fix**: derive the match by comparing each observation's recorded cwd/config against E4's, and set `temporaryStateRemovedAfterRun` from the actual `rmSync` outcome — or drop the fields, since fields that cannot be false give a reviewer false assurance. Note the runbook already hedges correctly with a manual `t3-bonzai-runtime-*` check (step 10); the JSON field undercuts it.

**7. `bonzai-runtime-validation.ts:663-688` — message summaries bypass redaction.**

`sensitivePaths` is computed at line 757 and passed to `normalizeTerminalResult` and the exception handler, but not to `summarizeSdkMessage`. `assistantError` therefore enters the report raw.

- **Bounded by**: `assertNoSecretSentinels` catches known credentials in raw, URL-encoded, and base64 form and throws before writing — so credential leakage is fail-safe. **Paths are not sentinels**, so a home-directory path in an SDK error message would be written verbatim, defeating the `PATH_REPLACEMENT` intent applied everywhere else.
- **Fix**: pass `secrets`/`sensitivePaths` into `summarizeSdkMessage` and redact `assistantError`.

**8. `bonzai-runtime-validation.ts:948, 1195` — `--case-timeout-ms` is never validated.**

Every other flag is checked in `validateBonzaiRuntimeInput`; this one is read straight from `rawInput`. Verified: `caseTimeoutMs: -1` passes validation. `NodeTimers.setTimeout` with a non-positive delay fires on the next tick, aborting all eight cases immediately — producing a full report of `timeout` classifications that looks like a gateway problem.

- **Fix**: reject non-positive (and implausibly large) values in `validateBonzaiRuntimeInput`, alongside the existing checks.

**9. `bonzai-runtime-validation.ts:248, 1174-1182` — the leak guard protects the file but not stderr.**

`BonzaiRuntimeValidationWriteError.cause` is `Schema.Defect()`, and the catch wraps _any_ unrecognized defect. `NodeRuntime.runMain` prints the cause on failure. If the SDK ever throws with a token embedded in a URL or header dump, that reaches the terminal unredacted — and terminals scroll into shell logs and screenshots, which the runbook (`:13`) explicitly forbids.

- **Fix**: redact the defect through `redactSensitiveText` with the sentinel list before attaching it as `cause`.

---

### Suggestions

**10. `:975-1002` — E0 and E1 are byte-identical.** Same `credentialLabel: "none"`, same `credentialMode: "absent"`, same prompt, same everything; the evidence table records _"E1 | identical to E0."_ Their stated purposes differ (contamination detection vs. missing-token shape) but nothing in the setup distinguishes them, and both carry `credential: "none"` so the report can only tell them apart by `id`. Costs one extra live round trip and one extra timeout window on failure paths. Either differentiate E0 (e.g. run it without `ANTHROPIC_BASE_URL` as a true pre-flight) or merge the cases and say so in the runbook table.

**11. `:484-507` — mirror-drift risk.** `productionTurnStatusFromResult` reimplements `isInterruptedResult` and `resultErrorsText` inline rather than importing them. I verified the mirror is currently faithful to `ClaudeAdapter.ts:300-319`, but nothing pins it — a change to either production helper leaves the harness silently misreporting what T3 would do. Either export the production helpers and call them, or add a test that fails when they diverge. The report's own follow-up (`:136`) proposes fixing the `is_error` gap in production, which will invalidate this mirror.

**12. Report metadata is stale.** `…spike-report.md:5` claims `Branch: t3code/prd-generator-initiated`; the actual branch is `bonzai/phase-1-runtime-validation`.

**13. `:769-770` — undocumented magic numbers.** `maxTurns: 1` and `maxBudgetUsd: 0.05` carry real semantics (single turn; hard cost ceiling per case) and deserve named constants beside `DEFAULT_CASE_TIMEOUT_MS`.

**14. `:1238` — positional `--` strip is fragile.** `if (NodeProcess.argv[2] === "--")` handles only the exact pnpm forwarding shape. Acknowledged in the report; a comment naming the invocation it compensates for would keep the next reader from deleting it.

---

## Validation Results

| Check                | Status        | Details                                                                                                                                                                      |
| -------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type check           | PASS          | Zero errors. 6 pre-existing suggestions in `src/orchestration/decider.ts`, untouched by this change — matches the report's claim exactly.                                    |
| Lint                 | PASS          | Zero findings in changed files. 12 warnings, all pre-existing in `apps/web` (`ChatMarkdown.tsx`, `CommandPalette.tsx`, `SidebarUpdatePill.tsx`, `ThreadTerminalDrawer.tsx`). |
| Format               | PASS          | `vp fmt --check` — all 2345 files correct.                                                                                                                                   |
| Tests                | PASS          | 1826 passed, 7 skipped, 196 files. The 18 new tests match the report's count.                                                                                                |
| Build                | PASS          | `vp pack` — 10 files, 13.51 MB, clean.                                                                                                                                       |
| Finding verification | 5/5 confirmed | Findings 1, 3, 4, 5, 8 reproduced empirically; temp fixtures removed.                                                                                                        |

Environment note: the local toolchain runs Node v26.3.1 against an `engines` requirement of `^24.13.1`, producing an `Unsupported engine` warning on every pnpm invocation. Pre-existing and unrelated to this change, but it means the recorded `nodeVersion` in a live run reflects an out-of-spec runtime.

---

## Pattern Compliance

- [x] Follows existing code structure — Effect `Schema`, `Effect.fn`, `Command`/`Flag` CLI, tagged errors
- [x] Type safety maintained — no implicit `any`, explicit return types, `Schema.Literals` for closed sets
- [x] Naming conventions followed
- [x] Effect diagnostics respected — three narrow, individually justified `@effect-diagnostics` scopes rather than a blanket disable
- [x] Tests added for new code — 18 focused unit tests, no live-network dependency
- [x] Documentation updated — runbook, PRD, implementation report
- [ ] Field names match what the code measures — see findings 2 and 6

---

## What's Good

- **The credential handling is genuinely careful.** Env-only injection with no token-valued flags; an allowlist child environment (`SAFE_ENVIRONMENT_NAMES`) rather than a denylist, with a test proving inherited `ANTHROPIC_*` values are dropped; K1 ≠ K2 enforced; base URLs carrying userinfo or query strings rejected.
- **Defense in depth on the evidence file, and it fails closed.** Layered regex redaction _plus_ an independent sentinel scan across raw, URL-encoded, and base64 representations, which throws rather than writing a suspect report. `flag: "wx"` refuses to overwrite prior evidence; `0o600` file, `0o700` directories.
- **The acknowledgement gate is ordered correctly** — `validateBonzaiRuntimeInput` runs before any secret is read, and there is a test asserting exactly that. Easy to get backwards; this doesn't.
- **The falsification controls are the best judgment call in the change.** Recognizing that E6 succeeding proves nothing without showing the same resume _fails_ without a valid credential — and then noting that the plan's own decision rule would have accepted the weaker evidence — is the difference between a result and a proof.
- **It found a real production bug.** I confirmed `turnStatusFromResult` (`ClaudeAdapter.ts:997`) keys only on `subtype`, so `subtype: "success"` with `is_error: true` projects as a completed turn and the actionable `Not logged in · Please run /login` is discarded. Provider-agnostic, affects any gateway with that response shape, and correctly routed to a follow-up.
- **The runbook is written for an operator, not for a reviewer.** The troubleshooting table maps symptom → interpretation → action, and several rows actively warn against over-reading evidence ("Do not label it an HTTP authorization status", "never to force a result"). The `git check-ignore` verification step is a nice touch.
- **Honest reporting.** The status line keeps independent sign-off open rather than claiming completion; deviations include a self-correction admitting the first run's rationale misdescribed the mechanism; the unrelated finding about eight processes carrying inline keys was flagged and left untouched rather than quietly fixed.

---

## Recommendation

**REQUEST CHANGES** — on evidence integrity, not on approach. The design, isolation model, and security posture are sound and I would not ask for rework there.

Two findings should land before this is treated as the Phase 1 record of fact:

1. **Finding 1** — align `deriveResumeDecision` with the rule the plan and runbook already document, so a rejected credential cannot be recorded as "resume unsupported."
2. **Finding 2** — measure the provenance fields, or mark them as declared. A reviewer following runbook step 1 currently cannot detect drift.

Findings 3–9 are small, localized fixes; 3 (directory re-permissioning) and 9 (unredacted defect on stderr) are worth taking in the same pass since both touch the security properties this harness exists to uphold. 10–14 are optional.

Worth noting on scope: the conclusions this evidence supports — replacement-key resume works, auth failures don't surface — are the parts I could verify against the code, and both hold. Findings 1 and 2 do not change those answers; they affect whether a _future_ run of this harness can be trusted to report its own conditions accurately. The report's outstanding follow-up (independent second-maintainer review) remains the right gate before the PRD is treated as settled — and this review is not that, since I am reviewing the implementation rather than independently re-running the live matrix.

No PR exists for this branch. If you want this review attached to one, create the PR and I can post it.

---

_Reviewed by Claude_
_Report: `.claude/PRPs/reviews/bonzai-phase-1-runtime-validation-review.md`_
