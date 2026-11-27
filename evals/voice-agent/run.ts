#!/usr/bin/env node
// An eval script, not server code: it reads and writes files directly.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";

import {
  buildVoiceAgentInstructions,
  VOICE_AGENT_TOOLS,
  voiceAgentNote,
} from "../../apps/server/src/voiceAgent/voiceAgentPrompt.ts";
import { proxyConfig } from "../shared/proxy.ts";
import { postResponses } from "../shared/responses.ts";
import { cases, DEFAULT_TOOL_RESULTS, type Turn, type VoiceAgentEvalCase } from "./cases.ts";
import { grade, type RecordedCall } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", multiple: true },
    case: { type: "string", multiple: true },
    samples: { type: "string", default: "3" },
    concurrency: { type: "string", default: "6" },
    reasoning: { type: "string", default: "low" },
    baseline: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});
if (!values.out) throw new Error("Use --out <directory> --model <id> [--case <id>] [--dry-run].");
const outDirectory = values.out;
const dryRun = values["dry-run"];
const models = values.model ?? [];
if (!dryRun && models.length === 0) throw new Error("Pass --model <id>, or --dry-run.");
const unknownCases = (values.case ?? []).filter((id) => !cases.some((entry) => entry.id === id));
if (unknownCases.length > 0) throw new Error(`Unknown case: ${unknownCases.join(", ")}.`);
const selected = values.case ? cases.filter((entry) => values.case!.includes(entry.id)) : cases;

// The same four keys the realtime adapter sends; the Responses API takes the same tool shape.
const tools = VOICE_AGENT_TOOLS.map(({ name, description, parameters }) => ({
  type: "function",
  name,
  description,
  parameters,
}));
const decoders = new Map(VOICE_AGENT_TOOLS.map((tool) => [tool.name, tool.decode]));
const emptyInstructions = buildVoiceAgentInstructions({
  projectTitle: "",
  thread: null,
  agentsFile: "",
  claudeFile: "",
});
const toolsJson = JSON.stringify(tools);
const promptHash = NodeCrypto.createHash("sha256")
  .update(emptyInstructions + toolsJson)
  .digest("hex")
  .slice(0, 12);
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

const decodeArguments = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encodeRow = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeBaselineRow = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      case: Schema.String,
      model: Schema.String,
      pass: Schema.optional(Schema.Boolean),
    }),
  ),
);

const toInputItems = (turn: Turn, index: number): ReadonlyArray<unknown> => {
  if ("developer" in turn) return [{ role: "user", content: turn.developer }];
  if ("voice" in turn) return [{ role: "assistant", content: turn.voice }];
  // The server injects notes as a system message item.
  if ("note" in turn) return [{ role: "system", content: voiceAgentNote(turn.note) }];
  const callId = `call_${index}`;
  return [
    {
      type: "function_call",
      call_id: callId,
      name: turn.call,
      arguments: JSON.stringify(turn.arguments),
    },
    { type: "function_call_output", call_id: callId, output: turn.output },
  ];
};

const firstInput = (entry: VoiceAgentEvalCase): Array<unknown> => {
  const input: Array<unknown> = entry.history.flatMap(toInputItems);
  if (entry.says !== undefined) input.push({ role: "user", content: entry.says });
  return input;
};

const requestBody = (entry: VoiceAgentEvalCase, model: string, input: ReadonlyArray<unknown>) => ({
  model,
  instructions: buildVoiceAgentInstructions(entry.context),
  input,
  tools,
  reasoning: { effort: values.reasoning },
  store: false,
  include: ["reasoning.encrypted_content"],
});

const runSample = Effect.fn("evaluateVoiceAgent.sample")(function* (
  proxy: ReturnType<typeof proxyConfig>,
  entry: VoiceAgentEvalCase,
  model: string,
) {
  const input = firstInput(entry);
  const calls: Array<RecordedCall> = [];
  const spoken: Array<string> = [];
  let tokens = 0;
  for (let step = 0; step < 6; step++) {
    const response = yield* postResponses(proxy, requestBody(entry, model, input));
    tokens += response.usage?.total_tokens ?? 0;
    input.push(...response.output);
    for (const item of response.output) {
      if (item.type !== "message") continue;
      for (const part of item.content as Array<{ text?: string }>) {
        if (part.text) spoken.push(part.text);
      }
    }
    const stepCalls = response.output.filter((item) => item.type === "function_call");
    if (stepCalls.length === 0) break;
    for (const call of stepCalls) {
      const name = String(call.name);
      const json = String(call.arguments ?? "");
      const decode = decoders.get(name);
      calls.push({
        name,
        arguments: Option.getOrNull(decodeArguments(json)),
        valid: decode !== undefined && Option.isSome(decode(json)),
      });
      input.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: entry.results?.[name] ?? DEFAULT_TOOL_RESULTS[name] ?? '{"error":"Unknown tool."}',
      });
    }
  }
  const text = spoken.join(" ");
  return { ...grade(entry.expect, { calls, spoken: text }), calls, spoken: text, tokens };
});

NodeFS.mkdirSync(outDirectory, { recursive: true });
const header = `prompt ${promptHash}, ${bytes(emptyInstructions)} bytes of instructions, ${bytes(toolsJson)} bytes of tools`;

if (dryRun) {
  NodeFS.writeFileSync(
    NodePath.join(outDirectory, "requests.ndjson"),
    selected
      .map((entry) =>
        encodeRow({
          case: entry.id,
          request: requestBody(entry, models[0] ?? "<model>", firstInput(entry)),
        }),
      )
      .join("\n") + "\n",
  );
  process.stdout.write(`${header}\n${selected.length} requests written, no model called.\n`);
} else {
  const proxy = proxyConfig();
  const sampleSafely = (entry: VoiceAgentEvalCase, model: string, sample: number) =>
    runSample(proxy, entry, model).pipe(
      Effect.map((result) => ({ case: entry.id, kind: entry.kind, model, sample, ...result })),
      Effect.catchCause((cause) =>
        Effect.succeed({ case: entry.id, kind: entry.kind, model, sample, error: String(cause) }),
      ),
    );
  type Row = Effect.Success<ReturnType<typeof sampleSafely>>;

  const summary = await Effect.runPromise(
    Effect.gen(function* () {
      const samples = Number(values.samples);
      const rows: ReadonlyArray<Row> = yield* Effect.forEach(
        models.flatMap((model) =>
          selected.flatMap((entry) =>
            Array.from({ length: samples }, (_, n) => ({ model, entry, n })),
          ),
        ),
        ({ model, entry, n }) => sampleSafely(entry, model, n),
        { concurrency: Number(values.concurrency) },
      );
      NodeFS.writeFileSync(
        NodePath.join(outDirectory, "results.ndjson"),
        rows.map((row) => encodeRow(row)).join("\n") + "\n",
      );

      // More than half of a case's samples must pass; a sample that errored counts as failed.
      const verdict = (
        own: ReadonlyArray<{ readonly pass?: boolean | undefined }>,
      ): boolean | undefined =>
        own.length === 0
          ? undefined
          : own.filter((row) => row.pass === true).length > own.length / 2;
      const baseline = values.baseline
        ? NodeFS.readFileSync(values.baseline, "utf8")
            .trim()
            .split("\n")
            .map((line) => decodeBaselineRow(line))
        : undefined;

      const lines = [header, ""];
      for (const model of models) {
        const verdicts = selected.map((entry) => {
          const own = rows.filter((row) => row.model === model && row.case === entry.id);
          const failedRow = own.find((row) => !("pass" in row) || !row.pass);
          return {
            entry,
            pass: verdict(own.map((row) => ("pass" in row ? row : {}))) === true,
            errors: own.filter((row) => !("pass" in row)).length,
            reason:
              failedRow === undefined
                ? ""
                : "error" in failedRow
                  ? failedRow.error
                  : (failedRow.reasons[0] ?? ""),
            before:
              baseline === undefined
                ? undefined
                : verdict(baseline.filter((row) => row.model === model && row.case === entry.id)),
          };
        });
        const count = (kind: VoiceAgentEvalCase["kind"]) => {
          const own = verdicts.filter((item) => item.entry.kind === kind);
          return `${own.filter((item) => item.pass).length}/${own.length}`;
        };
        const tokens = rows.reduce(
          (sum, row) => sum + (row.model === model && "tokens" in row ? row.tokens : 0),
          0,
        );
        const errors = verdicts.reduce((sum, item) => sum + item.errors, 0);
        lines.push(
          `## ${model}`,
          "",
          `guards passed ${count("guard")}, controls passed ${count("control")}, bad passed ${count("bad")}, ${errors} errors, ${tokens} tokens`,
        );
        for (const item of verdicts.filter((candidate) => !candidate.pass)) {
          lines.push(`- failed ${item.entry.id}: ${item.reason}`);
        }
        if (baseline !== undefined) {
          const fixed = verdicts.filter((item) => item.pass && item.before === false);
          const regressed = verdicts.filter((item) => !item.pass && item.before === true);
          lines.push(
            `fixed: ${fixed.map((item) => item.entry.id).join(", ") || "none"}`,
            `regressed: ${regressed.map((item) => item.entry.id).join(", ") || "none"}`,
          );
        }
        lines.push("");
      }
      const report = lines.join("\n");
      NodeFS.writeFileSync(NodePath.join(outDirectory, "summary.md"), report);
      return report;
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
  process.stdout.write(summary);
}
