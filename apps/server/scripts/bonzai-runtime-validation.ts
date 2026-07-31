#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off - This maintainer probe owns an isolated temporary filesystem lifecycle.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeTimers from "node:timers";
import * as NodeURL from "node:url";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  query,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

const REPORT_SCHEMA_VERSION = "1";
const DEFAULT_CASE_TIMEOUT_MS = 30_000;
const MIN_CASE_TIMEOUT_MS = 1_000;
const MAX_CASE_TIMEOUT_MS = 600_000;
/** One user turn per case: enough to store or recall the marker, never a tool loop. */
const CASE_MAX_TURNS = 1;
/** Hard per-case spend ceiling so a retry storm cannot run up cost. */
const CASE_MAX_BUDGET_USD = 0.05;
/** Value recorded when provenance cannot be measured; never a plausible-looking guess. */
const UNKNOWN_PROVENANCE = "unknown";
/** Classifications that prove nothing about resume support, only that no clear answer arrived. */
const INCONCLUSIVE_E6_CLASSIFICATIONS: ReadonlySet<ResultClassification> = new Set([
  "stream-exception",
  "no-terminal-result",
  "timeout",
  "skipped",
  "sdk-result-error",
  "result-then-exception",
]);
const INVALID_TOKEN_PREFIX = "bonzai-invalid-synthetic";
const SECRET_REPLACEMENT = "[REDACTED_CREDENTIAL]";
const PATH_REPLACEMENT = "[REDACTED_PATH]";
const AUTHORIZATION_FIELD = /(?:authorization|api[_-]?key|auth[_-]?token|credential|secret)/iu;
const SAFE_ENVIRONMENT_NAMES = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

export const ExperimentId = Schema.Literals(["E0", "E1", "E2", "E3", "E4", "E5", "E6", "E7"]);
export type ExperimentId = typeof ExperimentId.Type;

export const CredentialLabel = Schema.Literals([
  "none",
  "empty",
  "invalid-synthetic",
  "K1",
  "K2",
  "cross-scope",
]);
export type CredentialLabel = typeof CredentialLabel.Type;

export const ObservationStatus = Schema.Literals([
  "completed",
  "skipped",
  "timeout",
  "process-error",
]);
export type ObservationStatus = typeof ObservationStatus.Type;

export const ResultClassification = Schema.Literals([
  "success",
  "sdk-result-error",
  "result-then-exception",
  "stream-exception",
  "no-terminal-result",
  "timeout",
  "skipped",
]);
export type ResultClassification = typeof ResultClassification.Type;

export const ResumeDecision = Schema.Literals([
  "supported",
  "unsupported",
  "ambiguous",
  "security-review-required",
]);
export type ResumeDecision = typeof ResumeDecision.Type;

export const Phase3ContinuityBehavior = Schema.Literals([
  "preserve-resume-for-validated-scope",
  "start-fresh-session",
]);
export type Phase3ContinuityBehavior = typeof Phase3ContinuityBehavior.Type;

const CredentialPresence = Schema.Struct({
  anthropicBaseUrl: Schema.Boolean,
  anthropicAuthToken: Schema.Boolean,
  anthropicApiKey: Schema.Boolean,
  claudeConfigDir: Schema.Boolean,
});

const SdkMessageSummary = Schema.Struct({
  sequence: Schema.Number,
  type: Schema.String,
  subtype: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  apiKeySource: Schema.optional(Schema.String),
  assistantError: Schema.optional(Schema.String),
  assistantContainsMarker: Schema.optional(Schema.Boolean),
});

const TerminalResult = Schema.Struct({
  subtype: Schema.String,
  isError: Schema.Boolean,
  errors: Schema.Array(Schema.String),
  sessionId: Schema.String,
  stopReason: Schema.NullOr(Schema.String),
  containsMarker: Schema.Boolean,
});

const CaughtException = Schema.Struct({
  name: Schema.String,
  message: Schema.String,
});

export const ProductionTurnStatus = Schema.Literals([
  "none",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
]);
export type ProductionTurnStatus = typeof ProductionTurnStatus.Type;

const T3Projection = Schema.Struct({
  path: Schema.Literals([
    "none",
    "result-message",
    "stream-exception",
    "result-then-stream-exception",
  ]),
  lastError: Schema.optional(Schema.String),
  /**
   * Status `ClaudeAdapter.turnStatusFromResult` would derive from this result.
   * Recorded because that function keys only on `subtype`, so a result carrying
   * `subtype: "success"` with `is_error: true` is reported as a completed turn.
   */
  productionTurnStatus: ProductionTurnStatus,
  /**
   * True when the result carried `is_error` but production would still project a
   * completed turn, hiding the failure. Cause-agnostic: covers quota, transport,
   * and authorization alike.
   */
  errorMaskedAsCompleted: Schema.Boolean,
  /**
   * Narrower than `errorMaskedAsCompleted`: set only when an assistant message
   * named an authorization failure, so an operator can trust this as a credential
   * finding rather than any masked error.
   */
  authFailureMaskedAsCompleted: Schema.Boolean,
  threadErrorBannerActionable: Schema.Literals(["not-reviewed", "yes", "no"]),
});

export const BonzaiRuntimeObservation = Schema.Struct({
  id: ExperimentId,
  credential: CredentialLabel,
  purpose: Schema.String,
  status: ObservationStatus,
  classification: ResultClassification,
  credentialPresence: CredentialPresence,
  cwdLabel: Schema.String,
  configDirLabel: Schema.String,
  cwdMatchesControl: Schema.Boolean,
  configDirMatchesControl: Schema.Boolean,
  messages: Schema.Array(SdkMessageSummary),
  /** Count of `api_retry` system messages; a high count with no result means a retry storm. */
  apiRetryCount: Schema.Number,
  /** Distinct `SDKAssistantMessage.error` values, e.g. `authentication_failed`. */
  assistantErrors: Schema.Array(Schema.String),
  terminalResult: Schema.optional(TerminalResult),
  caughtException: Schema.optional(CaughtException),
  requestedSessionId: Schema.optional(Schema.String),
  emittedSessionId: Schema.optional(Schema.String),
  sessionIdMatchesRequested: Schema.optional(Schema.Boolean),
  markerExpected: Schema.Boolean,
  markerObserved: Schema.Boolean,
  markerResumed: Schema.optional(Schema.Boolean),
  t3Projection: T3Projection,
  timeoutMs: Schema.Number,
  skippedReason: Schema.optional(Schema.String),
});
export type BonzaiRuntimeObservation = typeof BonzaiRuntimeObservation.Type;

const RuntimeMetadata = Schema.Struct({
  agentSdkVersion: Schema.String,
  bundledClaudeCodeVersion: Schema.String,
  nodeVersion: Schema.String,
  pnpmVersion: Schema.String,
  lockfileVersion: Schema.String,
  platform: Schema.String,
  architecture: Schema.String,
});

const GatewayMetadata = Schema.Struct({
  approvedOrigin: Schema.String,
  approvedBasePath: Schema.String,
  credentialScope: Schema.String,
  approvalReference: Schema.String,
  requestedModel: Schema.optional(Schema.String),
});

const IsolationMetadata = Schema.Struct({
  cwdLabel: Schema.String,
  configDirLabel: Schema.String,
  temporaryStateRemovedAfterRun: Schema.Boolean,
  inheritedEnvironmentAllowlist: Schema.Array(Schema.String),
});

const ResumeDecisionRecord = Schema.Struct({
  value: ResumeDecision,
  rationale: Schema.String,
  phase3ContinuityBehavior: Phase3ContinuityBehavior,
});

export const BonzaiRuntimeReport = Schema.Struct({
  schemaVersion: Schema.Literal(REPORT_SCHEMA_VERSION),
  generatedAt: Schema.String,
  runtime: RuntimeMetadata,
  gateway: GatewayMetadata,
  isolation: IsolationMetadata,
  observations: Schema.Array(BonzaiRuntimeObservation),
  decision: ResumeDecisionRecord,
  reviewerNotes: Schema.String,
});
export type BonzaiRuntimeReport = typeof BonzaiRuntimeReport.Type;

export const encodeBonzaiRuntimeReport = Schema.encodeEffect(
  fromJsonStringPretty(BonzaiRuntimeReport),
);
export const decodeBonzaiRuntimeReport = Schema.decodeUnknownEffect(BonzaiRuntimeReport);

export class BonzaiRuntimeValidationInputError extends Schema.TaggedErrorClass<BonzaiRuntimeValidationInputError>()(
  "BonzaiRuntimeValidationInputError",
  { message: Schema.String },
) {}

export class BonzaiRuntimeValidationLeakError extends Schema.TaggedErrorClass<BonzaiRuntimeValidationLeakError>()(
  "BonzaiRuntimeValidationLeakError",
  { message: Schema.String },
) {}

export class BonzaiRuntimeValidationWriteError extends Schema.TaggedErrorClass<BonzaiRuntimeValidationWriteError>()(
  "BonzaiRuntimeValidationWriteError",
  { message: Schema.String, cause: Schema.Defect() },
) {}

const isBonzaiRuntimeValidationInputError = Schema.is(BonzaiRuntimeValidationInputError);
const isBonzaiRuntimeValidationLeakError = Schema.is(BonzaiRuntimeValidationLeakError);
const isBonzaiRuntimeValidationWriteError = Schema.is(BonzaiRuntimeValidationWriteError);

export interface BonzaiRuntimeValidationInput {
  readonly acknowledgeLiveGatewayTest: boolean;
  readonly baseUrl: string;
  readonly output: string;
  readonly credentialScope: string;
  readonly approvalReference: string;
  readonly model?: string | undefined;
  readonly caseTimeoutMs?: number | undefined;
  readonly includeCrossScopeTest?: boolean;
  readonly acknowledgeCrossScopeTest?: boolean;
  readonly crossScopeApprovalReference?: string | undefined;
}

export interface BonzaiRuntimeSecretEnvironment {
  readonly BONZAI_RUNTIME_K1?: string | undefined;
  readonly BONZAI_RUNTIME_K2?: string | undefined;
  readonly BONZAI_RUNTIME_CROSS_SCOPE_KEY?: string | undefined;
}

export interface BonzaiRuntimeValidatedInput extends BonzaiRuntimeValidationInput {
  readonly gatewayUrl: URL;
}

export type CredentialMode = "absent" | "empty" | "invalid" | "K1" | "K2" | "cross-scope";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function redactSensitiveText(
  value: string,
  secrets: readonly string[],
  sensitivePaths: readonly string[] = [],
): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length > 0) {
      redacted = redacted.replace(new RegExp(escapeRegExp(secret), "gu"), SECRET_REPLACEMENT);
    }
  }
  for (const path of sensitivePaths) {
    if (path.length > 0) {
      redacted = redacted.replace(new RegExp(escapeRegExp(path), "gu"), PATH_REPLACEMENT);
    }
  }

  return redacted
    .replace(/Bearer\s+[^\s,;"']+/giu, `Bearer ${SECRET_REPLACEMENT}`)
    .replace(/(?:sk-|key-|token-)[A-Za-z0-9._-]{8,}/gu, SECRET_REPLACEMENT)
    .replace(
      /([?&](?:access_token|api_key|auth_token|key|token)=)[^&#\s]+/giu,
      `$1${SECRET_REPLACEMENT}`,
    )
    .replace(
      /(["']?(?:authorization|api[_-]?key|auth[_-]?token|credential|secret)["']?\s*[:=]\s*["']?)[^,"'\s}]+/giu,
      `$1${SECRET_REPLACEMENT}`,
    )
    .replace(/(?:\/Users\/|\/home\/|\/private\/var\/|\/tmp\/)[^\s"',;}\]]+/gu, PATH_REPLACEMENT)
    .replace(/[A-Za-z]:\\Users\\[^\s"',;}\]]+/gu, PATH_REPLACEMENT);
}

export function redactUnknown(
  value: unknown,
  secrets: readonly string[],
  sensitivePaths: readonly string[] = [],
): unknown {
  if (typeof value === "string") {
    return redactSensitiveText(value, secrets, sensitivePaths);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item, secrets, sensitivePaths));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        AUTHORIZATION_FIELD.test(key)
          ? SECRET_REPLACEMENT
          : redactUnknown(item, secrets, sensitivePaths),
      ]),
    );
  }
  return value;
}

export function assertNoSecretSentinels(
  encodedReport: string,
  secretSentinels: readonly string[],
): void {
  const leaked = secretSentinels.find((sentinel) => {
    if (sentinel.length === 0) return false;
    const representations = [
      sentinel,
      encodeURIComponent(sentinel),
      Buffer.from(sentinel).toString("base64"),
    ];
    return representations.some((representation) => encodedReport.includes(representation));
  });
  if (leaked !== undefined) {
    throw new BonzaiRuntimeValidationLeakError({
      message: "Report leak guard rejected sensitive evidence.",
    });
  }
}

export function environmentPresence(
  environment: Readonly<Record<string, string | undefined>>,
): typeof CredentialPresence.Type {
  return {
    anthropicBaseUrl: environment.ANTHROPIC_BASE_URL !== undefined,
    anthropicAuthToken:
      environment.ANTHROPIC_AUTH_TOKEN !== undefined && environment.ANTHROPIC_AUTH_TOKEN.length > 0,
    anthropicApiKey:
      environment.ANTHROPIC_API_KEY !== undefined && environment.ANTHROPIC_API_KEY.length > 0,
    claudeConfigDir: environment.CLAUDE_CONFIG_DIR !== undefined,
  };
}

export function buildBonzaiChildEnvironment(input: {
  readonly parentEnvironment: Readonly<Record<string, string | undefined>>;
  readonly baseUrl: string;
  readonly configDir: string;
  readonly credentialMode: CredentialMode;
  readonly credential?: string | undefined;
}): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {};
  for (const name of SAFE_ENVIRONMENT_NAMES) {
    const value = input.parentEnvironment[name];
    if (value !== undefined) environment[name] = value;
  }

  environment.ANTHROPIC_BASE_URL = input.baseUrl;
  environment.CLAUDE_CONFIG_DIR = input.configDir;
  environment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  environment.CLAUDE_AGENT_SDK_CLIENT_APP = "t3-code-bonzai-runtime-validation/1";

  if (input.credentialMode === "empty") {
    environment.ANTHROPIC_AUTH_TOKEN = "";
    environment.ANTHROPIC_API_KEY = "";
  } else if (
    input.credentialMode === "invalid" ||
    input.credentialMode === "K1" ||
    input.credentialMode === "K2" ||
    input.credentialMode === "cross-scope"
  ) {
    environment.ANTHROPIC_AUTH_TOKEN = input.credential;
  }

  return environment;
}

export function validateBonzaiRuntimeInput(
  input: BonzaiRuntimeValidationInput,
): BonzaiRuntimeValidatedInput {
  if (!input.acknowledgeLiveGatewayTest) {
    throw new BonzaiRuntimeValidationInputError({
      message:
        "Refusing live gateway access; pass --ack-live-gateway-test after authorization review.",
    });
  }
  if (input.baseUrl.trim().length === 0) {
    throw new BonzaiRuntimeValidationInputError({ message: "--base-url is required." });
  }
  if (input.output.trim().length === 0) {
    throw new BonzaiRuntimeValidationInputError({ message: "--output is required." });
  }
  if (input.credentialScope.trim().length === 0) {
    throw new BonzaiRuntimeValidationInputError({ message: "--credential-scope is required." });
  }
  if (input.approvalReference.trim().length === 0) {
    throw new BonzaiRuntimeValidationInputError({ message: "--approval-reference is required." });
  }
  if (
    input.caseTimeoutMs !== undefined &&
    (!Number.isFinite(input.caseTimeoutMs) ||
      input.caseTimeoutMs < MIN_CASE_TIMEOUT_MS ||
      input.caseTimeoutMs > MAX_CASE_TIMEOUT_MS)
  ) {
    // A non-positive delay fires on the next tick, aborting every case and
    // producing a report full of timeouts that reads like a gateway outage.
    throw new BonzaiRuntimeValidationInputError({
      message: `--case-timeout-ms must be between ${MIN_CASE_TIMEOUT_MS} and ${MAX_CASE_TIMEOUT_MS}.`,
    });
  }

  let gatewayUrl: URL;
  try {
    gatewayUrl = new URL(input.baseUrl);
  } catch {
    throw new BonzaiRuntimeValidationInputError({ message: "--base-url must be an absolute URL." });
  }
  if (
    gatewayUrl.username.length > 0 ||
    gatewayUrl.password.length > 0 ||
    gatewayUrl.search.length > 0
  ) {
    throw new BonzaiRuntimeValidationInputError({
      message: "--base-url must not contain credentials or query parameters.",
    });
  }
  if (input.includeCrossScopeTest) {
    if (!input.acknowledgeCrossScopeTest) {
      throw new BonzaiRuntimeValidationInputError({
        message: "E7 requires --ack-cross-scope-test and separate written authorization.",
      });
    }
    if (!input.crossScopeApprovalReference?.trim()) {
      throw new BonzaiRuntimeValidationInputError({
        message: "E7 requires --cross-scope-approval-reference.",
      });
    }
  }

  return { ...input, gatewayUrl };
}

export function validateBonzaiRuntimeSecrets(
  input: BonzaiRuntimeValidationInput,
  environment: BonzaiRuntimeSecretEnvironment,
): void {
  if (!environment.BONZAI_RUNTIME_K1 || !environment.BONZAI_RUNTIME_K2) {
    throw new BonzaiRuntimeValidationInputError({
      message: "BONZAI_RUNTIME_K1 and BONZAI_RUNTIME_K2 must be injected out-of-band.",
    });
  }
  if (environment.BONZAI_RUNTIME_K1 === environment.BONZAI_RUNTIME_K2) {
    throw new BonzaiRuntimeValidationInputError({
      message: "BONZAI_RUNTIME_K1 and BONZAI_RUNTIME_K2 must be distinct test credentials.",
    });
  }
  if (input.includeCrossScopeTest && !environment.BONZAI_RUNTIME_CROSS_SCOPE_KEY) {
    throw new BonzaiRuntimeValidationInputError({
      message: "E7 requires BONZAI_RUNTIME_CROSS_SCOPE_KEY to be injected out-of-band.",
    });
  }
}

/**
 * Mirror of `ClaudeAdapter.turnStatusFromResult` (`ClaudeAdapter.ts:997`) and its
 * `isInterruptedResult`/`resultErrorsText` helpers (`:300-319`). It keys only on
 * `subtype`, so a result with `subtype: "success"` is "completed" even when
 * `is_error` is true — that gap is the finding this harness recorded.
 *
 * Those helpers are module-private, so this is a copy rather than a call, and
 * nothing pins the two together. If production changes, update this and the tests
 * below that enumerate its behavior. Fixing the `is_error` gap in production will
 * invalidate this mirror by design.
 */
export function productionTurnStatusFromResult(result: {
  readonly subtype: string;
  readonly isError: boolean;
  readonly errors: readonly string[];
}): ProductionTurnStatus {
  if (result.subtype === "success") {
    return "completed";
  }
  const errors = result.errors.join(" ").toLowerCase();
  if (
    errors.includes("interrupt") ||
    (result.subtype === "error_during_execution" &&
      !result.isError &&
      (errors.includes("request was aborted") ||
        errors.includes("interrupted by user") ||
        errors.includes("aborted")))
  ) {
    return "interrupted";
  }
  if (errors.includes("cancel")) {
    return "cancelled";
  }
  return "failed";
}

export function t3ProjectionForObservation(input: {
  readonly terminalResult?:
    | { readonly subtype: string; readonly isError: boolean; readonly errors: readonly string[] }
    | undefined;
  readonly caughtException?: { readonly message: string } | undefined;
  readonly assistantErrors?: readonly string[] | undefined;
}): typeof T3Projection.Type {
  const productionTurnStatus = input.terminalResult
    ? productionTurnStatusFromResult(input.terminalResult)
    : "none";
  // Production only emits a runtime error from the result path when the derived
  // status is "failed"; anything else leaves `lastError` to the stream-exit path.
  const resultPathEmitsError = productionTurnStatus === "failed";
  // Any `is_error` result proves production would mask *some* failure as completed;
  // only an assistant auth error proves the cause was authorization. Keeping these
  // separate stops a quota or transport fault being misfiled as an auth finding.
  const errorMaskedAsCompleted =
    input.terminalResult?.isError === true && productionTurnStatus === "completed";
  const authSignalled = (input.assistantErrors ?? []).some((error) =>
    error.toLowerCase().includes("auth"),
  );
  const authFailureMaskedAsCompleted = authSignalled && productionTurnStatus === "completed";
  const base = {
    productionTurnStatus,
    errorMaskedAsCompleted,
    authFailureMaskedAsCompleted,
  } as const;

  if (resultPathEmitsError && input.caughtException) {
    return {
      path: "result-then-stream-exception",
      lastError: "Claude runtime stream failed.",
      ...base,
      threadErrorBannerActionable: "not-reviewed",
    };
  }
  if (resultPathEmitsError) {
    return {
      path: "result-message",
      lastError: input.terminalResult?.errors[0] ?? "Claude turn failed.",
      ...base,
      threadErrorBannerActionable: "not-reviewed",
    };
  }
  if (input.caughtException) {
    return {
      path: "stream-exception",
      lastError: "Claude runtime stream failed.",
      ...base,
      threadErrorBannerActionable: "not-reviewed",
    };
  }
  return { path: "none", ...base, threadErrorBannerActionable: "not-reviewed" };
}

export interface ResumeDecisionInput {
  readonly e0?: BonzaiRuntimeObservation | undefined;
  readonly e4?: BonzaiRuntimeObservation | undefined;
  readonly e5?: BonzaiRuntimeObservation | undefined;
  readonly e6?: BonzaiRuntimeObservation | undefined;
  readonly e7?: BonzaiRuntimeObservation | undefined;
}

function successfulContinuity(
  observation: BonzaiRuntimeObservation | undefined,
  requireResume: boolean,
): boolean {
  if (!observation || observation.classification !== "success" || !observation.markerObserved) {
    return false;
  }
  if (!requireResume) return true;
  return observation.markerResumed === true && observation.sessionIdMatchesRequested === true;
}

export function deriveResumeDecision(input: ResumeDecisionInput): typeof ResumeDecisionRecord.Type {
  if (input.e7?.markerResumed === true) {
    return {
      value: "security-review-required",
      rationale:
        "A separately scoped credential observed the E4 marker; stop testing and escalate.",
      phase3ContinuityBehavior: "start-fresh-session",
    };
  }

  const e0Contaminated =
    input.e0?.classification === "success" ||
    input.e0?.messages.some(
      (message) => message.apiKeySource !== undefined && message.apiKeySource !== "none",
    ) === true;
  if (e0Contaminated) {
    return {
      value: "ambiguous",
      rationale: "E0 detected an unexpected credential source in the isolated context.",
      phase3ContinuityBehavior: "start-fresh-session",
    };
  }
  if (!successfulContinuity(input.e4, false) || !successfulContinuity(input.e5, true)) {
    return {
      value: "ambiguous",
      rationale: "E4 creation or the E5 same-key resume control did not prove marker continuity.",
      phase3ContinuityBehavior: "start-fresh-session",
    };
  }
  // `unsupported` is reserved for a *clear* rejection of replacement-key resume.
  // Anything that only proves "the request never got a conclusive gateway answer"
  // is ambiguous, per the plan's decision rule and the operator runbook. A masked
  // authorization failure or a server-side result error says nothing about whether
  // resume itself is supported, so it must not be recorded as unsupported.
  if (
    !input.e6 ||
    INCONCLUSIVE_E6_CLASSIFICATIONS.has(input.e6.classification) ||
    input.e6.t3Projection.authFailureMaskedAsCompleted ||
    input.e6.assistantErrors.some((error) => error.toLowerCase().includes("auth"))
  ) {
    return {
      value: "ambiguous",
      rationale:
        "E6 did not produce a conclusive gateway result after the controls passed: the credential was rejected, the stream failed, or no terminal result arrived. This says nothing about whether replacement-key resume is supported.",
      phase3ContinuityBehavior: "start-fresh-session",
    };
  }
  if (successfulContinuity(input.e6, true)) {
    return {
      value: "supported",
      rationale:
        "E6 returned the requested E4 session ID and recovered the marker under the approved replacement credential. Conversation state lives in the local transcript rather than at the gateway, so the credential authorizes each new request instead of the session itself. Resume therefore re-sends prior context under the new credential: safe for same-context rotation, but a key change that represents a different billing context should start a fresh session.",
      phase3ContinuityBehavior: "preserve-resume-for-validated-scope",
    };
  }
  return {
    value: "unsupported",
    rationale:
      "E6 was authorized and returned a conclusive turn, but did not preserve the E4 session ID and marker. Replacement-key resume is therefore not supported for this scope.",
    phase3ContinuityBehavior: "start-fresh-session",
  };
}

function purposeForExperiment(id: ExperimentId): string {
  switch (id) {
    case "E0":
      // Deliberately identical to E1. E0 is the contamination gate whose success
      // forces an ambiguous decision; E1 is the recorded missing-token shape. Kept
      // separate so a contaminated environment cannot be mistaken for evidence.
      return "Detect saved-login or credential contamination in isolated state.";
    case "E1":
      return "Record missing-token SDK termination behavior.";
    case "E2":
      return "Record explicitly empty-token SDK termination behavior.";
    case "E3":
      return "Record synthetic invalid-token SDK termination behavior.";
    case "E4":
      return "Create a short K1 session containing the nonsecret marker.";
    case "E5":
      return "Control: resume E4 with K1 and recover the marker.";
    case "E6":
      return "Resume E4 with approved replacement K2 and recover the marker.";
    case "E7":
      return "Optional separately authorized cross-scope isolation check.";
  }
}

function sdkMessageText(message: SDKMessage): string {
  if (message.type === "assistant") {
    return message.message.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n");
  }
  if (message.type === "result" && message.subtype === "success") {
    return message.result;
  }
  return "";
}

function summarizeSdkMessage(
  message: SDKMessage,
  sequence: number,
  marker: string | undefined,
  secrets: readonly string[],
  sensitivePaths: readonly string[],
): typeof SdkMessageSummary.Type {
  const subtype =
    "subtype" in message && typeof message.subtype === "string" ? message.subtype : undefined;
  const apiKeySource =
    message.type === "system" && message.subtype === "init"
      ? String(message.apiKeySource)
      : undefined;
  // SDK error strings can embed gateway prose and absolute paths, so this field is
  // redacted like every other free-text value that reaches the report.
  const assistantError =
    message.type === "assistant" && message.error !== undefined
      ? redactSensitiveText(message.error, secrets, sensitivePaths)
      : undefined;
  const assistantContainsMarker =
    message.type === "assistant" && marker !== undefined
      ? sdkMessageText(message).includes(marker)
      : undefined;
  return {
    sequence,
    type: message.type,
    ...(subtype ? { subtype } : {}),
    ...(typeof message.session_id === "string" ? { sessionId: message.session_id } : {}),
    ...(apiKeySource ? { apiKeySource } : {}),
    ...(assistantError ? { assistantError } : {}),
    ...(assistantContainsMarker !== undefined ? { assistantContainsMarker } : {}),
  };
}

function normalizeTerminalResult(
  result: SDKResultMessage,
  marker: string | undefined,
  secrets: readonly string[],
  sensitivePaths: readonly string[],
): typeof TerminalResult.Type {
  return {
    subtype: result.subtype,
    isError: result.is_error,
    errors:
      result.subtype === "success"
        ? []
        : result.errors.map((error) => redactSensitiveText(error, secrets, sensitivePaths)),
    sessionId: result.session_id,
    stopReason: result.stop_reason,
    containsMarker: marker !== undefined && sdkMessageText(result).includes(marker),
  };
}

function classifyObservation(input: {
  readonly timedOut: boolean;
  readonly terminalResult: typeof TerminalResult.Type | undefined;
  readonly caughtException: typeof CaughtException.Type | undefined;
}): ResultClassification {
  if (input.timedOut) return "timeout";
  if (input.terminalResult && input.caughtException) return "result-then-exception";
  if (input.terminalResult?.subtype === "success") return "success";
  if (input.terminalResult) return "sdk-result-error";
  if (input.caughtException) return "stream-exception";
  return "no-terminal-result";
}

interface RunExperimentInput {
  readonly id: ExperimentId;
  readonly credentialLabel: CredentialLabel;
  readonly credentialMode: CredentialMode;
  readonly credentialValue?: string | undefined;
  readonly baseUrl: string;
  readonly cwd: string;
  readonly configDir: string;
  /** E4's paths. Every resume case must run in the same ones or its result is meaningless. */
  readonly controlCwd: string;
  readonly controlConfigDir: string;
  readonly marker?: string | undefined;
  readonly resume?: string | undefined;
  readonly prompt: string;
  readonly model?: string | undefined;
  readonly secrets: readonly string[];
  readonly timeoutMs: number;
}

async function runExperiment(input: RunExperimentInput): Promise<BonzaiRuntimeObservation> {
  const environment = buildBonzaiChildEnvironment({
    parentEnvironment: NodeProcess.env,
    baseUrl: input.baseUrl,
    configDir: input.configDir,
    credentialMode: input.credentialMode,
    credential: input.credentialValue,
  });
  const messages: Array<typeof SdkMessageSummary.Type> = [];
  let terminalResult: typeof TerminalResult.Type | undefined;
  let caughtException: typeof CaughtException.Type | undefined;
  let queryRuntime: Query | undefined;
  let timedOut = false;
  const abortController = new AbortController();
  // @effect-diagnostics-next-line globalTimers:off - The standalone SDK stream needs a hard wall-clock abort.
  const timeout = NodeTimers.setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, input.timeoutMs);
  const sensitivePaths = [input.cwd, input.configDir, NodeOS.homedir()];

  try {
    queryRuntime = query({
      prompt: input.prompt,
      options: {
        cwd: input.cwd,
        env: environment,
        settingSources: [],
        tools: [],
        mcpServers: {},
        maxTurns: CASE_MAX_TURNS,
        maxBudgetUsd: CASE_MAX_BUDGET_USD,
        abortController,
        ...(input.model ? { model: input.model } : {}),
        persistSession: true,
        promptSuggestions: false,
        ...(input.resume ? { resume: input.resume } : {}),
      },
    });

    for await (const message of queryRuntime) {
      messages.push(
        summarizeSdkMessage(message, messages.length, input.marker, input.secrets, sensitivePaths),
      );
      if (message.type === "result") {
        terminalResult = normalizeTerminalResult(
          message,
          input.marker,
          input.secrets,
          sensitivePaths,
        );
      }
    }
  } catch (cause) {
    caughtException = {
      name: cause instanceof Error ? cause.name : "UnknownError",
      message: redactSensitiveText(
        cause instanceof Error ? cause.message : String(cause),
        input.secrets,
        sensitivePaths,
      ),
    };
  } finally {
    NodeTimers.clearTimeout(timeout);
    queryRuntime?.close();
  }

  const emittedSessionId =
    terminalResult?.sessionId ??
    messages.findLast((message) => message.sessionId !== undefined)?.sessionId;
  const markerObserved =
    terminalResult?.containsMarker === true ||
    messages.some((message) => message.assistantContainsMarker === true);
  const apiRetryCount = messages.filter((message) => message.subtype === "api_retry").length;
  const assistantErrors = [
    ...new Set(
      messages.flatMap((message) => (message.assistantError ? [message.assistantError] : [])),
    ),
  ];
  const classification = classifyObservation({ timedOut, terminalResult, caughtException });
  const status: ObservationStatus = timedOut
    ? "timeout"
    : caughtException && !terminalResult
      ? "process-error"
      : "completed";

  return {
    id: input.id,
    credential: input.credentialLabel,
    purpose: purposeForExperiment(input.id),
    status,
    classification,
    credentialPresence: environmentPresence(environment),
    cwdLabel: "isolated-cwd",
    configDirLabel: "isolated-claude-config",
    // Compared as resolved real paths, not as the strings passed in. A same-string
    // comparison could not fail; this can, if a case ever runs against a different
    // directory, a moved temp root, or a symlink that resolves elsewhere — which is
    // exactly the condition that would invalidate E5/E6 transcript continuity.
    cwdMatchesControl: realPathsMatch(input.cwd, input.controlCwd),
    configDirMatchesControl: realPathsMatch(input.configDir, input.controlConfigDir),
    messages,
    apiRetryCount,
    assistantErrors,
    ...(terminalResult ? { terminalResult } : {}),
    ...(caughtException ? { caughtException } : {}),
    ...(input.resume ? { requestedSessionId: input.resume } : {}),
    ...(emittedSessionId ? { emittedSessionId } : {}),
    ...(input.resume
      ? {
          sessionIdMatchesRequested: emittedSessionId === input.resume,
          markerResumed: markerObserved,
        }
      : {}),
    markerExpected: input.marker !== undefined,
    markerObserved,
    t3Projection: t3ProjectionForObservation({
      terminalResult,
      caughtException,
      assistantErrors,
    }),
    timeoutMs: input.timeoutMs,
  };
}

function skippedObservation(input: {
  readonly id: ExperimentId;
  readonly credential: CredentialLabel;
  readonly reason: string;
  readonly requestedSessionId?: string | undefined;
}): BonzaiRuntimeObservation {
  return {
    id: input.id,
    credential: input.credential,
    purpose: purposeForExperiment(input.id),
    status: "skipped",
    classification: "skipped",
    credentialPresence: {
      anthropicBaseUrl: false,
      anthropicAuthToken: false,
      anthropicApiKey: false,
      claudeConfigDir: false,
    },
    cwdLabel: "isolated-cwd",
    configDirLabel: "isolated-claude-config",
    cwdMatchesControl: true,
    configDirMatchesControl: true,
    messages: [],
    apiRetryCount: 0,
    assistantErrors: [],
    ...(input.requestedSessionId ? { requestedSessionId: input.requestedSessionId } : {}),
    markerExpected: input.id === "E5" || input.id === "E6" || input.id === "E7",
    markerObserved: false,
    ...(input.id === "E5" || input.id === "E6" || input.id === "E7"
      ? { markerResumed: false }
      : {}),
    t3Projection: {
      path: "none",
      productionTurnStatus: "none",
      errorMaskedAsCompleted: false,
      authFailureMaskedAsCompleted: false,
      threadErrorBannerActionable: "not-reviewed",
    },
    timeoutMs: DEFAULT_CASE_TIMEOUT_MS,
    skippedReason: input.reason,
  };
}

/** Removes the isolated state and reports whether it actually went away. */
function removeTemporaryState(tempRoot: string): boolean {
  try {
    NodeFS.rmSync(tempRoot, { recursive: true, force: true });
    return !NodeFS.existsSync(tempRoot);
  } catch {
    return false;
  }
}

function observationById(
  observations: readonly BonzaiRuntimeObservation[],
  id: ExperimentId,
): BonzaiRuntimeObservation | undefined {
  return observations.find((observation) => observation.id === id);
}

function readPnpmVersion(): string {
  return NodeProcess.env.npm_config_user_agent?.match(/pnpm\/([^\s]+)/u)?.[1] ?? UNKNOWN_PROVENANCE;
}

/**
 * True when both paths resolve to the same real location. Resolution failure counts
 * as a mismatch: an unreadable transcript directory invalidates resume continuity
 * just as surely as a different one.
 */
function realPathsMatch(left: string, right: string): boolean {
  try {
    return NodeFS.realpathSync(left) === NodeFS.realpathSync(right);
  } catch {
    return false;
  }
}

/** Walks up from `startDirectory` looking for `fileName`, bounded by `maxDepth`. */
function findNearestFile(
  startDirectory: string,
  fileName: string,
  maxDepth: number,
): string | undefined {
  let directory = startDirectory;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const candidate = NodePath.join(directory, fileName);
    if (NodeFS.existsSync(candidate)) return candidate;
    const parent = NodePath.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

/**
 * Provenance is measured from the installed tree, never asserted. `package.json`
 * pins a caret range, so a routine update would otherwise leave the report
 * claiming a version it did not exercise.
 */
export function readSdkProvenance(): {
  readonly agentSdkVersion: string;
  readonly bundledClaudeCodeVersion: string;
} {
  try {
    // The SDK's `exports` map does not expose `./package.json`, so resolve its entry
    // point instead and walk up to the manifest shipped alongside it.
    const entryPath = NodeURL.fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
    const manifestPath = findNearestFile(NodePath.dirname(entryPath), "package.json", 4);
    if (manifestPath === undefined) {
      return {
        agentSdkVersion: UNKNOWN_PROVENANCE,
        bundledClaudeCodeVersion: UNKNOWN_PROVENANCE,
      };
    }
    const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as {
      readonly version?: unknown;
      readonly claudeCodeVersion?: unknown;
    };
    return {
      agentSdkVersion: typeof manifest.version === "string" ? manifest.version : UNKNOWN_PROVENANCE,
      bundledClaudeCodeVersion:
        typeof manifest.claudeCodeVersion === "string"
          ? manifest.claudeCodeVersion
          : UNKNOWN_PROVENANCE,
    };
  } catch {
    return {
      agentSdkVersion: UNKNOWN_PROVENANCE,
      bundledClaudeCodeVersion: UNKNOWN_PROVENANCE,
    };
  }
}

/**
 * Resolves `--output` against the workspace root rather than `process.cwd()`.
 * `pnpm --filter t3 run` executes with cwd set to `apps/server`, so the runbook's
 * repo-root-relative path would otherwise land in a directory the root `.gitignore`
 * does not cover — writing evidence somewhere it could be committed.
 */
export function resolveOutputPath(output: string, scriptDirectory: string): string {
  if (NodePath.isAbsolute(output)) return output;
  const lockfile = findNearestFile(scriptDirectory, "pnpm-lock.yaml", 6);
  if (lockfile === undefined) {
    // Falling back to process.cwd() here would silently reinstate the exact bug this
    // function exists to prevent: evidence written outside the ignored directory.
    throw new BonzaiRuntimeValidationInputError({
      message:
        "Could not locate the workspace root to resolve --output. Pass an absolute --output path.",
    });
  }
  return NodePath.resolve(NodePath.dirname(lockfile), output);
}

/** Reads `lockfileVersion` from the workspace lockfile, walking up from this script. */
export function readLockfileVersion(): string {
  const lockfile = findNearestFile(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "pnpm-lock.yaml",
    6,
  );
  if (lockfile === undefined) return UNKNOWN_PROVENANCE;
  const match = NodeFS.readFileSync(lockfile, "utf8").match(/^lockfileVersion:\s*'?([^'\s]+)'?/mu);
  return match?.[1] ?? UNKNOWN_PROVENANCE;
}

export async function encodeAndValidateBonzaiRuntimeReport(
  report: BonzaiRuntimeReport,
  secretSentinels: readonly string[],
): Promise<string> {
  const encoded = await Effect.runPromise(encodeBonzaiRuntimeReport(report));
  assertNoSecretSentinels(encoded, secretSentinels);
  return encoded;
}

export const runBonzaiRuntimeValidation = Effect.fn("runBonzaiRuntimeValidation")(function* (
  rawInput: BonzaiRuntimeValidationInput,
) {
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  const input = yield* Effect.try({
    try: () => validateBonzaiRuntimeInput(rawInput),
    catch: (cause) =>
      isBonzaiRuntimeValidationInputError(cause)
        ? cause
        : new BonzaiRuntimeValidationInputError({ message: String(cause) }),
  });

  const secretEnvironment: BonzaiRuntimeSecretEnvironment = {
    BONZAI_RUNTIME_K1: NodeProcess.env.BONZAI_RUNTIME_K1,
    BONZAI_RUNTIME_K2: NodeProcess.env.BONZAI_RUNTIME_K2,
    BONZAI_RUNTIME_CROSS_SCOPE_KEY: NodeProcess.env.BONZAI_RUNTIME_CROSS_SCOPE_KEY,
  };
  yield* Effect.try({
    try: () => validateBonzaiRuntimeSecrets(input, secretEnvironment),
    catch: (cause) =>
      isBonzaiRuntimeValidationInputError(cause)
        ? cause
        : new BonzaiRuntimeValidationInputError({ message: String(cause) }),
  });

  const k1 = secretEnvironment.BONZAI_RUNTIME_K1 as string;
  const k2 = secretEnvironment.BONZAI_RUNTIME_K2 as string;
  const crossScopeKey = secretEnvironment.BONZAI_RUNTIME_CROSS_SCOPE_KEY;
  const caseTimeoutMs = rawInput.caseTimeoutMs ?? DEFAULT_CASE_TIMEOUT_MS;
  const sdkProvenance = readSdkProvenance();
  const invalidToken = `${INVALID_TOKEN_PREFIX}-${NodeCrypto.randomUUID()}`;
  const marker = `BONZAI_RUNTIME_MARKER_${NodeCrypto.randomUUID()}`;
  const secretSentinels = [k1, k2, invalidToken, ...(crossScopeKey ? [crossScopeKey] : [])];
  const tempRoot = yield* Effect.try({
    try: () => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bonzai-runtime-"));
      NodeFS.chmodSync(root, 0o700);
      return root;
    },
    catch: (cause) =>
      new BonzaiRuntimeValidationWriteError({
        message: "Failed to create isolated Bonzai validation state.",
        cause,
      }),
  });
  const cwd = NodePath.join(tempRoot, "cwd");
  const configDir = NodePath.join(tempRoot, "claude-config");

  return yield* Effect.tryPromise({
    try: async () => {
      try {
        NodeFS.mkdirSync(cwd, { recursive: true, mode: 0o700 });
        NodeFS.mkdirSync(configDir, { recursive: true, mode: 0o700 });

        const observations: BonzaiRuntimeObservation[] = [];
        const fixedAuthPrompt = "Reply with exactly: BONZAI_RUNTIME_AUTH_PROBE";
        observations.push(
          await runExperiment({
            id: "E0",
            credentialLabel: "none",
            credentialMode: "absent",
            baseUrl: input.baseUrl,
            cwd,
            configDir,
            controlCwd: cwd,
            controlConfigDir: configDir,
            prompt: fixedAuthPrompt,
            model: input.model,
            secrets: secretSentinels,
            timeoutMs: caseTimeoutMs,
          }),
        );
        observations.push(
          await runExperiment({
            id: "E1",
            credentialLabel: "none",
            credentialMode: "absent",
            baseUrl: input.baseUrl,
            cwd,
            configDir,
            controlCwd: cwd,
            controlConfigDir: configDir,
            prompt: fixedAuthPrompt,
            model: input.model,
            secrets: secretSentinels,
            timeoutMs: caseTimeoutMs,
          }),
        );
        observations.push(
          await runExperiment({
            id: "E2",
            credentialLabel: "empty",
            credentialMode: "empty",
            baseUrl: input.baseUrl,
            cwd,
            configDir,
            controlCwd: cwd,
            controlConfigDir: configDir,
            prompt: fixedAuthPrompt,
            model: input.model,
            secrets: secretSentinels,
            timeoutMs: caseTimeoutMs,
          }),
        );
        observations.push(
          await runExperiment({
            id: "E3",
            credentialLabel: "invalid-synthetic",
            credentialMode: "invalid",
            credentialValue: invalidToken,
            baseUrl: input.baseUrl,
            cwd,
            configDir,
            controlCwd: cwd,
            controlConfigDir: configDir,
            prompt: fixedAuthPrompt,
            model: input.model,
            secrets: secretSentinels,
            timeoutMs: caseTimeoutMs,
          }),
        );

        const e4 = await runExperiment({
          id: "E4",
          credentialLabel: "K1",
          credentialMode: "K1",
          credentialValue: k1,
          baseUrl: input.baseUrl,
          cwd,
          configDir,
          controlCwd: cwd,
          controlConfigDir: configDir,
          marker,
          prompt: `Remember this nonsecret validation marker and reply with it exactly: ${marker}`,
          model: input.model,
          secrets: secretSentinels,
          timeoutMs: caseTimeoutMs,
        });
        observations.push(e4);

        const e4Ready =
          e4.classification === "success" && e4.markerObserved && e4.emittedSessionId !== undefined;
        const e5 = e4Ready
          ? await runExperiment({
              id: "E5",
              credentialLabel: "K1",
              credentialMode: "K1",
              credentialValue: k1,
              baseUrl: input.baseUrl,
              cwd,
              configDir,
              controlCwd: cwd,
              controlConfigDir: configDir,
              marker,
              resume: e4.emittedSessionId,
              prompt: "Reply with the exact nonsecret validation marker from the preceding turn.",
              model: input.model,
              secrets: secretSentinels,
              timeoutMs: caseTimeoutMs,
            })
          : skippedObservation({
              id: "E5",
              credential: "K1",
              reason: "E4 did not return a successful marked session with a durable session ID.",
              requestedSessionId: e4.emittedSessionId,
            });
        observations.push(e5);

        const e5Ready = successfulContinuity(e5, true);
        const e6 = e5Ready
          ? await runExperiment({
              id: "E6",
              credentialLabel: "K2",
              credentialMode: "K2",
              credentialValue: k2,
              baseUrl: input.baseUrl,
              cwd,
              configDir,
              controlCwd: cwd,
              controlConfigDir: configDir,
              marker,
              resume: e4.emittedSessionId,
              prompt: "Reply with the exact nonsecret validation marker from the original turn.",
              model: input.model,
              secrets: secretSentinels,
              timeoutMs: caseTimeoutMs,
            })
          : skippedObservation({
              id: "E6",
              credential: "K2",
              reason: "E5 did not prove same-key resume and marker continuity.",
              requestedSessionId: e4.emittedSessionId,
            });
        observations.push(e6);

        const e7 =
          input.includeCrossScopeTest && crossScopeKey && e5Ready
            ? await runExperiment({
                id: "E7",
                credentialLabel: "cross-scope",
                credentialMode: "cross-scope",
                credentialValue: crossScopeKey,
                baseUrl: input.baseUrl,
                cwd,
                configDir,
                controlCwd: cwd,
                controlConfigDir: configDir,
                marker,
                resume: e4.emittedSessionId,
                prompt: "Reply with the exact nonsecret validation marker from the original turn.",
                model: input.model,
                secrets: secretSentinels,
                timeoutMs: caseTimeoutMs,
              })
            : skippedObservation({
                id: "E7",
                credential: "cross-scope",
                reason: input.includeCrossScopeTest
                  ? "E5 did not prove the control required for E7."
                  : "Excluded by default; requires separate written authorization and acknowledgement.",
                requestedSessionId: e4.emittedSessionId,
              });
        observations.push(e7);

        const draftReport: BonzaiRuntimeReport = {
          schemaVersion: REPORT_SCHEMA_VERSION,
          // @effect-diagnostics-next-line globalDateInEffect:off - Timestamp is evidence metadata inside a Promise-based live runner.
          generatedAt: new Date().toISOString(),
          runtime: {
            ...sdkProvenance,
            nodeVersion: NodeProcess.version,
            pnpmVersion: readPnpmVersion(),
            lockfileVersion: readLockfileVersion(),
            platform,
            architecture,
          },
          gateway: {
            approvedOrigin: input.gatewayUrl.origin,
            approvedBasePath: input.gatewayUrl.pathname,
            credentialScope: input.credentialScope,
            approvalReference: input.approvalReference,
            ...(input.model ? { requestedModel: input.model } : {}),
          },
          isolation: {
            cwdLabel: "isolated-cwd",
            configDirLabel: "isolated-claude-config",
            // Replaced below with the observed cleanup outcome.
            temporaryStateRemovedAfterRun: false,
            inheritedEnvironmentAllowlist: [...SAFE_ENVIRONMENT_NAMES],
          },
          observations,
          decision: deriveResumeDecision({
            e0: observationById(observations, "E0"),
            e4,
            e5,
            e6,
            e7,
          }),
          reviewerNotes: "",
        };

        // Cleanup happens in the `finally` below, after the report is encoded, so it
        // cannot be observed here. Remove the temporary root now and record the real
        // outcome; the `finally` remains as a belt-and-braces guard for early exits.
        const cleanupSucceeded = removeTemporaryState(tempRoot);
        const report: BonzaiRuntimeReport = {
          ...draftReport,
          isolation: { ...draftReport.isolation, temporaryStateRemovedAfterRun: cleanupSucceeded },
        };

        const encoded = await encodeAndValidateBonzaiRuntimeReport(report, secretSentinels);
        const output = resolveOutputPath(
          input.output,
          NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
        );
        const outputDirectory = NodePath.dirname(output);
        // `mkdirSync` returns the first path it created, or undefined when the
        // directory already existed. Only tighten permissions on a directory the
        // probe owns; re-permissioning a pre-existing one is an unrequested side
        // effect on a path we were merely pointed at.
        const createdDirectory = NodeFS.mkdirSync(outputDirectory, {
          recursive: true,
          mode: 0o700,
        });
        if (createdDirectory !== undefined) {
          NodeFS.chmodSync(createdDirectory, 0o700);
        }
        NodeFS.writeFileSync(output, encoded, { encoding: "utf8", mode: 0o600, flag: "wx" });
        return { output, report, encoded };
      } finally {
        NodeFS.rmSync(tempRoot, { recursive: true, force: true });
      }
    },
    catch: (cause) =>
      isBonzaiRuntimeValidationLeakError(cause) ||
      isBonzaiRuntimeValidationInputError(cause) ||
      isBonzaiRuntimeValidationWriteError(cause)
        ? cause
        : new BonzaiRuntimeValidationWriteError({
            message: "Bonzai runtime validation failed before evidence was safely written.",
            // `runMain` prints the cause, and terminals scroll into logs and
            // screenshots. Redact before attaching so the leak guard's protection
            // is not limited to the evidence file.
            cause: redactSensitiveText(
              cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
              secretSentinels,
              [tempRoot, NodeOS.homedir()],
            ),
          }),
  });
});

export const bonzaiRuntimeValidationCommand = Command.make(
  "bonzai-runtime-validation",
  {
    acknowledgeLiveGatewayTest: Flag.boolean("ack-live-gateway-test").pipe(Flag.withDefault(false)),
    baseUrl: Flag.string("base-url"),
    output: Flag.string("output"),
    credentialScope: Flag.string("credential-scope"),
    approvalReference: Flag.string("approval-reference"),
    model: Flag.string("model").pipe(Flag.optional),
    caseTimeoutMs: Flag.integer("case-timeout-ms").pipe(Flag.optional),
    includeCrossScopeTest: Flag.boolean("include-cross-scope-test").pipe(Flag.withDefault(false)),
    acknowledgeCrossScopeTest: Flag.boolean("ack-cross-scope-test").pipe(Flag.withDefault(false)),
    crossScopeApprovalReference: Flag.string("cross-scope-approval-reference").pipe(Flag.optional),
  },
  ({
    acknowledgeLiveGatewayTest,
    baseUrl,
    output,
    credentialScope,
    approvalReference,
    model,
    caseTimeoutMs,
    includeCrossScopeTest,
    acknowledgeCrossScopeTest,
    crossScopeApprovalReference,
  }) =>
    runBonzaiRuntimeValidation({
      acknowledgeLiveGatewayTest,
      baseUrl,
      output,
      credentialScope,
      approvalReference,
      model: model._tag === "Some" ? model.value : undefined,
      caseTimeoutMs: caseTimeoutMs._tag === "Some" ? caseTimeoutMs.value : undefined,
      includeCrossScopeTest,
      acknowledgeCrossScopeTest,
      crossScopeApprovalReference:
        crossScopeApprovalReference._tag === "Some" ? crossScopeApprovalReference.value : undefined,
    }).pipe(
      Effect.flatMap(({ output, report }) =>
        Console.log(
          `Bonzai runtime validation report written to ${output}\nDecision: ${report.decision.value}`,
        ),
      ),
    ),
).pipe(
  Command.withDescription(
    "Run the opt-in, redacted Bonzai Agent SDK runtime validation matrix. Credentials are read only from documented environment variables.",
  ),
);

if (import.meta.main) {
  // `pnpm --filter t3 run probe:bonzai-runtime -- --help` forwards the separator
  // itself as argv[2], which Effect CLI then reads as an unknown positional. Strip
  // only that exact leading form; every other invocation is untouched.
  if (NodeProcess.argv[2] === "--") NodeProcess.argv.splice(2, 1);
  Command.run(bonzaiRuntimeValidationCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
