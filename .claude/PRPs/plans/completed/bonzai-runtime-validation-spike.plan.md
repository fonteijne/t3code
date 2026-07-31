# Feature: Bonzai Runtime Validation Spike

## Summary

Build an opt-in, maintainer-only Agent SDK probe that runs a fixed matrix against Bonzai with the repository-locked `@anthropic-ai/claude-agent-sdk@0.3.170`. The probe will isolate Claude state, accept credentials only through inherited secret environment variables, capture redacted SDK/result/exception observations, prove same-key resume as a control, and then test replacement-key resume without changing production runtime behavior. Its generated report will settle the exact authorization-error path and select the Phase 3 continuity behavior: direct resume only if the controlled K1→K2 case succeeds safely and reproducibly; otherwise start a fresh session rather than replaying an old transcript under a different credential.

## User Story

As a T3 Code maintainer
I want reproducible evidence for Bonzai authorization failures and replacement-key Claude session resume
So that the project-key domain and runtime binding can be implemented without relying on undocumented gateway behavior or risking cross-client context exposure.

## Problem Statement

T3 Code already forwards Claude Agent SDK failures through several distinct paths and persists resume IDs, but neither the codebase nor public Anthropic/Bonzai documentation establishes (1) the exact error visible when Bonzai rejects a missing or invalid key, or (2) whether a session created under one authorized key can safely resume under another authorized key. Later Bonzai phases depend on both answers. Phase 1 is complete only when a controlled, repeatable matrix records the raw SDK termination shape, the equivalent T3-facing `lastError` text, and an explicit supported/unsupported/ambiguous resume decision without storing raw credentials.

## Solution Statement

Add a standalone probe under `apps/server/scripts`, matching the repository's existing provider probe and Effect CLI patterns. The probe will expose pure redaction/classification helpers for focused tests, run each case in a fresh Agent SDK query with a minimal allowlisted environment and isolated temporary `cwd`/`CLAUDE_CONFIG_DIR`, and write a schema-validated JSON report to a gitignored artifact directory. A maintainer runbook will describe operator prerequisites, Bonzai path/header confirmation, execution order, evidence review, cleanup, and the decision rule. The spike will not alter `ClaudeAdapter`, `ProviderService`, orchestration contracts, UI, or production credential handling.

## Metadata

| Field            | Value                                                                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Type             | ENHANCEMENT                                                                                                                                                                                                                                |
| Complexity       | HIGH                                                                                                                                                                                                                                       |
| Systems Affected | Maintainer scripts, Claude Agent SDK integration validation, internal operations documentation, generated evidence artifacts                                                                                                               |
| Dependencies     | `@anthropic-ai/claude-agent-sdk@0.3.170` (bundles Claude Code 2.1.170), `effect@4.0.0-beta.102`, `@effect/platform-node@4.0.0-beta.102`, Node `^24.13.1`, pnpm `11.10.0`, approved Bonzai test endpoint and two disposable authorized keys |
| Estimated Tasks  | 7                                                                                                                                                                                                                                          |

---

## UX Design

This phase has no end-user product UI. Its user is the maintainer running the opt-in validation probe; generated evidence informs later product behavior.

### Before State

```text
╔══════════════════════════════════════════════════════════════════════════════╗
║                         BEFORE: ASSUMPTION-DRIVEN                            ║
╠══════════════════════════════════════════════════════════════════════════════╣
║                                                                              ║
║  Bonzai PRD ──► inspect generic SDK/runtime code ──► unresolved questions    ║
║                                                           │                  ║
║                         ┌─────────────────────────────────┴───────────────┐  ║
║                         ▼                                                 ▼  ║
║              What error reaches lastError?              Can K2 resume K1?   ║
║                         │                                                 │  ║
║                         └────────────────── UNKNOWN ──────────────────────┘  ║
║                                                                              ║
║  CURRENT_FLOW: A fake SDK query proves option mapping and generic error       ║
║  projection, but no live Bonzai behavior is exercised.                       ║
║                                                                              ║
║  PAIN_POINT: Phase 2/3 design would otherwise encode an undocumented          ║
║  assumption about authorization errors and credential-changing resume.       ║
║                                                                              ║
║  DATA_FLOW: SDK docs + code inspection → hypotheses only → PRD open questions ║
║                                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

### After State

```text
╔══════════════════════════════════════════════════════════════════════════════╗
║                         AFTER: EVIDENCE-DRIVEN                               ║
╠══════════════════════════════════════════════════════════════════════════════╣
║                                                                              ║
║  Approved Bonzai test setup                                                   ║
║       │                                                                      ║
║       ├─► missing / empty / invalid key ─► SDK messages + throw               ║
║       │                                      │                               ║
║       │                                      ▼                               ║
║       │                             redacted error-path record                ║
║       │                                                                      ║
║       └─► K1 create ─► K1 resume control ─► K2 resume experiment              ║
║                           │                      │                            ║
║                           ▼                      ▼                            ║
║                    prove harness valid       classify outcome                 ║
║                                                 │                            ║
║                                                 ▼                            ║
║  gitignored JSON evidence + reviewed runbook decision                        ║
║       │                                                                      ║
║       ├─ supported: preserve resume only for the validated rotation scope     ║
║       └─ unsupported/ambiguous: start a fresh session after key replacement   ║
║                                                                              ║
║  VALUE_ADD: Later phases implement a documented invariant rather than a guess;║
║  no raw key is written to source control, snapshots, or the report.           ║
║                                                                              ║
║  DATA_FLOW: secret env → isolated SDK process → redactor/classifier → report  ║
║  → human decision record → Phase 2/3 plan constraints                         ║
║                                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

### Interaction Changes

| Location                                       | Before                                 | After                                                                 | User Impact                                                                   |
| ---------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `vp run probe:bonzai-runtime`                  | No dedicated Bonzai validation command | Explicit, opt-in matrix runner requiring approved inputs              | Maintainers can reproduce both unknowns without modifying T3 runtime state    |
| `artifacts/bonzai-runtime-validation/`         | No structured evidence format          | Redacted JSON report plus machine-readable decision fields            | Reviewers compare runs without receiving credentials or raw environment dumps |
| `docs/operations/bonzai-runtime-validation.md` | PRD contains open questions only       | Prerequisites, run order, evidence review, cleanup, and decision rule | A second maintainer can repeat the validation consistently                    |
| Production chat/runtime                        | Generic Claude behavior only           | Unchanged by Phase 1                                                  | No end-user behavior changes during the spike                                 |

---

## Mandatory Reading

**CRITICAL: Implementation agent MUST read these files before starting any task:**

| Priority | File                                                                    | Lines                                                 | Why Read This                                                                                                    |
| -------- | ----------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| P0       | `apps/server/src/provider/Layers/ClaudeAdapter.ts`                      | 1334-1429, 1449-1710, 2548-2564, 2966-3114, 3139-3719 | Mirror the exact `query()` environment, session-ID/resume, SDK-message, stop, and error behavior being validated |
| P0       | `apps/server/src/provider/Layers/ClaudeAdapter.test.ts`                 | 48-205, 301-337, 1389-1560, 2958-3113, 3861-3961      | Mirror the fake query, option capture, error containment, resume assertions, and native-event evidence style     |
| P0       | `apps/server/src/provider/Layers/ProviderService.ts`                    | 355-485, 522-709, 835-881                             | Understand the production stop/recovery boundary and persisted-cursor use that the experiment represents         |
| P0       | `apps/server/src/provider/Layers/ProviderSessionDirectory.ts`           | 60-149                                                | Understand why stop preserves the old resume cursor                                                              |
| P0       | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`      | 375-390, 1677-1704, 1783-1825                         | Reproduce the exact `runtime.error` → activity/`lastError` mapping in report fields                              |
| P1       | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts` | 2607-2663                                             | Follow the focused assertions for user-visible runtime-error text                                                |
| P1       | `apps/server/src/provider/ProviderInstanceEnvironment.test.ts`          | all                                                   | Preserve the explicit-empty-value behavior used to clear inherited `ANTHROPIC_API_KEY`                           |
| P1       | `apps/server/scripts/t3-sqlite-state.ts`                                | 1-18, 20-115, 178-285                                 | Follow Effect CLI, tagged error, schema-encoded JSON, `import.meta.main`, and Node runtime conventions           |
| P1       | `apps/server/scripts/cursor-acp-model-mismatch-probe.ts`                | 59-76, 119-167, 288-298, 332-442                      | Existing provider-probe lifecycle, bounded waits, structured sections, and guaranteed child cleanup              |
| P1       | `scripts/release-smoke.ts`                                              | 188-205, 410-413                                      | Mirror temporary-directory creation and unconditional `finally` cleanup                                          |
| P1       | `apps/web/src/components/chat/ThreadErrorBanner.tsx`                    | all                                                   | Know exactly how `lastError` is rendered when judging whether observed copy is understandable                    |
| P2       | `docs/internals/scripts.md`                                             | 49-63                                                 | Follow maintainer documentation and command naming conventions                                                   |
| P2       | `.gitignore`                                                            | 5-18, 32-38                                           | Preserve existing secret/log/local-state exclusions and add the dedicated evidence path                          |

### External Documentation

| Source                                                                                                                                              | Section                         | Why Needed                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions#capture-the-session-id)                                                     | Capture the session ID          | Result messages carry session IDs even on SDK error results; process failures may emit no result                         |
| [Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions#resume-by-id)                                                               | Resume by ID                    | Resume requires the same local transcript and matching `cwd`; use K1→K1 as the control                                   |
| [Agent SDK agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop#handle-the-result)                                                      | Handle the result               | `error_during_execution` covers API failures; single-shot query may yield an error result and then throw                 |
| [Gateway connection guide](https://code.claude.com/docs/en/llm-gateway-connect#set-the-credential-variable)                                         | Set the credential variable     | `ANTHROPIC_AUTH_TOKEN` is the documented bearer-token variable                                                           |
| [Gateway connection guide](https://code.claude.com/docs/en/llm-gateway-connect#agent-sdk)                                                           | Agent SDK                       | TypeScript `options.env` replaces the subprocess environment; construct it intentionally                                 |
| [Gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol#api-formats)                                                                | API formats                     | `ANTHROPIC_BASE_URL` targets `/v1/messages`; verify the Bonzai base-path contract before running                         |
| [Gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol#request-headers)                                                            | Request headers                 | Credential and `x-claude-code-session-id` semantics; the latter is correlation, not authorization                        |
| [Claude API errors](https://platform.claude.com/docs/en/api/errors#http-errors)                                                                     | HTTP errors                     | Use direct-Anthropic 401/403 only as a baseline, not a Bonzai guarantee                                                  |
| [SDK 0.3.170 declaration](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.170/sdk.d.ts)                                                        | `Options`, `SDKResultError`     | Exact locked declarations for `env`, `sessionId`, `resume`, and error result fields                                      |
| [SDK 0.3.170 changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/dbe0c96f78033ccc8d569bf5ebd93c1dc6d68681/CHANGELOG.md#L3-L6) | 0.3.170                         | Confirms no release guarantee for credential-changing resume                                                             |
| [Bonzai OpenAPI](https://api-v2.bonzai.iodigital.com/openapi.json)                                                                                  | `/v1/messages`, security scheme | Confirm deployed path/header behavior with Bonzai operators; public contract may differ from generic gateway assumptions |

**Research conclusion:** No Anthropic or public Bonzai documentation guarantees that a persisted Claude session can be resumed under a changed gateway credential. Treat that behavior as unsupported until E6 proves it for the approved credential-rotation scope.

---

## Patterns to Mirror

### NAMING_CONVENTION

```ts
// SOURCE: apps/server/scripts/t3-sqlite-state.ts:178-181
// COPY THIS PATTERN: exported Effect.fn operation named for its domain.
export const runSqliteState = Effect.fn("runSqliteState")(function* (
  input: RunSqliteStateInput,
  options: RunSqliteStateOptions = {},
) {
```

Use domain names such as `BonzaiRuntimeExperiment`, `BonzaiRuntimeObservation`, `runBonzaiRuntimeValidation`, and `bonzaiRuntimeValidationCommand`. Do not use the underlying middleware product name in report titles, operator output, or docs.

### ERROR_HANDLING

```ts
// SOURCE: apps/server/src/provider/Layers/ClaudeAdapter.test.ts:329-332
// COPY THIS PATTERN: retain causes internally while ensuring public messages omit credential text.
assert.instanceOf(error, ProviderAdapterProcessError);
assert.equal(error.detail, "Failed to start Claude runtime session.");
assert.strictEqual(error.cause, cause);
assert.notMatch(error.message, /credential material/u);
```

The probe's caught exception record may retain only `name` and a redacted `message`; never serialize a raw cause, stack, command line, header, full environment, or token.

### LOGGING_PATTERN

```ts
// SOURCE: apps/server/src/provider/Layers/ClaudeAdapter.ts:2548-2564
// COPY THIS PATTERN: distinguish terminal result messages from stream exceptions.
const status = turnStatusFromResult(message);
const errorMessage = message.subtype === "success" ? undefined : message.errors[0];

if (status === "failed") {
  yield * emitRuntimeError(context, errorMessage ?? "Claude turn failed.");
}
```

Capture ordered message summaries and the terminal result separately from a caught exception. Do not flatten them into one string before classification.

### CLI_AND_JSON_PATTERN

```ts
// SOURCE: apps/server/scripts/t3-sqlite-state.ts:249-285
// COPY THIS PATTERN: Effect CLI + schema-encoded JSON + guarded main entry.
export const t3SqliteStateCommand = Command.make(
  "t3-sqlite-state",
  {
    operation: Argument.choice("operation", SqliteStateOperation.literals),
    baseDir: Flag.string("base-dir"),
  },
  ({ operation, baseDir }) =>
    runSqliteState({ operation, baseDir }).pipe(
      Effect.flatMap(encodeSqliteStateResult),
      Effect.flatMap(Console.log),
    ),
);

if (import.meta.main) {
  Command.run(t3SqliteStateCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
```

### TEMPORARY_STATE_PATTERN

```ts
// SOURCE: scripts/release-smoke.ts:188-190,410-413
// COPY THIS PATTERN: dedicated temporary root with unconditional cleanup.
const tempRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-release-smoke-"));

try {
  // checks
} finally {
  NodeFS.rmSync(tempRoot, { recursive: true, force: true });
}
```

The validation probe must never point `CLAUDE_CONFIG_DIR` at the developer's normal Claude home or T3 home.

### ENVIRONMENT_ISOLATION_PATTERN

```ts
// SOURCE: apps/server/src/provider/ProviderInstanceEnvironment.test.ts:8-19
// COPY THIS SEMANTIC: inherited credentials are explicitly overridden, including with an empty value.
mergeProviderInstanceEnvironment(
  [
    { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
    { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
  ],
  { ANTHROPIC_API_KEY: "inherited", PATH: "/bin" },
);
```

For the live probe, construct a minimal child environment from an allowlist needed to execute Claude (`PATH`, `HOME` only if the approved isolated account requires it, temp/config variables, locale/TLS/proxy variables when explicitly approved), then set or omit the Anthropic variables per experiment. Never spread the full parent environment into the evidence record.

### RESUME_PATTERN

```ts
// SOURCE: apps/server/src/provider/Layers/ClaudeAdapter.test.ts:2983-2986
// COPY THIS ASSERTION: an existing durable ID maps only to SDK resume.
const createInput = harness.getLastCreateQueryInput();
assert.equal(createInput?.options.resume, "550e8400-e29b-41d4-a716-446655440000");
assert.equal(createInput?.options.sessionId, undefined);
assert.equal(createInput?.options.resumeSessionAt, undefined);
```

The live E5/E6 runs must use the exact E4 session ID, `cwd`, and `CLAUDE_CONFIG_DIR`; otherwise the result cannot answer the credential question.

### TEST_STRUCTURE

```ts
// SOURCE: apps/server/src/provider/ProviderInstanceEnvironment.test.ts:5-20
// COPY THIS PATTERN: focused describe/it cases with `vite-plus/test`.
describe("mergeProviderInstanceEnvironment", () => {
  it("overrides inherited environment values and preserves empty strings", () => {
    expect(/* ... */).toMatchObject(/* ... */);
  });
});
```

Keep live calls out of the unit suite. Unit tests cover schema validation, redaction, classification, environment presence maps, and report encoding using synthetic SDK messages/errors.

---

## Discovery Table

| Category     | File:Lines                                                                   | Pattern Description                                                 | Actual Snippet / Contract                                       |
| ------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------- |
| NAMING       | `apps/server/scripts/t3-sqlite-state.ts:178-181`                             | Exported domain runner uses `Effect.fn`                             | `export const runSqliteState = Effect.fn("runSqliteState")`     |
| CLI          | `apps/server/scripts/t3-sqlite-state.ts:249-285`                             | Effect CLI and guarded main                                         | `Command.make(...)`; `if (import.meta.main)`                    |
| SDK SEAM     | `apps/server/src/provider/Layers/ClaudeAdapter.ts:216-225,1360-1369`         | Injectable `createQuery` exactly matches SDK query input            | `readonly createQuery?: (input) => ClaudeQueryRuntime`          |
| ENV          | `apps/server/src/provider/Layers/ClaudeAdapter.ts:3524-3547`                 | SDK query receives the resolved environment                         | `env: claudeEnvironment`                                        |
| RESUME       | `apps/server/src/provider/Layers/ClaudeAdapter.ts:3170-3175`                 | Existing cursor chooses `resume`; fresh start generates `sessionId` | `const sessionId = existingResumeSessionId ?? newSessionId`     |
| STOP         | `apps/server/src/provider/Layers/ClaudeAdapter.ts:3029-3114`                 | Stop closes query and removes in-memory session                     | `context.query.close()` followed by session deletion            |
| ERROR        | `apps/server/src/provider/Layers/ClaudeAdapter.ts:2548-2564`                 | Failed SDK result forwards first error                              | `message.errors[0]` → `emitRuntimeError`                        |
| STREAM ERROR | `apps/server/src/provider/Layers/ClaudeAdapter.ts:2966-3027`                 | Async iterable failure becomes generic process error                | `detail: "Claude runtime stream failed."`                       |
| PROJECTION   | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:1677-1704` | Runtime message becomes persisted `lastError`                       | `lastError: runtimeErrorMessage`                                |
| UI           | `apps/web/src/components/chat/ThreadErrorBanner.tsx:20-24`                   | Full error appears in tooltip; trigger clamps three lines           | `{error}` in trigger and popup                                  |
| REDACTION    | `apps/server/src/serverSettings.ts:86-98`                                    | Sensitive settings values become blank/redacted                     | `value: ""`, `valueRedacted: true`                              |
| TEMP STATE   | `scripts/release-smoke.ts:188-190,410-413`                                   | OS temp root and unconditional removal                              | `mkdtempSync(...)`; `rmSync(..., force: true)`                  |
| TESTS        | `apps/server/src/provider/Layers/ClaudeAdapter.test.ts:2958-3113`            | Fake SDK proves resume/session-ID option mapping                    | `options.resume` vs `options.sessionId` assertions              |
| INTEGRATION  | `apps/server/integration/orchestrationEngine.integration.test.ts:996-1125`   | Stop/recovery test waits on persisted state and restart             | `adapter.stopAll()` then second `startTurn`                     |
| DEPENDENCY   | `apps/server/package.json:17-35`                                             | Locked server runtime/test surface                                  | SDK `^0.3.170`; `test: vp test run`; `typecheck: tsgo --noEmit` |

---

## Architecture and Decision Record

### Current Data Flow

```text
Provider instance env
  → ClaudeDriver.mergeProviderInstanceEnvironment
  → makeClaudeAdapter (environment fixed at adapter construction)
  → Agent SDK query({ options.env, sessionId | resume })
  → SDK messages / result / async-stream exception
  → ClaudeAdapter canonical runtime events
  → ProviderService PubSub + canonical log
  → ProviderRuntimeIngestion
  → thread session lastError + runtime.error activity
  → WebSocket projection
  → ThreadErrorBanner
```

### Spike Data Flow

```text
Operator-approved secret injection (K1/K2 names only in CLI)
  → validate required secret presence without reading it into argv/output
  → construct isolated cwd + CLAUDE_CONFIG_DIR + child env
  → run exact SDK 0.3.170 query in a fresh process/query per experiment
  → summarize ordered messages/result/throw/exit
  → redact credential-like material and absolute paths
  → derive T3-facing error text using existing adapter rules
  → validate/encode report schema
  → write report under gitignored artifacts/bonzai-runtime-validation/
  → human review + supported/unsupported/ambiguous decision
```

### APPROACH_CHOSEN

Create a standalone `apps/server/scripts/bonzai-runtime-validation.ts` with an Effect CLI and exportable pure helpers, plus `bonzai-runtime-validation.test.ts`. The runner uses the installed SDK directly rather than routing through a running T3 server because Phase 1 asks about external SDK/gateway behavior and must not prematurely implement Phase 2/3 project-key plumbing. It still records the T3-equivalent error projection so the observed result can answer whether existing UI is sufficient.

The experiment matrix is fixed:

| ID  | Credential State                                    | Action                                                            | Purpose                                                                   |
| --- | --------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------- |
| E0  | No gateway credential in an isolated config context | Start minimal SDK query                                           | Detect cached login/config contamination before interpreting auth results |
| E1  | `ANTHROPIC_AUTH_TOKEN` absent; API key absent       | One fixed no-tool prompt                                          | Missing-token SDK result/throw shape                                      |
| E2  | Token empty; API key explicitly empty               | Same prompt                                                       | Empty-versus-absent and inherited-key clearing behavior                   |
| E3  | Synthetic invalid token; API key absent/empty       | Same prompt                                                       | Invalid-token gateway and SDK error shape                                 |
| E4  | Authorized K1                                       | Create one short session containing a random/nonsecret run marker | Verify path/header configuration and obtain durable session ID            |
| E5  | Same K1                                             | New query/process resumes E4 with unchanged cwd/config            | Control proving transcript lookup and resume work                         |
| E6  | Authorized K2 from the approved rotation scope      | New query/process resumes E4 with unchanged cwd/config            | Required replacement-key result                                           |
| E7  | K2 from a different synthetic tenant                | Optional, separately approved only                                | Cross-tenant isolation evidence; not part of baseline completion          |

### RATIONALE

- `apps/server/scripts/cursor-acp-model-mismatch-probe.ts` establishes app-local provider probes; `t3-sqlite-state.ts` establishes testable Effect CLIs and schema-encoded JSON.
- `ClaudeAdapter.test.ts` proves fake-query behavior but cannot answer gateway questions.
- Direct SDK use avoids adding temporary production contracts or runtime branches that would be removed after the spike.
- E5 prevents false conclusions caused by wrong `cwd`, missing transcripts, or isolated config mistakes.
- Structured, redacted evidence is needed because SDK result errors, stream exceptions, and gateway responses can diverge and because the current T3 adapter intentionally hides raw exception causes.

### DECISION_RULE

Classify E6 as:

- `supported` only when E4 succeeds, E5 proves same-key resume, E6 uses an approved replacement key for the same intended credential context, E6 returns the same durable session ID or documented equivalent, and the response demonstrably incorporates the nonsecret E4 marker without exposing unauthorized context.
- `unsupported` when E5 succeeds but E6 produces a clear authorization/permission rejection, fails to resume the marker, or starts a fresh unrelated session.
- `ambiguous` when E4/E5 controls fail, the result is only a generic process/transport error, the base path/header contract is unresolved, or gateway logs cannot prove which credential context handled the request.
- `security-review-required` when a differently scoped K2 can access E4 history or any evidence suggests cross-tenant transcript exposure.

For Phase 3 planning, `unsupported`, `ambiguous`, or `security-review-required` all choose the safe fallback: stop the old query, retain T3 conversation history, and start a fresh Agent SDK session under the new key. Do not automatically replay the old SDK transcript or create a summary mechanism in v1; that would exceed the PRD scope. A `supported` result permits preserving the resume cursor only for the exact validated same-context key-replacement semantics documented in the report.

### ALTERNATIVES_REJECTED

- **Use only `FakeClaudeQuery` unit tests**: rejected because mocks cannot establish Bonzai's deployed error envelope, header/path behavior, or credential-changing authorization policy.
- **Drive the complete T3 UI/server flow during Phase 1**: rejected because project-scoped key storage and session-aware environment construction do not exist until later phases; building them now would invert dependencies.
- **Run ad hoc `curl` and `claude` commands manually**: rejected because shell history, inconsistent environment/login state, unstructured evidence, and missing SDK message ordering would make the result unsafe and non-reproducible.
- **Commit raw native NDJSON logs as evidence**: rejected because `ClaudeAdapter` logs complete SDK message payloads and has no provider-payload redaction transform.
- **Assume local transcripts make key changes irrelevant**: rejected because local persistence does not document gateway authorization, request attribution, or cross-credential context policy.
- **Automatically summarize old history into a new session**: rejected for v1 because it adds unrequested context reconstruction and potential data transfer across credential contexts.

### FAILURE_MODES AND MITIGATIONS

| Failure Mode                                                            | Detection                                                               | Mitigation                                                                                                                                            |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wrong Bonzai base path or accepted auth header                          | E3/E4 fail before a valid turn; operator contract disagrees with report | Require operator confirmation and record redacted base-path label before interpreting resume behavior                                                 |
| Cached Claude login masks missing token                                 | E0/E1 unexpectedly succeed or init reports another auth source          | Run in dedicated test account/VM where possible; isolated config; fail closed on unexpected auth source                                               |
| TypeScript `options.env` drops required process variables               | Child fails before SDK init                                             | Build an explicit allowlist including only required execution/TLS/proxy variables; unit-test presence map, never values                               |
| Inherited Anthropic key changes E1/E2                                   | Environment presence map shows forbidden credential source              | Explicitly omit `ANTHROPIC_AUTH_TOKEN` and omit/empty `ANTHROPIC_API_KEY` per case; never spread all of `process.env` blindly                         |
| Resume appears fresh due to wrong path                                  | E5 does not reproduce E4 marker                                         | Require identical absolute `cwd`, `CLAUDE_CONFIG_DIR`, and transcript existence; mark E6 not-run/ambiguous until E5 passes                            |
| Token leaks through exception, SDK message, native log, output, or path | Redaction sentinel test fails; report contains forbidden fixture tokens | Redact before serialization; do not enable raw native logging; scan encoded report for injected test sentinels and abort write on match               |
| Probe hangs/retries indefinitely                                        | Deadline exceeded                                                       | Bound each query, max turns, and total case duration; close query in `finally`; mark timeout distinctly                                               |
| K2 belongs to different client/tenant                                   | Operator cannot attest scope                                            | Do not run E6 until scope is recorded; E7 requires separate written authorization and synthetic data only                                             |
| Gateway accepts cross-tenant resume                                     | E7 returns E4 marker                                                    | Stop testing, classify `security-review-required`, restrict evidence, notify gateway owner; do not treat as product support                           |
| Error text contains internal middleware branding                        | Report's T3-facing message contains forbidden product term              | Record a boolean/hashed classification and restricted raw redacted evidence; flag Phase 3/UX mapping requirement without exposing it in end-user docs |

### SECURITY AND PRIVACY BOUNDARIES

- Use disposable Bonzai test keys only; never production user/client credentials.
- Credentials enter through pre-approved environment variables or a secret helper, never CLI arguments, files, prompts, screenshots, or report fields.
- Do not print the effective environment, headers, raw subprocess command, full transcript, or raw gateway logs.
- Use a fixed benign prompt and a nonsecret synthetic marker; disable tools with `tools: []` or the exact SDK equivalent and cap turns/budget.
- Run each matrix row as a fresh query/process context so an old process cannot retain a credential.
- Keep E4–E6 in one isolated temp root with the same cwd/config; remove it in `finally` after the report is safely encoded and reviewed.
- On macOS, prefer a dedicated OS account or controlled VM because `CLAUDE_CONFIG_DIR` does not by itself prove Keychain isolation.
- Preserve only credential labels (`none`, `empty`, `invalid-synthetic`, `K1`, `K2`) and an operator-approved nonsecret scope label.

---

## Files to Change

| File                                                    | Action                 | Justification                                                                                                                                    |
| ------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/server/scripts/bonzai-runtime-validation.ts`      | CREATE                 | Opt-in, testable live SDK matrix runner with schema, redaction, classification, cleanup, and JSON output                                         |
| `apps/server/scripts/bonzai-runtime-validation.test.ts` | CREATE                 | Focused synthetic tests for CLI validation, environment construction, redaction, result/throw classification, decision rule, and report encoding |
| `apps/server/package.json`                              | UPDATE                 | Add explicit `probe:bonzai-runtime` command without including it in normal test/build execution                                                  |
| `.gitignore`                                            | UPDATE                 | Ignore generated `artifacts/bonzai-runtime-validation/` reports                                                                                  |
| `docs/operations/bonzai-runtime-validation.md`          | CREATE                 | Maintainer runbook for approvals, key injection, matrix execution, evidence review, cleanup, and decision recording                              |
| `.claude/PRPs/prds/bonzai-project-keys.prd.md`          | UPDATE AFTER EXECUTION | Record actual evidence and selected fallback, close relevant open questions, and mark Phase 1 complete only after a reviewed run                 |

No production runtime, contract, projection, web, mobile, or desktop source file changes in Phase 1.

---

## NOT Building (Scope Limits)

- Project-scoped Bonzai Key persistence, replacement APIs, or redacted project state; Phase 2 owns these.
- Project-aware Claude environment construction or process restart wiring; Phase 3 owns these.
- Claude-only server enforcement, provider UI changes, or project setup/settings UI; Phases 4–6 own these.
- A permanent runtime dependency on the probe or any automatic live/network test in CI.
- Bonzai Key validity pre-check during project creation.
- General LiteLLM administration, model discovery, key creation, rotation, revocation, or tenant introspection.
- Cross-tenant E7 execution without explicit gateway-owner authorization.
- Raw evidence committed to git, credentials written to disk, or secrets logged.
- Automatic old-transcript summary/replay after key replacement.

---

## Step-by-Step Tasks

Execute in order. Each task is atomic and independently verifiable.

### Task 1: CREATE `apps/server/scripts/bonzai-runtime-validation.ts` — schemas and redaction core

- **ACTION**: Define schema-first input/output contracts and pure normalization/redaction helpers before adding live SDK execution.
- **IMPLEMENT**:
  - Experiment IDs `E0`–`E7`, credential labels, result classifications, and decision values (`supported`, `unsupported`, `ambiguous`, `security-review-required`).
  - Structured report fields: exact SDK/version metadata, runtime versions, approved base URL label/origin, cwd/config consistency booleans, credential presence booleans, ordered SDK message summaries, terminal result subtype/errors after redaction, caught exception name/redacted message, process/timeout status, requested/emitted session IDs, marker-resume outcome, T3-equivalent error text, and human-review notes placeholder.
  - Redaction helpers for known credential values/sentinels, bearer/API-key patterns, absolute temp/home paths, and authorization-like fields. Replace with stable labels such as `[REDACTED_CREDENTIAL]`; do not hash raw keys.
  - A final leak guard that scans the fully encoded report for every supplied secret sentinel and refuses to write when any remains.
  - Report schema encoder using the repository's `fromJsonStringPretty`/Effect Schema pattern.
- **MIRROR**: `apps/server/scripts/t3-sqlite-state.ts:20-115,249-285` for schemas, tagged errors, pretty JSON, and testable CLI exports.
- **IMPORTS**: Prefer namespace imports matching surrounding Effect code: `effect/Effect`, `effect/Schema`, `effect/Console`, `@effect/platform-node/NodeServices`, `@effect/platform-node/NodeRuntime`, and `@t3tools/shared/schemaJson`.
- **GOTCHA**: `SDKResultError.errors[]` and exception text can contain gateway prose; no raw unknown object reaches the encoder. Normalize known fields first.
- **VALIDATE**:
  ```bash
  vp test run apps/server/scripts/bonzai-runtime-validation.test.ts
  pnpm --filter t3 typecheck
  pnpm lint -- apps/server/scripts/bonzai-runtime-validation.ts apps/server/scripts/bonzai-runtime-validation.test.ts
  ```

### Task 2: CREATE `apps/server/scripts/bonzai-runtime-validation.test.ts` — redaction and classification tests

- **ACTION**: Build the focused unit suite before live execution.
- **IMPLEMENT**:
  - Redaction of credentials in result `errors[]`, caught errors, nested SDK-message summaries, URLs, and path labels.
  - Leak-guard failure using unique fixture sentinels for K1/K2 and invalid token.
  - Environment presence map records booleans only and excludes values.
  - Result path: `error_during_execution` with `errors[0]` produces the same T3-facing message as `ClaudeAdapter.ts:2548-2564`.
  - Stream/process path: no result + exception remains separately classified and does not invent an HTTP status.
  - Decision tests for supported, unsupported, ambiguous control failure, and cross-scope exposure.
  - Report schema round-trip/encoding.
  - No test contacts Bonzai or reads real credential variables.
- **MIRROR**: `apps/server/src/provider/Layers/ClaudeAdapter.test.ts:301-337,1389-1560,2958-3113` and `apps/server/src/provider/ProviderInstanceEnvironment.test.ts:1-21`.
- **GOTCHA**: Keep fixture token values unmistakable and assert they do not occur anywhere in `JSON.stringify(report)`.
- **VALIDATE**:
  ```bash
  vp test run apps/server/scripts/bonzai-runtime-validation.test.ts
  ```

### Task 3: UPDATE `apps/server/scripts/bonzai-runtime-validation.ts` — isolated live query runner

- **ACTION**: Add an opt-in Agent SDK executor around the tested core.
- **IMPLEMENT**:
  - Import `query` and relevant SDK types from the exact installed `@anthropic-ai/claude-agent-sdk`.
  - Require an explicit confirmation flag such as `--ack-live-gateway-test`; default invocation prints help/refuses network use.
  - Require `--base-url`, `--output`, and an operator-approved nonsecret `--credential-scope` label. Read K1/K2 only from documented environment variable names; never accept token-valued CLI flags.
  - Create a dedicated temp root with private permissions, a synthetic empty cwd, and isolated `CLAUDE_CONFIG_DIR`; keep E4–E6 paths identical.
  - Construct each case's child env from a documented allowlist. Explicitly set/omit `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_API_KEY` according to E0–E6. Include `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` to reduce unrelated egress unless Bonzai validation requires otherwise.
  - Fixed prompt, no project settings (`settingSources: []`), no tools, one/few turn cap, low budget/deadline, and no MCP servers.
  - Consume the SDK stream to completion; record ordered message type/subtype/session ID summaries, terminal result, and any subsequent throw. Do not break immediately on `result`, because trailing messages may exist.
  - Always close/interrupt active query and remove temp state in `finally`; never touch `~/.t3/userdata` or the user's normal Claude config.
- **MIRROR**: `apps/server/scripts/cursor-acp-model-mismatch-probe.ts:119-167,288-298,332-442` for bounded process lifecycle and cleanup; `scripts/release-smoke.ts:188-190,410-413` for temp root removal.
- **GOTCHA**: Official SDK docs say TypeScript `options.env` replaces the child environment. Missing `PATH`/TLS/proxy variables can look like an auth failure; the report must distinguish pre-init/process failures.
- **VALIDATE**:
  ```bash
  vp test run apps/server/scripts/bonzai-runtime-validation.test.ts
  pnpm --filter t3 typecheck
  pnpm lint -- apps/server/scripts/bonzai-runtime-validation.ts
  node apps/server/scripts/bonzai-runtime-validation.ts --help
  ```
  **EXPECT**: `--help` performs no network call and exits 0; invocation without the acknowledgement flag fails before reading credentials or creating a query.

### Task 4: UPDATE `apps/server/scripts/bonzai-runtime-validation.ts` — fixed experiment orchestration and report decision

- **ACTION**: Implement E0–E6 dependency ordering and decision derivation.
- **IMPLEMENT**:
  - Run E0–E3 independently with the exact same fixed prompt and fresh query context.
  - Run E4 with K1 and store the returned durable session ID plus a nonsecret marker.
  - Run E5 only after E4 succeeds; resume with K1 using identical `cwd`/config and verify the response demonstrates prior marker context.
  - Run E6 only after E5 succeeds; resume the exact E4 ID with K2 and classify using the decision rule.
  - Skip dependent cases with an explicit reason rather than treating them as failures.
  - E7 is excluded by default and requires a separate flag plus a second explicit acknowledgement/approval reference.
  - Derive `t3Projection` fields for each auth failure: result-message path uses redacted `errors[0]` or `Claude turn failed.`; process/stream path uses `Claude runtime stream failed.`; include whether `ThreadErrorBanner` copy is actionable according to reviewed notes, not an automated prose guess.
  - Write only after schema validation and leak scan; use restrictive file permissions.
- **MIRROR**: `apps/server/src/provider/Layers/ClaudeAdapter.ts:2548-2564,2966-3027` for T3 error-path equivalence and `apps/server/src/provider/Layers/ClaudeAdapter.test.ts:2958-3113` for resume/session-ID invariants.
- **GOTCHA**: A successful HTTP response alone does not prove resume. E5/E6 must verify that the synthetic E4 marker is present in the resumed context and record requested versus emitted session IDs.
- **VALIDATE**:
  ```bash
  vp test run apps/server/scripts/bonzai-runtime-validation.test.ts
  pnpm --filter t3 typecheck
  pnpm lint -- apps/server/scripts/bonzai-runtime-validation.ts apps/server/scripts/bonzai-runtime-validation.test.ts
  ```

### Task 5: UPDATE command exposure and artifact exclusion

- **ACTION**: Make the probe discoverable but opt-in, and ensure evidence cannot be committed accidentally.
- **IMPLEMENT**:
  - Add `"probe:bonzai-runtime": "node scripts/bonzai-runtime-validation.ts"` to `apps/server/package.json`.
  - Add `artifacts/bonzai-runtime-validation/` to `.gitignore`.
  - The runner creates the requested output directory with private permissions; no sample containing real observations is committed.
- **MIRROR**: `apps/server/package.json:17-23` for package-local scripts and `.gitignore:32` for generated artifact exclusions.
- **GOTCHA**: Do not add the live probe to `test`, `build`, `prepare`, or CI; it must never contact Bonzai implicitly.
- **VALIDATE**:
  ```bash
  pnpm --filter t3 run probe:bonzai-runtime -- --help
  git check-ignore artifacts/bonzai-runtime-validation/example.json
  pnpm --filter t3 typecheck
  ```

### Task 6: CREATE `docs/operations/bonzai-runtime-validation.md`

- **ACTION**: Document the operator workflow and review checklist.
- **IMPLEMENT**:
  - Purpose and explicit non-production status.
  - Required written authorization for endpoint/keys; K1/K2 must be disposable, synthetic, and within the approved replacement scope.
  - Confirm the exact Bonzai Anthropic base path and accepted bearer header with operators before executing; public OpenAPI is not sufficient proof.
  - Dedicated OS account/VM recommendation on macOS due to Keychain state; verify no saved login contaminates E0/E1.
  - Secret injection mechanism using placeholder variable names only. Never show literal-token command examples.
  - Exact E0–E6 sequence, expected control gates, output location, redaction review, and cleanup.
  - How to compare raw restricted operator/gateway evidence to the generated redacted report without copying headers or prompt bodies.
  - Decision rule and PRD update fields.
  - Troubleshooting matrix for base path/header mismatch, no init/result, wrong cwd, missing transcript, generic stream failure, and timeout.
- **MIRROR**: `docs/internals/scripts.md:49-63` for maintainer command documentation; place operational procedure under `docs/operations/` per `AGENTS.md:75`.
- **GOTCHA**: End-user-facing text must say Bonzai only. If an upstream response reveals implementation branding, keep it out of broadly shared artifacts and flag it as a terminology risk.
- **VALIDATE**:
  ```bash
  pnpm fmt --check -- docs/operations/bonzai-runtime-validation.md
  ```
  If `vp fmt` does not accept a path in this checkout, run the repository formatter's documented targeted equivalent; do not run `vp check`.

### Task 7: RUN the approved spike and UPDATE the PRD decision record

- **ACTION**: Execute E0–E6 only after the code review and credentials/endpoint authorization are available; then record conclusions in the PRD.
- **IMPLEMENT**:
  - Capture actual `node --version`, pnpm version, package lock integrity/version, OS/architecture, gateway origin/base-path label, and operator approval reference.
  - Execute from a clean approved environment using the runbook. Do not record secret-bearing shell commands in the PRD.
  - Review the generated report for leakage before sharing it.
  - Record the exact result/throw path for missing, empty, and invalid credentials; state what `ThreadErrorBanner` would display and whether dedicated mapping is required later.
  - Record E4/E5 controls and E6 classification.
  - Update PRD open questions at lines 48-52, technical risks/mitigations as needed, Decisions Log with the selected resume fallback/error UX, Research Summary, and Phase 1 status to `complete` only after evidence review.
  - If execution is blocked by unavailable test keys or uncertain Bonzai contract, leave Phase 1 `in-progress` and record the blocker; do not invent results.
- **MIRROR**: `.claude/PRPs/prds/bonzai-project-keys.prd.md:46-52,147-160,164-188,226-264`.
- **GOTCHA**: A cross-tenant success is a security finding, not support for resume. Restrict evidence and escalate to the Bonzai owner.
- **VALIDATE**:

  ```bash
  # Pre-flight focused validation
  vp test run apps/server/scripts/bonzai-runtime-validation.test.ts
  pnpm --filter t3 typecheck
  pnpm lint -- apps/server/scripts/bonzai-runtime-validation.ts apps/server/scripts/bonzai-runtime-validation.test.ts

  # Live command template; key values are injected out-of-band per the runbook.
  pnpm --filter t3 run probe:bonzai-runtime -- \
    --ack-live-gateway-test \
    --base-url '<approved-bonzai-anthropic-base-url>' \
    --credential-scope '<approved-nonsecret-scope-label>' \
    --output 'artifacts/bonzai-runtime-validation/<run-id>.json'

  # Confirm generated evidence remains ignored.
  git check-ignore 'artifacts/bonzai-runtime-validation/<run-id>.json'
  ```

  **EXPECT**: E4 and E5 succeed before E6 is interpreted; report contains no secret values; one explicit decision classification is recorded.

---

## Testing Strategy

### Unit Tests to Write

| Test File                                               | Test Cases                                                                       | Validates                                                    |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `apps/server/scripts/bonzai-runtime-validation.test.ts` | schema acceptance/rejection, CLI acknowledgement gate, no credential-valued args | Safe invocation contract                                     |
| same                                                    | allowlisted child env for absent/empty/invalid/K1/K2 cases                       | No inherited credential fallback and exact case construction |
| same                                                    | nested result/exception/path redaction and final sentinel scan                   | Evidence contains no keys or sensitive machine paths         |
| same                                                    | result error versus no-result stream/process exception                           | Exact SDK observation classification                         |
| same                                                    | T3-equivalent `lastError` mapping                                                | Existing UI-path conclusion uses production semantics        |
| same                                                    | E4/E5/E6 dependency skipping and four decision classes                           | Resume decision cannot be inferred from failed controls      |
| same                                                    | report pretty-JSON schema round trip                                             | Stable machine-readable evidence                             |

### Existing Focused Regression Tests

| Test File                                                               | Why Run                                                                                                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/provider/Layers/ClaudeAdapter.test.ts`                 | Confirms the production assumptions referenced by the probe still hold: query options, result errors, stream errors, stop, resume IDs |
| `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts` | Confirms `runtime.error` still projects into `lastError` and activity text                                                            |
| `apps/server/src/provider/ProviderInstanceEnvironment.test.ts`          | Confirms empty inherited credential override semantics                                                                                |

### Edge Cases Checklist

- [ ] Missing `ANTHROPIC_AUTH_TOKEN`
- [ ] Empty `ANTHROPIC_AUTH_TOKEN`
- [ ] Synthetic invalid token
- [ ] Inherited `ANTHROPIC_API_KEY` present in the parent but omitted/emptied in child case
- [ ] Unexpected saved Claude login or Keychain credential
- [ ] Wrong Bonzai base path or unsupported auth header
- [ ] SDK throws before any message
- [ ] SDK yields `error_during_execution`, then throws
- [ ] SDK stream ends/throws without a result
- [ ] Error result contains no `errors[0]`
- [ ] Result includes a session ID on failure
- [ ] Same-key resume control returns fresh context rather than E4 marker
- [ ] Replacement-key resume returns a different session ID
- [ ] K2 is not in the approved credential scope
- [ ] Query timeout and cleanup
- [ ] Report output path exists or write fails
- [ ] Redaction catches credentials embedded in nested text/URLs
- [ ] Absolute temp/home path redaction
- [ ] Forbidden implementation branding appears in upstream error prose
- [ ] Optional cross-tenant test unexpectedly exposes E4 marker

---

## Validation Commands

Repository rule: use focused checks only. `AGENTS.md:104-110` explicitly prohibits repo-wide test/typecheck/check commands unless requested.

### Level 1: STATIC_ANALYSIS

```bash
pnpm --filter t3 typecheck
pnpm lint -- \
  apps/server/scripts/bonzai-runtime-validation.ts \
  apps/server/scripts/bonzai-runtime-validation.test.ts
pnpm fmt --check -- \
  apps/server/scripts/bonzai-runtime-validation.ts \
  apps/server/scripts/bonzai-runtime-validation.test.ts \
  docs/operations/bonzai-runtime-validation.md
```

**EXPECT**: Exit 0. If targeted formatter argument forwarding differs, use the equivalent Vite+ targeted command; do not run repo-wide `vp check`.

### Level 2: UNIT_TESTS

```bash
vp test run apps/server/scripts/bonzai-runtime-validation.test.ts
```

**EXPECT**: All synthetic tests pass; no network is contacted.

### Level 3: FOCUSED_REGRESSION_SUITE

```bash
vp test run \
  apps/server/src/provider/Layers/ClaudeAdapter.test.ts \
  apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts \
  apps/server/src/provider/ProviderInstanceEnvironment.test.ts \
  apps/server/scripts/bonzai-runtime-validation.test.ts
```

**EXPECT**: All focused tests pass. Do not run `pnpm test`, `pnpm typecheck`, or `vp check` across the monorepo.

### Level 4: LIVE_GATEWAY_VALIDATION

Preconditions:

- [ ] Written authorization covers Bonzai endpoint, K1, K2, synthetic prompts, and gateway-log inspection.
- [ ] Bonzai operator confirms exact Anthropic base path and accepted credential header.
- [ ] K1/K2 are disposable test credentials and their nonsecret scope relationship is recorded.
- [ ] Dedicated OS account/VM or equivalent credential isolation is in place.
- [ ] The live command has been reviewed to ensure credentials are not in argv.

Run the Task 7 command template.

**EXPECT**:

- E1–E3 record an SDK termination shape and T3-equivalent error text.
- E4 creates a session with a durable ID and benign marker.
- E5 proves same-key resume using the marker.
- E6 produces one reviewable classification.
- No report value equals or contains K1/K2/invalid-token sentinels.

### Level 5: UI-PATH VALIDATION

No browser automation is required or allowed by default for this phase. Validate the existing UI path from code and focused ingestion tests:

```bash
vp test run apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts
```

Manual review:

- [ ] Compare each observed SDK/T3-equivalent error string with `ThreadErrorBanner`'s three-line trigger and full tooltip behavior.
- [ ] Decide whether generic provider-error UI is understandable.
- [ ] If upstream prose exposes forbidden implementation terminology, add a later-phase mapping requirement; do not expose it in user docs.

### Level 6: MANUAL EVIDENCE REVIEW

1. Confirm the JSON report's version metadata and approved origin/scope labels.
2. Verify the report records environment **presence**, never values.
3. Search the report for the test sentinel values through the probe's leak guard and an independent reviewer check.
4. Confirm E4–E6 used identical cwd/config labels and the exact requested session ID.
5. Confirm E5 marker continuity before interpreting E6.
6. Check the decision classification against the documented rule.
7. Confirm the generated report is gitignored and temp transcript/config state was removed.
8. Update the PRD only with redacted conclusions and references to restricted evidence, not raw transcripts or credentials.

---

## Acceptance Criteria

- [ ] An explicit package command runs the live probe only with an acknowledgement flag and never during normal tests/builds.
- [ ] Credentials are accepted only out-of-band through approved environment/secret injection, never through CLI values or repository files.
- [ ] E0–E6 are represented in a fixed, dependency-aware experiment matrix; E7 is separately gated.
- [ ] Every query uses SDK `0.3.170`, a fixed benign prompt, no tools, bounded execution, and isolated state.
- [ ] The report separately records SDK messages, result fields, caught exceptions, and T3-equivalent projected text.
- [ ] Redaction/leak-guard unit tests prove fixture credentials cannot survive report encoding.
- [ ] Same-key E5 control must pass before E6 can yield supported/unsupported; otherwise the result is ambiguous.
- [ ] E6 produces one explicit classification with reviewer rationale.
- [ ] Unsupported/ambiguous/security-review-required selects fresh-session fallback for later phases; supported is limited to the exact validated scope.
- [ ] Existing Claude adapter, runtime ingestion, and environment tests remain green.
- [ ] No production runtime or end-user behavior changes in Phase 1.
- [ ] The PRD remains `in-progress` until a reviewed live run exists, then records conclusions and marks Phase 1 complete.

---

## Completion Checklist

- [ ] Tasks 1–6 completed in dependency order
- [ ] New unit suite passes
- [ ] Focused Claude/runtime regression tests pass
- [ ] Server package typecheck and targeted lint pass
- [ ] Help/refusal paths prove no implicit network access
- [ ] Evidence artifact path is gitignored
- [ ] Live run authorization and operator contract are recorded
- [ ] E4/E5 controls pass
- [ ] E6 classification is reviewed
- [ ] Generated report passes leak review
- [ ] Temporary Claude state is removed
- [ ] Error-display conclusion is recorded
- [ ] Resume fallback is selected in PRD Decisions Log
- [ ] Phase 1 is marked complete only after all preceding live/review steps

---

## Risks and Mitigations

| Risk                                                                    | Likelihood | Impact   | Mitigation                                                                                                                                                |
| ----------------------------------------------------------------------- | ---------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential leakage in argv, logs, report, or transcript                 | MEDIUM     | HIGH     | Secret env injection only; fixed benign prompt; normalization before serialization; sentinel leak guard; gitignored artifacts; restricted evidence review |
| Cached login invalidates missing-token test                             | MEDIUM     | HIGH     | Dedicated test account/VM, isolated config, E0 contamination check, fail closed on unexpected auth source                                                 |
| Bonzai path/header contract differs from generic Anthropic gateway docs | HIGH       | HIGH     | Require operator confirmation and E4 valid-key control before interpreting any error/resume result                                                        |
| Same-key control fails for local transcript/cwd reasons                 | MEDIUM     | HIGH     | Identical cwd/config, transcript existence checks, E5 gate; classify E6 as ambiguous/not-run                                                              |
| Generic SDK stream failure hides useful 401/403 detail                  | MEDIUM     | MEDIUM   | Record ordered messages, result, throw, stderr classification, and operator correlation ID separately; do not rely only on `errors[0]`                    |
| Cross-credential resume exposes history across scopes                   | LOW–MEDIUM | CRITICAL | E6 same-scope only; E7 separate authorization; synthetic marker; classify unexpected access as security review, never as support                          |
| Live probe becomes an accidental production feature/CI dependency       | LOW        | MEDIUM   | App-local opt-in script, acknowledgement flag, no normal lifecycle hook, no production imports from probe                                                 |
| Upstream error leaks internal middleware branding to user path          | MEDIUM     | MEDIUM   | Detect in reviewed evidence; add later product-level sanitization/mapping requirement while preserving restricted diagnostic evidence                     |
| Probe leaves local transcript or credential-bearing process alive       | LOW–MEDIUM | HIGH     | Fresh query per row, deadlines, `close()`/interrupt and recursive temp cleanup in `finally`                                                               |
| A successful E6 is overgeneralized to all users/tenants                 | MEDIUM     | HIGH     | Report exact key scope/gateway version and constrain decision to validated same-context rotation semantics                                                |

---

## Notes

- Phase 1 is a validation spike, not the project-key implementation. Its code may remain as a maintainer diagnostic, but production code must not depend on it.
- Public Bonzai OpenAPI and current Anthropic docs are useful for test design but are not a substitute for an operator-confirmed deployed contract.
- The installed SDK's `env` replacement semantics are especially important: an over-broad inherited environment can mask missing credentials, while an under-specified environment can create misleading process failures.
- T3's current result-message path forwards `errors[0]` to the session and UI, whereas async-stream failures become `Claude runtime stream failed.`. The report must say which path Bonzai actually triggers.
- Existing native provider logs serialize full SDK messages. Do not enable or commit them as general Phase 1 evidence unless a restricted reviewer first confirms they contain no sensitive material.
- Confidence before the live run is necessarily bounded by external behavior; the plan is designed so the implementation and execution phases fail closed rather than fill gaps with assumptions.
