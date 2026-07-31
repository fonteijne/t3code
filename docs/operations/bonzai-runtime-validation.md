# Bonzai runtime validation

This runbook is for an opt-in, non-production validation of Bonzai behavior through the repository-locked Claude Agent SDK. It records how missing and invalid credentials terminate, proves same-key session resume as a control, and tests resume after an approved replacement key. The probe does not change T3 Code production behavior.

## Authorization and isolation

Do not run the probe until all of these conditions are met:

- Written authorization covers the Bonzai endpoint, synthetic prompts, disposable K1 and K2 credentials, and any gateway-log inspection.
- A Bonzai operator confirms the deployed Anthropic base path and accepted bearer header. The public OpenAPI document is not sufficient confirmation.
- K1 and K2 are disposable test credentials in the same approved replacement scope. Record a nonsecret scope label and approval reference.
- The command will run in a dedicated OS account, controlled VM, or equivalent credential-isolated environment. On macOS, an isolated `CLAUDE_CONFIG_DIR` does not prove that Keychain state is absent.
- No credential value appears in command arguments, shell history, screenshots, source files, or the output path.

The optional E7 cross-scope check is not part of baseline validation. It requires separate written gateway-owner authorization, synthetic data only, `--include-cross-scope-test`, `--ack-cross-scope-test`, and a separate approval reference. A cross-scope success is a security finding, not evidence that replacement-key resume is supported.

## Confirm the Bonzai contract

Before execution, ask the Bonzai operator to confirm:

1. The exact base URL consumed by Claude Code for `/v1/messages` traffic.
2. That the disposable virtual key is accepted through the bearer credential contract used by `ANTHROPIC_AUTH_TOKEN`.
3. That K1 and K2 belong to the same approved credential-replacement context.
4. Which restricted gateway correlation evidence a reviewer may inspect without copying headers, keys, or prompt bodies into the generated report.

Use only the confirmed URL in `--base-url`. The probe records its origin and base path, never embedded credentials or query parameters.

## Inject credentials

Use the approved secret manager or ephemeral environment injection mechanism to expose these variable names to the probe process:

- `BONZAI_RUNTIME_K1`
- `BONZAI_RUNTIME_K2`
- `BONZAI_RUNTIME_CROSS_SCOPE_KEY` only for separately authorized E7

Do not place literal values in a documented command example. The probe rejects missing or identical K1/K2 values and never accepts token-valued CLI flags.

## Run the baseline matrix

Review the command before adding the acknowledgement flag. Help is safe and performs no network access:

```bash
pnpm --filter t3 run probe:bonzai-runtime -- --help
```

After approvals and secret injection are in place, run:

```bash
pnpm --filter t3 run probe:bonzai-runtime -- \
  --ack-live-gateway-test \
  --base-url '<approved-bonzai-anthropic-base-url>' \
  --credential-scope '<approved-nonsecret-scope-label>' \
  --approval-reference '<nonsecret-approval-reference>' \
  --output 'artifacts/bonzai-runtime-validation/<run-id>.json'
```

The output file must not already exist. The probe creates its directory and file with private permissions, writes only after schema validation and a secret-sentinel leak scan, then removes its isolated Claude transcript and config state.

## Experiment sequence

The baseline always runs in this order:

| ID  | Credential state                   | Purpose and gate                                                                                       |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| E0  | No credential in isolated state    | Detect an unexpected saved login or other credential source. Any success makes the decision ambiguous. |
| E1  | Token absent                       | Record the missing-token SDK result and/or stream exception.                                           |
| E2  | Token and API key explicitly empty | Confirm inherited Anthropic credentials cannot fill the gap.                                           |
| E3  | Unique synthetic invalid token     | Record the invalid-token Bonzai and SDK termination shape.                                             |
| E4  | K1                                 | Create a short session and receive a nonsecret random marker plus durable session ID.                  |
| E5  | K1                                 | Resume E4 with identical `cwd` and config state. E5 must return the same session ID and marker.        |
| E6  | K2                                 | Resume the exact E4 session only after E5 passes.                                                      |
| E7  | Separately scoped key              | Optional and separately authorized; excluded by default.                                               |

Each row uses a fresh SDK query, the same benign fixed prompt class, no tools, no settings sources, no MCP servers, one turn, a low budget, and a hard timeout. E4–E7 share one temporary `cwd` and `CLAUDE_CONFIG_DIR` so transcript lookup is controlled.

## Review generated evidence

Before sharing the report:

1. Confirm the SDK, bundled Claude Code, Node, pnpm, lockfile, OS, and architecture metadata.
2. Confirm the approved origin, base path, credential scope, and approval reference.
3. Verify environment fields contain presence booleans only, never values.
4. Independently search the report for the disposable test sentinels without pasting them into a ticket, PR, or chat.
5. Confirm ordered SDK message summaries, terminal result errors, and caught exceptions remain separate.
6. Confirm E4–E6 use `isolated-cwd`, `isolated-claude-config`, and the exact requested E4 session ID.
7. Confirm E5 proves marker continuity before interpreting E6.
8. Compare restricted gateway/operator evidence to the report by case ID and approved correlation metadata. Do not copy authorization headers, raw gateway logs, environment dumps, or full prompt bodies into the report.
9. Confirm the output is ignored by git:

   ```bash
   git check-ignore 'artifacts/bonzai-runtime-validation/<run-id>.json'
   ```

10. Confirm no `t3-bonzai-runtime-*` temporary directory remains after the command exits.

The report leaves `threadErrorBannerActionable` as `not-reviewed`. A reviewer must compare the redacted `lastError` with the existing three-line banner and full tooltip. If upstream prose exposes implementation branding, restrict that evidence and create a later product-mapping requirement; broadly shared and end-user documentation must say Bonzai only.

## Decision rule

Classify E6 as:

- `supported` only when E4 succeeds, E5 proves same-key resume, E6 uses an approved same-context replacement key, E6 emits the requested durable session ID, and E6 recovers the E4 marker.
- `unsupported` when E5 passes but E6 conclusively rejects authorization, returns a fresh session, or does not recover the marker.
- `ambiguous` when E0 detects credential contamination, E4/E5 controls fail, E6 yields only a generic process or transport failure, or the operator-confirmed path/header contract is unresolved.
- `security-review-required` when a separately scoped credential can recover E4 context or evidence suggests cross-tenant transcript exposure. Stop testing and notify the Bonzai owner.

For Phase 3, `unsupported`, `ambiguous`, and `security-review-required` all select the safe fallback: stop the old query and start a fresh Agent SDK session under the replacement key. Do not automatically replay or summarize an old SDK transcript. A `supported` result permits preserving resume only for the exact validated same-context replacement semantics.

Update the PRD only after a second maintainer reviews the redacted report and restricted evidence. Record:

- Missing, empty, and invalid credential result/exception paths.
- The exact redacted T3-equivalent `lastError` text and whether dedicated mapping is needed.
- E4/E5 control outcomes.
- E6 classification, rationale, and selected Phase 3 continuity behavior.
- A restricted evidence reference, not the raw report or credentials.

If authorization, keys, or the deployed Bonzai contract are unavailable, keep Phase 1 in progress and record the blocker. Never infer or invent a live result.

## Troubleshooting

| Symptom                                                               | Interpretation                                                                                                             | Action                                                                                                                                    |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Valid K1 fails before a result                                        | Possible base path/header mismatch or missing child runtime variable                                                       | Reconfirm the deployed contract; inspect the separate caught exception and approved gateway evidence. Do not interpret E6.                |
| E0 or E1 succeeds                                                     | Saved login, Keychain, or another credential source may contaminate isolation                                              | Stop, move to a dedicated account/VM, and rerun from a clean context.                                                                     |
| No init or result message                                             | SDK process failed before normal initialization                                                                            | Check the allowlisted `PATH`, HOME requirement, CA files, and approved proxy variables. Do not label it an HTTP authorization status.     |
| E4 has no durable session ID                                          | The creation control failed                                                                                                | Do not run E5 or E6. Review ordered messages and gateway correlation evidence.                                                            |
| E5 starts fresh or misses the marker                                  | Wrong `cwd`, missing transcript, config mismatch, or unsupported local resume                                              | Confirm identical labels and transcript lifetime. Mark the replacement-key result ambiguous.                                              |
| Generic `Claude runtime stream failed.`                               | The stream threw without a conclusive terminal error result                                                                | Use restricted gateway evidence if authorized; otherwise classify the replacement-key outcome as ambiguous.                               |
| A case times out                                                      | Query exceeded the hard deadline                                                                                           | Confirm gateway reachability and retry policy; retain the timeout classification and do not infer authorization behavior.                 |
| An invalid key shows `apiRetryCount` climbing with no terminal result | Expected: an invalid credential retries instead of failing fast (observed still retrying past 180s)                        | Treat the timeout classification as the finding. Raise `--case-timeout-ms` only to characterize the retry curve, never to force a result. |
| A case reports `authFailureMaskedAsCompleted: true`                   | The credential failed, but production would project a completed turn because `turnStatusFromResult` keys only on `subtype` | Record as a product gap: the actionable text (`Not logged in · Please run /login`) is discarded before reaching the UI.                   |
| Output already exists                                                 | The probe refuses to overwrite evidence                                                                                    | Choose a new nonsecret run ID after reviewing the existing file.                                                                          |
| E7 recovers the marker                                                | Potential cross-scope exposure                                                                                             | Stop immediately, restrict evidence, classify `security-review-required`, and escalate to the Bonzai owner.                               |

## Cleanup

After review, remove local generated evidence according to the approved retention policy. The probe removes temporary Claude state automatically, but the generated JSON remains until an operator deletes it. Never commit the report, raw logs, credentials, or copied transcript state.
