---
title: "Bonzai Phase 1 — Level 6 evidence gate handoff"
purpose: Execution packet for the independent maintainer closing the Level 6 gate
prepared: 2026-07-31
prepared_by: Claude (implementation reviewer — NOT an independent signatory)
evidence_of_record: artifacts/bonzai-runtime-validation/20260731T101633Z-final.json
gate_status: SUPERSEDED_BY_OWNER_CLOSURE
---

# Level 6 evidence gate — handoff packet

**This handoff was superseded by project-owner risk acceptance on 2026-07-31.** The gate is closed in `.claude/PRPs/reviews/bonzai-phase-1-level-6-closure.md`; the independent re-run and gateway-side correlation described below were explicitly accepted as residual auditability gaps rather than performed.

**This document is not a sign-off and cannot become one.** It was prepared by the implementation reviewer, who reviewed the harness twice and therefore cannot attest to evidence the harness produced. Its purpose is to let an independent maintainer execute the gate without re-deriving what has already been mechanically checked, and to be explicit about what has _not_ been checked and by whom.

Gate authority: plan `.claude/PRPs/plans/completed/bonzai-runtime-validation-spike.plan.md` §Level 6 (8 steps) and runbook `docs/operations/bonzai-runtime-validation.md` §Review generated evidence (10 steps). Merged and deduplicated below.

**Evidence of record**: `artifacts/bonzai-runtime-validation/20260731T101633Z-final.json` (`0600`, gitignored, 35 KB, decision `supported`).

---

## Read this first: two blockers

Both must be resolved before the gate can be closed by anyone. Neither is a review judgment — the first is a code gap, the second an authorization-trail gap.

**B1 — The evidence file cannot support the correlation step 8 requires.**

Runbook step 8 asks you to compare gateway evidence to the report _"by case ID and approved correlation metadata."_ The artifact carries:

- no per-case timestamps — only one report-level `generatedAt` (`2026-07-31T10:21:46.581Z`), stamped after all eight cases had finished
- no request, correlation, or trace IDs anywhere

So even with full log access you would be matching eight cases against a single multi-minute window by inference. **E0 and E1 are byte-identical by design** (same credential mode, prompt, and configuration), so gateway-side they are not merely ambiguous — they are indistinguishable. Any correlation claim covering them would be unfounded.

_Required before step 8_: add per-case `startedAt`/`endedAt` to `BonzaiRuntimeObservation`, plus any request ID the SDK surfaces, then re-run. This is a small schema change; it needs a fresh run to produce a correlatable artifact, which the independent re-run supplies anyway.

**B2 — The recorded authorization is not a written artifact.**

`gateway.approvalReference` reads `key-owner-approval-in-session-2026-07-31`. The runbook's first precondition requires _written_ authorization covering the endpoint, synthetic prompts, and disposable keys. A reference pointing at an in-session verbal approval is not something a later auditor can verify, which undercuts the purpose of a gate whose product is auditability. Obtain a ticket, email, or signed reference and record that instead.

---

## Who can serve as the independent maintainer

The constraints interact, and the pool is narrower than it first appears:

| Constraint                                                           | Source                                              | Consequence                                                                                       |
| -------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Must not have authored the harness or run the original matrix        | Gate is independence, not correctness               | Excludes the report author and this reviewer                                                      |
| Must hold the disposable K1/K2 values to perform the sentinel search | Runbook review step 4                               | Must be trusted with the 1Password item — "independent" and "keyless" are mutually exclusive here |
| Must obtain a Bonzai operator, or be one                             | Runbook §Confirm the Bonzai contract, review step 8 | Step 8 is not self-serviceable                                                                    |
| Needs a dedicated OS account or controlled VM to re-run              | Runbook §Authorization and isolation                | An isolated `CLAUDE_CONFIG_DIR` does **not** prove Keychain state is absent on macOS              |

The third row is the scheduling constraint worth resolving first — operator availability gates the only step nothing else can substitute for.

---

## Status legend

| Mark      | Meaning                                                                                                                                   |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `MECH`    | Mechanically verified against the artifact or code by the implementation reviewer. **Real but not independent** — confirm, do not assume. |
| `OPEN`    | Not performed by anyone. Yours to do.                                                                                                     |
| `BLOCKED` | Cannot be performed until B1/B2 clear.                                                                                                    |

---

## The gate, step by step

### 1. Runtime and provenance metadata — `MECH`

_Plan L6.1 · Runbook R1_

Confirm SDK, bundled Claude Code, Node, pnpm, lockfile, OS, architecture.

```
agentSdkVersion 0.3.170 · bundledClaudeCodeVersion 2.1.170 · nodeVersion v22.22.3
pnpmVersion 11.10.0 · lockfileVersion 9.0 · darwin/arm64
```

All seven are now **measured at runtime**, not asserted — this was first-review finding 2. `claudeCodeVersion` was confirmed to be a real field in the installed SDK manifest, so the value is read rather than coincidentally correct. Unmeasurable values would record as `"unknown"`; none did.

_What to confirm_: that the recorded versions match the tree you re-run against. If they differ, the two runs are not comparable.

### 2. Approved origin, base path, credential scope, approval reference — `MECH` + see B2

_Plan L6.1 · Runbook R2_

```
approvedOrigin  https://api-v2.bonzai.iodigital.com
approvedBasePath /
credentialScope  bonzai-code-test-key-K1-K2-same-1password-item
approvalReference key-owner-approval-in-session-2026-07-31
requestedModel   claude-sonnet-4-5
```

Present and non-secret. Whether the origin and scope are the _approved_ ones is a human judgment only you and the key owner can make. Note `approvedBasePath: "/"` — the Anthropic-native `/v1/messages` surface at the root base URL, which the report states was confirmed separately with the operator. Re-confirm that; the OpenAI-compatible `/v1/chat/completions` surface is not what Claude Code uses.

See **B2** on the approval reference.

### 3. Environment presence, never values — `MECH`

_Plan L6.2 · Runbook R3_

Checked programmatically: every value in `credentialPresence` across all eight observations is a boolean. No credential value, and no environment value, appears in any presence field.

### 4. Sentinel search — `OPEN` (cannot be delegated to a keyless reviewer)

_Plan L6.3 · Runbook R4_

**Not done.** The implementation reviewer does not hold K1/K2 and so could not perform this check. What was done instead is a weaker shape-based scan of the artifact:

- `sk-`-shaped tokens: 0
- raw `Bearer` headers: 0
- absolute home paths (`/Users/…`): 0
- `[REDACTED_CREDENTIAL]` markers: 0 — meaning nothing sensitive ever entered the report, rather than that redaction fired to remove it

That is suggestive, not sufficient. **You must search the artifact for the actual K1/K2 values** in raw, URL-encoded, and base64 form — the probe's own leak guard checks all three, and the runbook requires an independent check beyond it. Do not paste the sentinels into a ticket, PR, or chat while doing so.

### 5. Message summaries, terminal results, and exceptions remain separate — `MECH`

_Runbook R5_

Verified on E0, the richest case: `messages[]`, `terminalResult`, and `caughtException` are all present as distinct fields; `caughtException` carries only `name` and `message`. The three failure signals are not conflated, which is what makes the `result-then-exception` classification meaningful.

### 6. E4–E6 isolation labels and exact session ID — `MECH`, with one caveat

_Plan L6.4 · Runbook R6_

| Case | cwdLabel       | configDirLabel           | session     | requested   | matches |
| ---- | -------------- | ------------------------ | ----------- | ----------- | ------- |
| E4   | `isolated-cwd` | `isolated-claude-config` | `d1b347af…` | —           | —       |
| E5   | `isolated-cwd` | `isolated-claude-config` | `d1b347af…` | `d1b347af…` | `true`  |
| E6   | `isolated-cwd` | `isolated-claude-config` | `d1b347af…` | `d1b347af…` | `true`  |

All three share one session ID; both resume cases requested and received it.

_Caveat (second-review finding 15)_: `cwdMatchesControl` is now computed rather than hardcoded, but all eight call sites pass the same variable for both operands, so the field cannot currently be false. Treat it as guarding future drift, not as evidence that isolation was independently verified.

### 7. E5 marker continuity before interpreting E6 — `MECH`

_Plan L6.5 · Runbook R7_

E5 records `markerResumed: true` with a matching session ID, and the runner gates E6 on `successfulContinuity(e5, true)` — E6 does not execute at all unless the same-key control passed. The ordering constraint is enforced in code, not merely documented.

The report additionally records falsification controls beyond the plan's matrix: the same resume fails with an invalid token (8 retries, no result) and with no token (`Not logged in`, 0.2s). Confirm you find these convincing — they are what make E6 evidence rather than coincidence.

### 8. Decision classification against the documented rule — `MECH`, confirm closely

_Plan L6.6_

Recorded decision: `supported`, continuity behavior `preserve-resume-for-validated-scope`.

**This is the step where independent confirmation matters most**, because the decision logic was rewritten in response to first-review finding 1 — raised, and then blessed, by the same reviewer. Check it yourself against the rule.

The rule (runbook `:100-107`, plan `:363-364`):

- `supported` — E4 succeeds, E5 proves same-key resume, E6 uses an approved same-context replacement key, E6 emits the requested durable session ID, and E6 recovers the E4 marker
- `unsupported` — E5 passes but E6 **conclusively** rejects, returns a fresh session, or loses the marker
- `ambiguous` — E0 contamination, E4/E5 control failure, only a generic process or transport error, or an unresolved path/header contract
- `security-review-required` — a separately scoped credential recovers E4 context

As implemented, `unsupported` is now reachable only when `classification === "success"` — every inconclusive shape (`result-then-exception`, `sdk-result-error`, `stream-exception`, `no-terminal-result`, `timeout`, `skipped`) plus any masked auth failure routes to `ambiguous`. Satisfy yourself that this matches the rule's intent rather than merely its letter.

### 9. Report gitignored, temporary state removed — `MECH`

_Plan L6.7 · Runbook R9, R10_

- `git check-ignore` on the artifact: exit 0, matched by `.gitignore:33` (`**/artifacts/bonzai-runtime-validation/`)
- `isolation.temporaryStateRemovedAfterRun`: `true`, now derived from an observed `rmSync` + `existsSync` check rather than asserted
- No `t3-bonzai-runtime-*` directories remain under `/tmp` or `/var/folders`

Note the history here: the runbook's own documented command previously wrote evidence to `apps/server/artifacts/…`, outside the then-root-anchored ignore pattern. Fixed in three places (pattern, `resolveOutputPath`, runbook note). When you re-run, re-verify `check-ignore` on _your_ output path rather than trusting this line.

### 10. Thread error banner actionability — `OPEN`, and the highest-value unblocked task

_Runbook `:96`_

Every observation records `threadErrorBannerActionable: "not-reviewed"`, and `reviewerNotes` is empty. **Nobody has done this.**

It requires a human to compare the redacted `lastError` against the actual three-line banner and full tooltip as rendered in T3 Code, and decide whether a user could act on it. It needs **no gateway access and no credentials** — so it is the one substantive outstanding item you can complete immediately, independent of operator scheduling.

Context for the judgment: for a missing or empty credential, production projects a **completed** turn and surfaces only `Claude runtime stream failed.`, discarding the actionable `Not logged in · Please run /login`. For an invalid credential there is no terminal result at all — an indefinite spinner. The report's position is that neither is understandable today. Record `yes`/`no` per case and your reasoning in `reviewerNotes`.

If upstream prose exposes implementation branding, restrict that evidence and raise a later product-mapping requirement — user-facing documentation must say Bonzai only.

### 11. Gateway-side correlation — `BLOCKED` on B1, then `OPEN`

_Runbook R8 · §Confirm the Bonzai contract 4_

Nobody has correlated any of these runs against Bonzai's own logs. This is the gate's irreducible step: no amount of local verification substitutes, and runbook `:117` is explicit that a live result must never be inferred or invented.

Sequence: clear **B1** (per-case timestamps and request IDs) → re-run → ask the operator which correlation evidence a reviewer may inspect → compare by case ID. Do not copy authorization headers, raw gateway logs, environment dumps, or full prompt bodies into the report.

Worth confirming with the operator while you have them, per the runbook's contract section: the exact base URL Claude Code consumes for `/v1/messages`; that the virtual key is accepted via the `ANTHROPIC_AUTH_TOKEN` bearer contract; and that K1 and K2 genuinely belong to the same approved replacement context — the last is load-bearing for the `supported` verdict.

### 12. PRD update — `OPEN`, and an ordering violation to resolve

_Plan L6.8 · Runbook `:109`_

The runbook requires updating the PRD _only after_ a second maintainer reviews the report and restricted evidence. **The PRD has already been updated**, pre-gate:

- three Open Questions marked `[x] Answered (Phase 1, 2026-07-31)` (`:48-50`)
- the resume risk marked `Retired — Resolved by Phase 1` (`:159`)
- two decision-table rows marked `Validated live 2026-07-31` (`:255-256`)

The _content_ rule is satisfied — the PRD carries redacted conclusions and references, no transcripts or credentials. It is the _ordering_ rule that was crossed, and `Retired` is the strongest of the three since it closes a risk on single-maintainer evidence.

Your call as the gate holder: either ratify the existing entries as part of closing the gate, or downgrade them pending closure (e.g. `Retired` → `Provisionally resolved (pending Level 6)`) so the artifact set stops reading as settled while the gate is open. The implementation reviewer's suggestion was the latter, but this is properly your decision.

---

## Summary

| Step                                | Status                              |
| ----------------------------------- | ----------------------------------- |
| 1 Provenance metadata               | `MECH` — confirm                    |
| 2 Origin, scope, approval reference | `MECH` — confirm; see B2            |
| 3 Presence never values             | `MECH` — confirm                    |
| 4 Sentinel search                   | **`OPEN`** — needs K1/K2            |
| 5 Signals remain separate           | `MECH` — confirm                    |
| 6 E4–E6 labels and session ID       | `MECH` — confirm; finding 15 caveat |
| 7 E5 control before E6              | `MECH` — confirm                    |
| 8 Decision vs documented rule       | `MECH` — **confirm closely**        |
| 9 Gitignored, temp state removed    | `MECH` — re-verify on your own run  |
| 10 Banner actionability             | **`OPEN`** — unblocked, do this now |
| 11 Gateway correlation              | **`BLOCKED`** on B1                 |
| 12 PRD update ordering              | **`OPEN`** — your decision          |

Seven steps are mechanically satisfied but unconfirmed by an independent party. Three are genuinely undone. One is blocked on a code change. Two prerequisites (B1, B2) sit ahead of closure.

---

## Sign-off

To be completed by the independent maintainer. Leave `gate_status: SUPERSEDED_BY_OWNER_CLOSURE` in this file's frontmatter until every row above is `MECH`-confirmed or closed.

```
Reviewer:                          (must not be the report author)
Date:
Independent re-run performed:      yes / no    run ID:
Isolation used:                    dedicated account / VM / other:
Sentinel search performed:         yes / no
Gateway correlation performed:     yes / no    operator:
Banner actionability recorded:     yes / no
B1 resolved (per-case metadata):   yes / no
B2 resolved (written approval):    yes / no
Decision confirmed:                supported / unsupported / ambiguous / security-review-required
PRD entries:                       ratified / downgraded pending closure
Deviations from this packet:
```

---

_Prepared by Claude. Explicitly not a Level 6 signatory — this packet records what was mechanically checked so an independent maintainer need not repeat it, and is precise about what remains undone._
