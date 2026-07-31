import { describe, expect, it } from "vite-plus/test";

import {
  assertNoSecretSentinels,
  buildBonzaiChildEnvironment,
  decodeBonzaiRuntimeReport,
  deriveResumeDecision,
  encodeAndValidateBonzaiRuntimeReport,
  environmentPresence,
  redactSensitiveText,
  redactUnknown,
  productionTurnStatusFromResult,
  readLockfileVersion,
  readSdkProvenance,
  resolveOutputPath,
  t3ProjectionForObservation,
  validateBonzaiRuntimeInput,
  validateBonzaiRuntimeSecrets,
  type BonzaiRuntimeObservation,
  type BonzaiRuntimeReport,
} from "./bonzai-runtime-validation.ts";

const baseObservation = (
  id: BonzaiRuntimeObservation["id"],
  overrides: Partial<BonzaiRuntimeObservation> = {},
): BonzaiRuntimeObservation => ({
  id,
  credential: id === "E6" ? "K2" : "K1",
  purpose: "Synthetic unit-test observation.",
  status: "completed",
  classification: "success",
  credentialPresence: {
    anthropicBaseUrl: true,
    anthropicAuthToken: true,
    anthropicApiKey: false,
    claudeConfigDir: true,
  },
  cwdLabel: "isolated-cwd",
  configDirLabel: "isolated-claude-config",
  cwdMatchesControl: true,
  configDirMatchesControl: true,
  messages: [],
  apiRetryCount: 0,
  assistantErrors: [],
  emittedSessionId: "session-1",
  requestedSessionId: id === "E4" ? undefined : "session-1",
  sessionIdMatchesRequested: id === "E4" ? undefined : true,
  markerExpected: true,
  markerObserved: true,
  markerResumed: id === "E4" ? undefined : true,
  t3Projection: {
    path: "none",
    productionTurnStatus: "completed",
    errorMaskedAsCompleted: false,
    authFailureMaskedAsCompleted: false,
    threadErrorBannerActionable: "not-reviewed",
  },
  timeoutMs: 30_000,
  ...overrides,
});

const makeReport = (): BonzaiRuntimeReport => ({
  schemaVersion: "1",
  generatedAt: "2026-07-31T12:00:00.000Z",
  runtime: {
    agentSdkVersion: "0.3.170",
    bundledClaudeCodeVersion: "2.1.170",
    nodeVersion: "v24.13.1",
    pnpmVersion: "11.10.0",
    lockfileVersion: "9.0",
    platform: "darwin",
    architecture: "arm64",
  },
  gateway: {
    approvedOrigin: "https://bonzai.example",
    approvedBasePath: "/anthropic",
    credentialScope: "same-client-rotation",
    approvalReference: "SEC-1234",
  },
  isolation: {
    cwdLabel: "isolated-cwd",
    configDirLabel: "isolated-claude-config",
    temporaryStateRemovedAfterRun: true,
    inheritedEnvironmentAllowlist: ["PATH", "HOME"],
  },
  observations: [baseObservation("E4"), baseObservation("E5"), baseObservation("E6")],
  decision: {
    value: "supported",
    rationale: "Synthetic marker continuity was proven.",
    phase3ContinuityBehavior: "preserve-resume-for-validated-scope",
  },
  reviewerNotes: "",
});

describe("bonzai runtime validation invocation", () => {
  it("refuses live access before reading credentials", () => {
    expect(() =>
      validateBonzaiRuntimeInput({
        acknowledgeLiveGatewayTest: false,
        baseUrl: "https://bonzai.example/anthropic",
        output: "artifacts/bonzai-runtime-validation/run.json",
        credentialScope: "same-client-rotation",
        approvalReference: "SEC-1234",
      }),
    ).toThrow("Refusing live gateway access");
  });

  it("rejects credential-bearing base URLs and incomplete E7 authorization", () => {
    expect(() =>
      validateBonzaiRuntimeInput({
        acknowledgeLiveGatewayTest: true,
        baseUrl: "https://token@bonzai.example/anthropic",
        output: "run.json",
        credentialScope: "same-client-rotation",
        approvalReference: "SEC-1234",
      }),
    ).toThrow("must not contain credentials");

    expect(() =>
      validateBonzaiRuntimeInput({
        acknowledgeLiveGatewayTest: true,
        baseUrl: "https://bonzai.example/anthropic",
        output: "run.json",
        credentialScope: "same-client-rotation",
        approvalReference: "SEC-1234",
        includeCrossScopeTest: true,
      }),
    ).toThrow("E7 requires --ack-cross-scope-test");
  });

  it("rejects a case timeout that would abort every case on the next tick", () => {
    const base = {
      acknowledgeLiveGatewayTest: true,
      baseUrl: "https://bonzai.example/anthropic",
      output: "run.json",
      credentialScope: "same-client-rotation",
      approvalReference: "SEC-1234",
    };
    for (const caseTimeoutMs of [-1, 0, 900_000, Number.NaN]) {
      expect(() => validateBonzaiRuntimeInput({ ...base, caseTimeoutMs })).toThrow(
        "--case-timeout-ms must be between",
      );
    }
    expect(() => validateBonzaiRuntimeInput({ ...base, caseTimeoutMs: 30_000 })).not.toThrow();
  });

  it("requires distinct out-of-band K1 and K2 values", () => {
    expect(() =>
      validateBonzaiRuntimeSecrets(
        {
          acknowledgeLiveGatewayTest: true,
          baseUrl: "https://bonzai.example/anthropic",
          output: "run.json",
          credentialScope: "same-client-rotation",
          approvalReference: "SEC-1234",
        },
        { BONZAI_RUNTIME_K1: "same", BONZAI_RUNTIME_K2: "same" },
      ),
    ).toThrow("must be distinct");
  });
});

describe("bonzai runtime validation environment isolation", () => {
  it("copies only the allowlist and omits inherited Anthropic credentials", () => {
    const environment = buildBonzaiChildEnvironment({
      parentEnvironment: {
        PATH: "/bin",
        HOME: "/isolated-home",
        ANTHROPIC_AUTH_TOKEN: "inherited-auth",
        ANTHROPIC_API_KEY: "inherited-api-key",
        UNRELATED_SECRET: "do-not-copy",
      },
      baseUrl: "https://bonzai.example/anthropic",
      configDir: "/tmp/isolated-config",
      credentialMode: "absent",
    });

    expect(environment).toMatchObject({
      PATH: "/bin",
      HOME: "/isolated-home",
      ANTHROPIC_BASE_URL: "https://bonzai.example/anthropic",
      CLAUDE_CONFIG_DIR: "/tmp/isolated-config",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    expect(environment).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(environment).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(environment).not.toHaveProperty("UNRELATED_SECRET");
  });

  it("preserves explicit empty values and reports presence without values", () => {
    const environment = buildBonzaiChildEnvironment({
      parentEnvironment: { PATH: "/bin" },
      baseUrl: "https://bonzai.example/anthropic",
      configDir: "/tmp/isolated-config",
      credentialMode: "empty",
    });

    expect(environment.ANTHROPIC_AUTH_TOKEN).toBe("");
    expect(environment.ANTHROPIC_API_KEY).toBe("");
    expect(environmentPresence(environment)).toEqual({
      anthropicBaseUrl: true,
      anthropicAuthToken: false,
      anthropicApiKey: false,
      claudeConfigDir: true,
    });
    expect(JSON.stringify(environmentPresence(environment))).not.toContain("/bin");
  });
});

describe("bonzai runtime validation redaction", () => {
  it("redacts credentials in nested messages, URLs, paths, and authorization-like fields", () => {
    const k1 = "K1-fixture-secret-123456";
    const k2 = "K2-fixture-secret-654321";
    const invalid = "invalid-fixture-token-abcdef";
    const value = redactUnknown(
      {
        errors: [`Bearer ${k1}`, `https://bonzai.example/path?access_token=${k2}`],
        caughtException: { message: `token=${invalid} at /Users/test/.claude/config` },
        nested: { authorization: k1, api_key: k2 },
      },
      [k1, k2, invalid],
    );
    const encoded = JSON.stringify(value);

    expect(encoded).not.toContain(k1);
    expect(encoded).not.toContain(k2);
    expect(encoded).not.toContain(invalid);
    expect(encoded).not.toContain("/Users/test");
    expect(encoded).toContain("[REDACTED_CREDENTIAL]");
    expect(encoded).toContain("[REDACTED_PATH]");
  });

  it("redacts encoded token query values and explicit sensitive paths", () => {
    const secret = "K1 with spaces/and+symbols";
    const text = redactSensitiveText(
      `url=https://bonzai.example?token=${encodeURIComponent(secret)} path=/private/probe/root/result`,
      [secret],
      ["/private/probe/root"],
    );
    expect(text).not.toContain(encodeURIComponent(secret));
    expect(text).not.toContain("/private/probe/root");
  });

  it("rejects raw, URL-encoded, and base64 fixture sentinels", () => {
    const sentinel = "K2 fixture/sentinel";
    expect(() => assertNoSecretSentinels(`{"value":"${sentinel}"}`, [sentinel])).toThrow(
      "Report leak guard",
    );
    expect(() =>
      assertNoSecretSentinels(`{"value":"${encodeURIComponent(sentinel)}"}`, [sentinel]),
    ).toThrow("Report leak guard");
    expect(() =>
      assertNoSecretSentinels(`{"value":"${Buffer.from(sentinel).toString("base64")}"}`, [
        sentinel,
      ]),
    ).toThrow("Report leak guard");
  });
});

describe("bonzai runtime validation observation classification", () => {
  it("matches the production result-message projection", () => {
    expect(
      t3ProjectionForObservation({
        terminalResult: {
          subtype: "error_during_execution",
          isError: true,
          errors: ["authorization failed"],
        },
      }),
    ).toMatchObject({
      path: "result-message",
      lastError: "authorization failed",
      productionTurnStatus: "failed",
      authFailureMaskedAsCompleted: false,
    });
    expect(
      t3ProjectionForObservation({
        terminalResult: { subtype: "error_during_execution", isError: true, errors: [] },
      }).lastError,
    ).toBe("Claude turn failed.");
  });

  it("mirrors turnStatusFromResult, including its subtype-only behavior", () => {
    expect(productionTurnStatusFromResult({ subtype: "success", isError: true, errors: [] })).toBe(
      "completed",
    );
    expect(
      productionTurnStatusFromResult({
        subtype: "error_during_execution",
        isError: false,
        errors: ["Error: Request was aborted."],
      }),
    ).toBe("interrupted");
    expect(
      productionTurnStatusFromResult({
        subtype: "error_during_execution",
        isError: true,
        errors: ["user cancelled the turn"],
      }),
    ).toBe("cancelled");
    expect(
      productionTurnStatusFromResult({
        subtype: "error_max_turns",
        isError: true,
        errors: ["too many turns"],
      }),
    ).toBe("failed");
  });

  it("separates a masked error from a masked authorization failure", () => {
    // A quota or transport fault must not be filed as a credential finding.
    const quota = t3ProjectionForObservation({
      terminalResult: { subtype: "success", isError: true, errors: ["disk quota exceeded"] },
    });
    expect(quota.errorMaskedAsCompleted).toBe(true);
    expect(quota.authFailureMaskedAsCompleted).toBe(false);
  });

  it("matches assistant auth errors regardless of casing", () => {
    for (const assistantError of ["authentication_failed", "Authentication_Failed"]) {
      expect(
        t3ProjectionForObservation({
          terminalResult: { subtype: "success", isError: true, errors: [] },
          assistantErrors: [assistantError],
        }).authFailureMaskedAsCompleted,
      ).toBe(true);
    }
  });

  it("flags an authorization failure that production would report as completed", () => {
    // Observed live: no credential yields subtype "success" with is_error true plus
    // an assistant authentication_failed error, then the SDK throws.
    const projection = t3ProjectionForObservation({
      terminalResult: {
        subtype: "success",
        isError: true,
        errors: [],
      },
      caughtException: { message: "Not logged in" },
      assistantErrors: ["authentication_failed"],
    });

    expect(projection).toMatchObject({
      path: "stream-exception",
      lastError: "Claude runtime stream failed.",
      productionTurnStatus: "completed",
      authFailureMaskedAsCompleted: true,
    });
  });

  it("keeps stream exceptions separate and does not invent an HTTP status", () => {
    const projection = t3ProjectionForObservation({
      caughtException: { message: "transport closed" },
    });
    expect(projection).toMatchObject({
      path: "stream-exception",
      lastError: "Claude runtime stream failed.",
      productionTurnStatus: "none",
    });
    expect(JSON.stringify(projection)).not.toMatch(/\b(?:401|403)\b/u);
  });

  it("records a result followed by a stream exception as a distinct path", () => {
    expect(
      t3ProjectionForObservation({
        terminalResult: {
          subtype: "error_during_execution",
          isError: true,
          errors: ["gateway rejected"],
        },
        caughtException: { message: "stream closed" },
      }),
    ).toMatchObject({
      path: "result-then-stream-exception",
      lastError: "Claude runtime stream failed.",
    });
  });
});

describe("bonzai runtime validation resume decision", () => {
  it("supports replacement-key resume only after both controls and exact continuity", () => {
    expect(
      deriveResumeDecision({
        e4: baseObservation("E4"),
        e5: baseObservation("E5"),
        e6: baseObservation("E6"),
      }),
    ).toMatchObject({
      value: "supported",
      phase3ContinuityBehavior: "preserve-resume-for-validated-scope",
    });
  });

  it("classifies an authorized turn that lost the session as unsupported", () => {
    expect(
      deriveResumeDecision({
        e4: baseObservation("E4"),
        e5: baseObservation("E5"),
        e6: baseObservation("E6", {
          // Authorized and conclusive, but a fresh session rather than the requested one.
          classification: "success",
          markerObserved: false,
          markerResumed: false,
          sessionIdMatchesRequested: false,
          emittedSessionId: "session-2",
        }),
      }),
    ).toMatchObject({ value: "unsupported", phase3ContinuityBehavior: "start-fresh-session" });
  });

  it("does not record a rejected E6 credential as unsupported resume", () => {
    // A rejected credential says nothing about whether resume works. The plan and
    // runbook both reserve `unsupported` for a clear rejection of resume itself.
    for (const e6 of [
      baseObservation("E6", {
        classification: "result-then-exception",
        assistantErrors: ["authentication_failed"],
        markerObserved: false,
        markerResumed: false,
        t3Projection: {
          path: "stream-exception",
          lastError: "Claude runtime stream failed.",
          productionTurnStatus: "completed",
          errorMaskedAsCompleted: true,
          authFailureMaskedAsCompleted: true,
          threadErrorBannerActionable: "not-reviewed",
        },
      }),
      baseObservation("E6", {
        classification: "sdk-result-error",
        markerObserved: false,
        markerResumed: false,
      }),
      baseObservation("E6", { classification: "timeout", markerObserved: false }),
    ]) {
      const decision = deriveResumeDecision({
        e4: baseObservation("E4"),
        e5: baseObservation("E5"),
        e6,
      });
      expect(decision.value).toBe("ambiguous");
      expect(decision.phase3ContinuityBehavior).toBe("start-fresh-session");
    }
  });

  it("is ambiguous when isolation or the same-key control fails", () => {
    expect(
      deriveResumeDecision({
        e0: baseObservation("E0", {
          credential: "none",
          classification: "success",
        }),
        e4: baseObservation("E4"),
        e5: baseObservation("E5"),
        e6: baseObservation("E6"),
      }).value,
    ).toBe("ambiguous");
    expect(
      deriveResumeDecision({
        e4: baseObservation("E4"),
        e5: baseObservation("E5", { markerResumed: false }),
      }).value,
    ).toBe("ambiguous");
  });

  it("requires security review when cross-scope E7 exposes the marker", () => {
    expect(
      deriveResumeDecision({
        e4: baseObservation("E4"),
        e5: baseObservation("E5"),
        e6: baseObservation("E6"),
        e7: baseObservation("E7", { credential: "cross-scope" }),
      }),
    ).toMatchObject({
      value: "security-review-required",
      phase3ContinuityBehavior: "start-fresh-session",
    });
  });
});

describe("bonzai runtime validation output path", () => {
  // `pnpm --filter t3 run` sets cwd to apps/server, so a repo-root-relative path
  // from the runbook must still land at the repo root, where .gitignore covers it.
  it("resolves a relative output against the workspace root, not the cwd", () => {
    const resolved = resolveOutputPath(
      "artifacts/bonzai-runtime-validation/run.json",
      new URL(".", import.meta.url).pathname,
    );
    expect(resolved.endsWith("/artifacts/bonzai-runtime-validation/run.json")).toBe(true);
    expect(resolved).not.toContain("apps/server/artifacts");
  });

  it("fails closed instead of resolving against the cwd when no workspace root is found", () => {
    // Falling back to process.cwd() would silently reinstate the committable-evidence
    // bug this function exists to prevent, so absence of a lockfile must throw.
    expect(() => resolveOutputPath("artifacts/run.json", "/")).toThrow(
      "Pass an absolute --output path",
    );
  });

  it("leaves an absolute output path untouched", () => {
    expect(resolveOutputPath("/tmp/run.json", new URL(".", import.meta.url).pathname)).toBe(
      "/tmp/run.json",
    );
  });
});

describe("bonzai runtime validation provenance", () => {
  // Guards the review finding these fields were introduced for: they must be
  // measured from the installed tree, and must not silently degrade to "unknown".
  it("measures the installed SDK version rather than asserting one", () => {
    const provenance = readSdkProvenance();
    expect(provenance.agentSdkVersion).toMatch(/^\d+\.\d+\.\d+/u);
    expect(provenance.bundledClaudeCodeVersion).toMatch(/^\d+\.\d+\.\d+/u);
    expect(provenance.agentSdkVersion).not.toBe("unknown");
    expect(provenance.bundledClaudeCodeVersion).not.toBe("unknown");
  });

  it("reads lockfileVersion from the workspace lockfile", () => {
    const lockfileVersion = readLockfileVersion();
    expect(lockfileVersion).toMatch(/^\d+\.\d+$/u);
    expect(lockfileVersion).not.toBe("unknown");
  });
});

describe("bonzai runtime validation report schema", () => {
  it("round-trips through pretty JSON without fixture secrets", async () => {
    const report = makeReport();
    const encoded = await encodeAndValidateBonzaiRuntimeReport(report, [
      "K1-fixture",
      "K2-fixture",
    ]);
    const decoded = await import("effect/Effect").then(({ runPromise }) =>
      runPromise(decodeBonzaiRuntimeReport(JSON.parse(encoded))),
    );

    expect(decoded).toEqual(report);
    expect(encoded).not.toContain("K1-fixture");
    expect(encoded).not.toContain("K2-fixture");
  });
});
