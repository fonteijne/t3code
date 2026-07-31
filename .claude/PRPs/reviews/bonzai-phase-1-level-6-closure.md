---
title: "Bonzai Phase 1 — Level 6 evidence gate closure"
closed: 2026-07-31
closed_by: "Carsten de la Fonteijne (project owner)"
evidence_of_record: artifacts/bonzai-runtime-validation/20260731T121255Z-review2.json
gate_status: CLOSED_WITH_ACCEPTED_GAPS
---

# Level 6 evidence gate closure

The project owner explicitly directed that the Bonzai Phase 1 Level 6 evidence gate be closed on 2026-07-31 after two implementation reviews and review of the redacted evidence package.

This is a **risk acceptance**, not a claim that every originally documented procedure was performed. The gate closes with two accepted gaps:

1. The live matrix was run by the implementation/report author rather than independently re-run by another maintainer.
2. No restricted Bonzai gateway-log correlation was performed. The evidence artifact also lacks the per-case timestamps/request identifiers that would make rigorous gateway-side correlation possible.

These gaps do not change the locally measured conclusions, which were reproduced across multiple runs and independently checked against production code:

- Replacement-key resume returned the requested session ID and recovered the prior marker under K2, while the same resume failed with invalid and absent credentials.
- Missing/empty credentials are projected by current T3 Code behavior as a completed turn with only `Claude runtime stream failed.` visible.
- Invalid credentials enter an `api_retry` storm and produce no terminal result within the bounded observation window.

The project owner accepts the residual auditability gap and ratifies the Phase 1 PRD answers, risk resolution, and decision-log entries as settled for planning Phases 2 and 3. A future independent re-run or gateway-side correlation may strengthen the evidence but is no longer a release or planning gate.

## Evidence checks accepted at closure

- Runtime provenance measured from the installed tree.
- Gateway origin, base path, model, and nonsecret credential scope recorded.
- Environment presence represented only as booleans.
- Actual K1/K2 values independently scanned in raw, URL-encoded, and base64 forms; no leaks found.
- SDK messages, terminal result, and caught exception recorded separately.
- E4–E6 use the same resolved cwd/config paths and requested session ID.
- E5 same-key marker continuity gates E6.
- Decision `supported` matches the documented rule for the observed E4/E5/E6 results.
- Evidence output is gitignored, mode `0600`, and temporary state removal is observed.
- Banner actionability is resolved as **no**: `Claude runtime stream failed.` is not actionable, and the invalid-key path exposes only an indefinite retry state.
- Two implementation reviews approved the code and reasoning after all findings were addressed.

## Ratified decision

- Same-context key rotation: preserve the Claude resume cursor.
- Key change representing a different client/billing context: start a fresh session because resume re-sends prior transcript context under the new credential.
- Authorization UX: add dedicated Bonzai auth-error mapping and a retry/deadline cap in Phase 3.
