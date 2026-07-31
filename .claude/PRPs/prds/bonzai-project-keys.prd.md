# Bonzai Project Keys

## Problem Statement

Developers in multi-client teams need every Claude Code request from a T3 Code project to be billed to the correct client. Today, a developer must maintain multiple credential-bearing provider instances and manually select the correct one while context-switching, making cross-client mis-billing possible and already observed in a 400+ developer organization.

Without a project-level authorization boundary, adoption is blocked because normal chat behavior cannot guarantee that a request uses the intended client credential.

## Evidence

- Cross-client mis-billings have already been recorded through the organization's internal tooling.
- More than 400 developers work across multiple client projects and receive a distinct virtual key for each client; no keys are shared between developers.
- The current workaround requires duplicate provider instances and repeated manual selection. Provider clutter, human memory, and frequent context switching make correct attribution impossible to guarantee.
- T3 Code already supports sensitive provider environment variables, including `ANTHROPIC_AUTH_TOKEN`, but these are provider-instance scoped rather than project scoped.

## Proposed Solution

Add a required, locally stored **Bonzai Key** to each T3 Code project. T3 Code injects that secret as `ANTHROPIC_AUTH_TOKEN` whenever it starts or resumes Claude Code for the project, so no credential choice appears in normal chat or agent flows. Claude Code is the only enabled provider application-wide for v1; other providers remain visible but disabled as **Coming soon**, and supported server APIs reject non-Claude selections. The Claude Code provider uses a cross-project Bonzai base URL, prefilled as `https://api-v2.bonzai.iodigital.com` and configurable in provider settings. End-user UI and documentation must use the Bonzai product name and must never expose the underlying middleware product name.

## Key Hypothesis

We believe binding one locally stored Bonzai Key to each T3 Code project and automatically injecting it into that project's Claude Code processes will eliminate manual credential switching and prevent cross-client mis-billing for developers in multi-client teams.
We'll know we're right when developers perform zero credential switches during normal use and internal billing tooling records zero requests attributed to the wrong client.

## What We're NOT Building

- Providers other than Claude Code — project-bound credentials will be ported to each provider separately.
- Direct Claude.ai or Anthropic credential flows — v1 targets teams using Bonzai as their enterprise model gateway.
- Bonzai Key creation, rotation, revocation, or entitlement administration — users bring keys issued through existing company processes.
- LiteLLM project-management API integration — attribution remains based on developer-specific, client-specific virtual keys.
- Shared, repository-committed, or centrally synchronized project bindings — each T3 Code installation stores its bindings locally.
- Migration of existing projects, conversations, or provider configurations — the initial rollout has no existing adopters to migrate.
- Defense against a developer modifying their local T3 Code installation or calling the gateway directly — v1 enforces authorization through supported T3 Code UI and APIs.
- Bulk project setup, bulk key import, organization deployment tooling, audit history, and billing-target labels.
- Key pre-validation before project creation — the gateway remains authoritative for credential validity in the MVP.

## Success Metrics

| Metric                                                  | Target | How Measured                                                                 |
| ------------------------------------------------------- | ------ | ---------------------------------------------------------------------------- |
| Manual credential switches during normal chat/agent use | 0      | Product-flow observation and user validation during pilot                    |
| Requests attributed to the wrong client                 | 0      | Existing internal billing/mis-attribution tooling                            |
| Projects created without a Bonzai Key                   | 0      | Project creation command validation and local project-state inspection       |
| Supported non-Claude provider starts                    | 0      | Server authorization tests and runtime telemetry/log inspection during pilot |

## Open Questions

> The three Phase 1 answers below rest on **single-maintainer evidence**: the live matrix was run by the implementation's author, and the plan's Level 6 gate is still open — the independent re-run and the restricted gateway-side correlation (runbook review step 8) have not happened. Two implementation reviews verified the reasoning and the code, not the runs. Treat the answers as sound but not yet independently corroborated.

- [x] **Answered (Phase 1, 2026-07-31).** Does resuming a persisted Claude conversation under a replacement Bonzai Key work end-to-end through the deployed Bonzai gateway? **Yes.** Resuming the exact session ID under a second authorized key returned the same session ID and recovered a random marker stored in the original turn. Conversation state lives in the local transcript, not at the gateway, so the credential authorizes each request rather than the session. Falsification controls confirm the credential is still enforced: the same resume fails with an invalid token and with no token. Caveat: resume re-sends prior context under the new credential, so a key change representing a **different** client should start a fresh session rather than resume.
- [x] **Answered (Phase 1, 2026-07-31).** What exact error message does Claude Agent SDK preserve when Bonzai rejects a missing, invalid, expired, or unauthorized key, and is it understandable in the existing UI? **Two distinct paths, neither understandable today.** Missing/empty credential fails locally before reaching Bonzai: `SDKAssistantMessage.error = "authentication_failed"`, then a result with `subtype: "success"` and `is_error: true`, then a throw carrying `Not logged in · Please run /login`. Because `turnStatusFromResult` (`apps/server/src/provider/Layers/ClaudeAdapter.ts:997`) keys only on `subtype`, T3 Code projects this as a **completed** turn and surfaces only the generic `Claude runtime stream failed.`, discarding the actionable text. An invalid credential is worse: an unbounded `api_retry` storm with no terminal result (10 retries, still retrying past 180s), so the user sees an indefinite spinner and no error at all.
- [x] **Answered (Phase 1, 2026-07-31).** Should v1 translate Bonzai authorization failures into a dedicated project-settings call to action, or only display the existing provider error? **Dedicated mapping is required**; the MVP assumption that generic propagation suffices is disproven by the two paths above. Phase 3 must additionally cap retries or impose a deadline so an invalid key fails visibly instead of hanging.
- [ ] Which existing disabled-provider/Coming soon presentation should be canonical across web and mobile?
- [ ] Should inherited gateway variables other than `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` be cleared to ensure all Claude traffic uses the configured Bonzai endpoint?

---

## Users & Context

**Primary User**

- **Who**: A developer in a multi-client team who uses T3 Code with Claude Code through the company's Bonzai enterprise model service. The initial organization has more than 400 developers.
- **Current behavior**: Creates multiple Claude provider instances, attaches a different client-specific key to each one, and manually selects the expected instance whenever switching projects.
- **Trigger**: Adding, opening, or switching to a client project and starting a Claude Code conversation.
- **Success state**: The developer configures the project's Bonzai Key once and can thereafter chat, resume conversations, and develop without selecting or considering credentials; all requests are attributed to the correct client.

**Job to Be Done**
When I switch to a client project, I want T3 Code to automatically use my authorized client credential, so I can work without risking charges to another client.

**Non-Users**

- Users connecting directly to Claude.ai or Anthropic.
- Users of providers other than Claude Code in v1.
- Single-client developers who do not require client-specific attribution.
- Organizations expecting T3 Code to issue or centrally administer gateway keys.

---

## Solution Detail

### Core Capabilities (MoSCoW)

| Priority | Capability                                                                                                    | Rationale                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Must     | Require one Bonzai Key when creating each project                                                             | Establishes the project authorization boundary before the first message can be sent.                                   |
| Must     | Store the Bonzai Key locally as a protected, redacted project secret                                          | Prevents credential exposure in project files, settings responses, logs, or source control.                            |
| Must     | Inject the project's key as `ANTHROPIC_AUTH_TOKEN` into every Claude process for that project                 | Guarantees requests use the project-bound billing identity without manual choice.                                      |
| Must     | Prefill the Claude provider base URL as `https://api-v2.bonzai.iodigital.com`, configurable at provider level | Routes all projects through Bonzai while retaining an operational override in one cross-project location.              |
| Must     | Make Claude Code the only enabled provider application-wide                                                   | Keeps unsupported provider credential models out of v1 and removes credential-bearing provider selection.              |
| Must     | Reject non-Claude model/provider selections in supported server APIs                                          | Makes the restriction an enforced product invariant rather than a UI-only affordance.                                  |
| Must     | Permit Claude model selection without changing project credentials                                            | Preserves useful model choice while separating model choice from billing identity.                                     |
| Must     | Allow Bonzai Key replacement from local project settings                                                      | Supports normal credential replacement without recreating a project.                                                   |
| Must     | Restart active Claude processes after key replacement and preserve resume state                               | Prevents an old process from continuing with the previous key while retaining conversation continuity where supported. |
| Must     | Use “Bonzai” and “Bonzai Key” in all end-user surfaces                                                        | The underlying gateway technology is an internal implementation detail that must never be communicated to users.       |
| Should   | Show missing/invalid authorization errors through the existing provider-error UI                              | Gives the developer actionable feedback while keeping gateway authorization authoritative.                             |
| Should   | Show configured-versus-needs-attention state in project settings without revealing the key                    | Helps users recover from missing local secret material.                                                                |
| Could    | Validate a Bonzai Key before completing project creation                                                      | Earlier feedback, but not necessary to test automatic authorization and attribution.                                   |
| Could    | Add dedicated Bonzai authorization error copy and a direct link to project settings                           | Improves recovery after the generic error path is validated.                                                           |
| Won't    | Enable or hide the implementation of other providers                                                          | They remain visible as Coming soon and will be ported separately.                                                      |
| Won't    | Create, manage, synchronize, or centrally distribute Bonzai Keys                                              | Existing organizational processes remain responsible for key lifecycle.                                                |

### MVP Scope

The MVP introduces a local, required Bonzai Key for every newly created T3 Code project; protected project-secret persistence; project-specific Claude process environment construction; key replacement with process restart and resume preservation; a provider-level Bonzai base URL default; application-wide Claude-only enforcement in web, mobile, WebSocket, and HTTP command paths; disabled Coming soon entries for all other providers; and generic gateway authorization error display.

The MVP does not require existing-state migration, key pre-validation, bulk administration, dedicated billing-target UI, or other provider implementations.

### User Flow

1. The developer chooses **Add project**.
2. T3 Code collects the project location and requires a **Bonzai Key**.
3. T3 Code creates the project and stores the key locally as a protected secret. The raw value is never returned to a client after saving.
4. The project opens with Claude Code selected. Other providers remain visible but disabled as **Coming soon**.
5. The developer optionally selects an available Claude model and sends a message.
6. The server resolves the thread's project, retrieves its Bonzai Key, sets the configured provider-level Bonzai base URL, clears conflicting inherited Anthropic credential variables, and starts Claude with the project key as `ANTHROPIC_AUTH_TOKEN`.
7. Subsequent turns and resumed conversations use the same project-bound key automatically.
8. To replace a key, the developer opens local project settings and enters a new Bonzai Key. T3 Code stores it, terminates any active Claude process for that project, retains conversation resume data, and starts the next interaction under the new key.
9. If secret material is unexpectedly unavailable or Bonzai rejects the credential, T3 Code surfaces the resulting authorization failure through the existing provider-error UI; it never falls back to another project or provider credential.

---

## Technical Approach

**Feasibility**: MEDIUM–HIGH

**Architecture Notes**

- Extend local project state with a redacted Bonzai credential status/reference, but keep the raw secret outside project events, projections, repository files, client snapshots, and logs.
- Reuse `ServerSecretStore` for local protected storage. Derive secret identity from `ProjectId`, analogous to provider environment secrets currently derived from provider instance and variable name.
- Add server-authoritative project-secret create/replace operations rather than carrying the raw key through generic project event payloads. Project creation must be atomic from the user's perspective: a project cannot become usable without successfully persisting its required key.
- Keep `ANTHROPIC_BASE_URL` provider-scoped and cross-project. Seed the Claude provider setting with `https://api-v2.bonzai.iodigital.com`; allow editing from provider settings. Do not duplicate the base URL into each project.
- Resolve the project key at Claude session-start time and construct a project-specific SDK environment. The current provider-instance registry creates adapters with static instance environments, so implementation must not share a credential-bearing Claude process or immutable adapter environment across projects.
- Explicitly clear inherited `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` before applying project configuration. Missing secret material must never fall back to a process-level or another project credential.
- Enforce Claude-only selection on the server at thread creation, thread metadata update, turn start, session start/restart, and recovery boundaries. UI disabling is supplementary.
- Preserve Claude resume cursor/session ID independently of the Bonzai Key. On key replacement, stop the current SDK query and create a new one with the same resume ID and the new environment.
- Use product language at the presentation boundary: end-user copy says **Bonzai**, **Bonzai Key**, and **Bonzai API URL**. The implementation may reference LiteLLM internally where technically necessary, but user-visible copy, documentation, errors authored by T3 Code, telemetry labels exposed to users, and screenshots must not.

**Existing Integration Points**

- Provider-instance environment and secret contracts: `packages/contracts/src/providerInstance.ts:97`
- Sensitive environment persistence/materialization: `apps/server/src/serverSettings.ts:79`, `apps/server/src/serverSettings.ts:316`
- Generic local secret storage: `apps/server/src/auth/ServerSecretStore.ts:138`
- Project contract and default model selection: `packages/contracts/src/orchestration.ts:213`
- Project projection persistence: `apps/server/src/persistence/Layers/ProjectionProjects.ts:18`
- Claude driver environment setup: `apps/server/src/provider/Drivers/ClaudeDriver.ts:111`
- Agent SDK query environment and resume: `apps/server/src/provider/Layers/ClaudeAdapter.ts:1457`, `apps/server/src/provider/Layers/ClaudeAdapter.ts:3488`
- Server session selection/start: `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:450`
- Web provider/model selection: `apps/web/src/components/chat/ChatComposer.tsx:742`
- Mobile provider/model selection and queued sends: `apps/mobile/src/features/threads/ThreadComposer.tsx:584`, `apps/mobile/src/state/use-thread-outbox-drain.ts:168`
- Generic runtime-error projection: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:1380`
- Web error display: `apps/web/src/components/chat/ThreadErrorBanner.tsx:7`

**Technical Risks**

| Risk                                                                                 | Likelihood                               | Mitigation                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Static provider-instance environment causes credentials to be shared across projects | High                                     | Resolve the Bonzai Key at session start and ensure each Claude SDK query receives a project-specific environment; add cross-project isolation tests.                                                                                                                                                              |
| Direct WebSocket/HTTP commands bypass disabled provider UI                           | High                                     | Validate Claude-only and project-binding invariants server-side for all selection-bearing commands and session recovery.                                                                                                                                                                                          |
| Inherited Anthropic credentials silently bypass a missing project secret             | High                                     | Explicitly unset conflicting auth variables before applying the project key; test with populated parent `process.env`.                                                                                                                                                                                            |
| Active Claude process continues using an old key after replacement                   | Medium                                   | Stop all active project sessions before acknowledging replacement; restart lazily with preserved resume state.                                                                                                                                                                                                    |
| Claude session cannot resume under a different Bonzai Key                            | Provisionally resolved (pending Level 6) | **Phase 1 (2026-07-31) found that resume under a replacement key works**, on single-maintainer evidence not yet independently re-run. Residual risk moves to context transfer — resume replays the local transcript under the new credential, so a key change across billing contexts must start a fresh session. |
| Gateway unauthorized response becomes opaque or loses status/detail in Agent SDK     | Confirmed                                | **Occurred in Phase 1.** Missing keys are projected as a completed turn with only `Claude runtime stream failed.`; invalid keys never yield a terminal result. Phase 3 must add auth-error mapping, inspect `is_error`/`SDKAssistantMessage.error`, and cap retries.                                              |
| Raw Bonzai Key leaks into events, settings snapshots, logs, or client state          | Medium                                   | Keep raw-key operations outside event payloads; reuse redaction patterns; add persistence, RPC, snapshot, and log-focused tests.                                                                                                                                                                                  |
| Project creation succeeds while secret persistence fails                             | Medium                                   | Define transaction/compensation semantics so failed secret writes do not leave a usable unconfigured project.                                                                                                                                                                                                     |
| Provider-level base URL change leaves active sessions on the old endpoint            | Medium                                   | Treat base URL changes like credential changes: stop affected Claude processes and apply the new URL on restart.                                                                                                                                                                                                  |
| Internal middleware product name leaks into end-user copy or raw gateway errors      | Medium                                   | Add copy review/tests for authored surfaces; sanitize or wrap errors only when the upstream response exposes forbidden implementation terminology.                                                                                                                                                                |

---

## Implementation Phases

<!--
  STATUS: pending | in-progress | complete
  PARALLEL: phases that can run concurrently (e.g., "with 3" or "-")
  DEPENDS: phases that must complete first (e.g., "1, 2" or "-")
  PRP: link to generated plan file once created
-->

| #   | Phase                         | Description                                                                                                        | Status   | Parallel  | Depends | PRP Plan                                                                                                                           |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------- | --------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Runtime validation spike      | Verify Bonzai error propagation and Claude session resume under a replacement key                                  | complete | -         | -       | [.claude/PRPs/plans/completed/bonzai-runtime-validation-spike.plan.md](../plans/completed/bonzai-runtime-validation-spike.plan.md) |
| 2   | Project secret domain         | Add project-scoped secret contracts/services, redaction, persistence, and lifecycle tests                          | pending  | -         | 1       | -                                                                                                                                  |
| 3   | Claude runtime binding        | Resolve project keys at session start, isolate environments, clear inherited auth, and handle key/base-URL changes | pending  | -         | 2       | -                                                                                                                                  |
| 4   | Server enforcement            | Enforce application-wide Claude-only selection and project authorization across supported APIs and recovery        | pending  | with 5    | 3       | -                                                                                                                                  |
| 5   | Project setup and settings UI | Require/edit Bonzai Keys and configure the cross-project Bonzai API URL                                            | pending  | with 4    | 3       | -                                                                                                                                  |
| 6   | Provider presentation         | Keep non-Claude providers visible but disabled as Coming soon across web and mobile                                | pending  | with 4, 5 | 3       | -                                                                                                                                  |
| 7   | End-to-end verification       | Test isolation, replacement/resume, errors, terminology, web/mobile parity, and regressions                        | pending  | -         | 4, 5, 6 | -                                                                                                                                  |

### Phase Details

**Phase 1: Runtime validation spike**

- **Goal**: Retire the two external-behavior uncertainties before committing the data model and UX.
- **Scope**: Exercise a real or representative Bonzai endpoint with a missing/invalid key; record the Agent SDK error shape; create a Claude session under one test key, stop it, and attempt to resume the same session under another authorized test key.
- **Success signal**: The team has reproducible evidence for error rendering and resume behavior, plus an explicitly selected fallback if credential-changing resume is unsupported.

**Phase 2: Project secret domain**

- **Goal**: Establish a safe local lifecycle for one required Bonzai Key per project.
- **Scope**: Project-secret naming and storage, create/replace/delete behavior, redacted presence state, authorization contracts, project deletion cleanup, atomic failure behavior, and unit/integration tests proving the key is absent from project events, SQLite projections, settings JSON, RPC responses, and repository files.
- **Success signal**: A project can be created with and later replace a local Bonzai Key, while no supported read path exposes the raw value.

**Phase 3: Claude runtime binding**

- **Goal**: Guarantee that every Claude process uses the key belonging to its project.
- **Scope**: Project-aware environment construction, `ANTHROPIC_AUTH_TOKEN` injection, inherited credential clearing, provider-level `ANTHROPIC_BASE_URL` default/configuration, active-session shutdown after key or URL changes, session recovery, and cross-project concurrency tests.
- **Success signal**: Concurrent projects demonstrably send through distinct keys; missing secret material never falls back; replacement takes effect on the next request without cross-project leakage.

**Phase 4: Server enforcement**

- **Goal**: Make Claude-only project authorization a supported-API invariant.
- **Scope**: Validate thread creation, metadata changes, turn starts, HTTP/WS command dispatch, provider session start/restart, and recovery; reject non-Claude selections and any credential-bearing provider override.
- **Success signal**: Crafted supported API requests cannot start a non-Claude provider or substitute another project's credential.

**Phase 5: Project setup and settings UI**

- **Goal**: Let a developer configure authorization once and then work without credential interaction.
- **Scope**: Required Bonzai Key field in web and mobile project creation, masked/redacted replacement in local project settings, configured/missing status, provider-level Bonzai API URL prefilled with `https://api-v2.bonzai.iodigital.com`, and failure/retry states.
- **Success signal**: A developer can add a project, enter a key, send a Claude message, replace the key, and resume work without ever seeing or choosing a credential in chat.

**Phase 6: Provider presentation**

- **Goal**: Accurately communicate provider availability without removing future providers from discovery.
- **Scope**: Claude enabled; every other provider visible and disabled with the existing Coming soon treatment in web and mobile provider-selection surfaces.
- **Success signal**: UI parity tests confirm no enabled non-Claude choice while all intended provider entries remain discoverable.

**Phase 7: End-to-end verification**

- **Goal**: Prove the billing and authorization invariants across the complete product.
- **Scope**: Two-or-more project isolation; concurrent sessions; key replacement; resume behavior; inherited-env attacks; HTTP/WS bypass attempts; missing/invalid-key errors; base-URL override; project deletion cleanup; mobile queued sends; and a terminology sweep for forbidden end-user wording.
- **Success signal**: All automated tests pass, pilot telemetry shows no manual credential switching, and internal attribution tooling observes no cross-client requests.

### Parallelism Notes

Phase 1 must complete first because its results may change the resume fallback and error UX. Phase 2 establishes the project-secret contract required by runtime work. Phase 3 establishes runtime semantics before enforcement and UI integration. After Phase 3, server enforcement (Phase 4), project/provider settings UI (Phase 5), and disabled-provider presentation (Phase 6) can proceed in parallel because they primarily touch separate server, project-configuration, and presentation domains. Phase 7 integrates all three.

---

## Decisions Log

| Decision                                                         | Choice                                                                                                                            | Alternatives                                                       | Rationale                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User-facing product name                                         | Bonzai / Bonzai Key                                                                                                               | LiteLLM terminology, generic gateway terminology                   | The enterprise service is branded Bonzai; middleware implementation details must never be exposed to end users.                                                                                                                                                                                                                                                                             |
| Credential scope                                                 | One developer-specific Bonzai Key per T3 Code project                                                                             | One provider key, shared client key, manual provider instances     | Each project maps to one billable client, and each developer receives a separate key per client.                                                                                                                                                                                                                                                                                            |
| Credential storage                                               | Local protected project secret                                                                                                    | Repository file, synced setting, provider-level key                | Meets local-binding and secrecy requirements while separating projects.                                                                                                                                                                                                                                                                                                                     |
| Runtime credential variable                                      | `ANTHROPIC_AUTH_TOKEN`                                                                                                            | `ANTHROPIC_API_KEY`, caller-provided headers                       | Bonzai virtual keys are bearer credentials and Claude Code maps this variable to `Authorization: Bearer`.                                                                                                                                                                                                                                                                                   |
| Base URL scope                                                   | Provider-level, cross-project, prefilled and configurable                                                                         | Per-project URL, hard-coded URL                                    | Every project uses the same Bonzai deployment; centralized configuration prevents repetition while retaining operational flexibility.                                                                                                                                                                                                                                                       |
| Default Bonzai API URL                                           | `https://api-v2.bonzai.iodigital.com`                                                                                             | Blank, derived, hard-coded without edit                            | Removes setup work while allowing future endpoint changes.                                                                                                                                                                                                                                                                                                                                  |
| Key requirement                                                  | Required at project creation                                                                                                      | Optional with local block, optional and fail at gateway            | User selected a required field; no project should be created through normal flows without its billing identity.                                                                                                                                                                                                                                                                             |
| Provider availability                                            | Claude enabled; all others visible but disabled application-wide                                                                  | Project-scoped restriction, hide others, globally remove providers | V1 supports only Claude while preserving discoverability for future ports.                                                                                                                                                                                                                                                                                                                  |
| Enforcement boundary                                             | Supported T3 Code UI and server APIs                                                                                              | UI-only restriction, malicious-local-user resistance               | Server enforcement prevents normal client/API bypass; hostile local modification is explicitly out of scope.                                                                                                                                                                                                                                                                                |
| Unconfigured/missing secret behavior                             | Clear inherited credentials and allow Bonzai to return authorization failure                                                      | Silent fallback, local-only block                                  | Retains gateway-authoritative MVP error behavior without risking use of an unrelated inherited key.                                                                                                                                                                                                                                                                                         |
| Model choice                                                     | Claude models remain selectable                                                                                                   | Lock one model, bind model with credential                         | Model selection does not determine billing identity and is useful independently.                                                                                                                                                                                                                                                                                                            |
| Key replacement                                                  | Stop active process, preserve resume cursor, resume under new key                                                                 | Keep process until next session, discard conversation              | Environment is fixed at process launch; stopping prevents continued old-key use while session history is documented as separately persisted.                                                                                                                                                                                                                                                |
| Existing-state migration                                         | None                                                                                                                              | Migrate provider instances and threads                             | There is no current adoption, so migration adds cost without user value.                                                                                                                                                                                                                                                                                                                    |
| Key validity                                                     | Bonzai is authoritative in MVP                                                                                                    | Pre-validation, local format validation                            | Avoids duplicating gateway policy; pre-validation can be added later.                                                                                                                                                                                                                                                                                                                       |
| Resume after key replacement (Phase 1 evidence, pending Level 6) | Preserve the resume cursor for same-context key rotation; start a fresh session when the key change represents a different client | Always resume, always start fresh, summarize old history           | Validated live 2026-07-31 on single-maintainer evidence: replacement-key resume returned the same session ID and recovered prior context, while an invalid or absent credential still failed. Because resume replays the local transcript to the gateway under the new credential, resuming across different billing contexts would transmit one client's context under another's identity. |
| Authorization error UX (Phase 1 evidence, pending Level 6)       | Add dedicated Bonzai auth-error mapping plus a retry/deadline cap                                                                 | Rely on the existing generic provider error                        | Missing credentials project as a completed turn showing only `Claude runtime stream failed.`, and invalid credentials never produce a terminal error. Generic propagation is insufficient and misleading.                                                                                                                                                                                   |

---

## Research Summary

**Market Context**

- Claude Code formally supports organization-operated gateways with `ANTHROPIC_BASE_URL` and bearer credentials in `ANTHROPIC_AUTH_TOKEN`.
- Anthropic warns against committing gateway credentials to shared project settings; project-local references plus protected local/managed secrets are the established pattern.
- Claude Code's Agent SDK receives gateway credentials through each spawned process's environment, while conversation sessions are persisted locally and resumed by session ID.
- The market trend is toward managed gateway routing, protected credential delivery, per-developer identity, and automatic attribution rather than manually selected duplicate providers.
- No mainstream developer AI product was found with a polished native repository/project-to-distinct-external-gateway-key binding, making the capability a plausible differentiator.

**Technical Context**

- T3 Code already has protected local secret storage, sensitive value redaction, provider environment injection, multiple provider instances, event-sourced project metadata, Claude resume cursors, and generic provider-error rendering.
- Current provider environment is fixed at provider-instance/adapter creation, while the required Bonzai Key is project-specific. Runtime environment resolution therefore needs a project/session-aware boundary.
- Project `defaultModelSelection` is only a fallback; web, mobile, WebSocket, and HTTP paths can carry independent selections. Server-side validation is required for authorization.
- Claude sessions are long-lived SDK queries. Key or base-URL changes require process shutdown and restart; resume IDs can preserve conversation history, subject to the Phase 1 integration validation.
- Provider environments inherit `process.env`, so project authorization must explicitly clear conflicting inherited credentials before adding the project key.
- Generic runtime failures already reach session `lastError` and the web error banner, but Bonzai-specific error fidelity remains unverified.
- Phase 1 executed live against `https://api-v2.bonzai.iodigital.com` on 2026-07-31 with two disposable test keys. The gateway serves the Anthropic-native Messages API at the root base URL, accepts the virtual key as a bearer credential via `ANTHROPIC_AUTH_TOKEN`, and advertises Anthropic-style model IDs (`claude-sonnet-4-5` among them) alongside gateway aliases. Note the OpenAI-compatible `/v1/chat/completions` surface is **not** what Claude Code uses; `/v1/messages` had to be confirmed separately.
- Replacement-key resume is supported: the same session ID and prior marker were recovered under a second authorized key, while the identical resume failed under an invalid token (unbounded retries) and an absent token (immediate local auth failure). This confirms per-request credential enforcement with local transcript storage.
- Authorization failures do not surface usefully today. Missing credentials are projected as a completed turn showing only `Claude runtime stream failed.`; invalid credentials produce no terminal result at all. Both need Phase 3 work.
- Redacted evidence lives under the gitignored `artifacts/bonzai-runtime-validation/`; an independent scan confirmed no test credential survives report encoding in raw, URL-encoded, or base64 form.

**External Sources**

- [Connect Claude Code to an LLM gateway](https://code.claude.com/docs/en/llm-gateway-connect)
- [Claude Code settings scopes](https://code.claude.com/docs/en/settings)
- [Agent SDK session persistence and resume](https://code.claude.com/docs/en/agent-sdk/sessions)
- [How Claude Code stores and resumes sessions](https://code.claude.com/docs/en/how-claude-code-works)

---

_Generated: 2026-07-30_
_Status: DRAFT - needs validation_
