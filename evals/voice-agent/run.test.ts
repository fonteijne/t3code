import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";
import { VOICE_AGENT_TOOLS } from "../../apps/server/src/voiceAgent/voiceAgentPrompt.ts";
import { cases, DEFAULT_TOOL_RESULTS } from "./cases.ts";
import { type Expectation, grade, type RecordedCall, SPOKEN_MAX_WORDS } from "./grade.ts";

const call = (name: string, args: Record<string, unknown> | null, valid = true): RecordedCall => ({
  name,
  arguments: args,
  valid,
});
const send = (message: string) => call("send_to_agent", { message });
const words = (count: number) => Array.from({ length: count }, () => "word").join(" ");

describe("grade", () => {
  it.each<[string, Expectation, ReadonlyArray<RecordedCall>, string, boolean]>([
    [
      "a matching call",
      { calls: [{ tool: "send_to_agent", args: { message: /retry/ } }] },
      [send("check the retry logic")],
      "",
      true,
    ],
    [
      "the right tool with a word missing",
      { calls: [{ tool: "send_to_agent", args: { message: [/retry/, /ledger/] } }] },
      [send("check the retry logic")],
      "",
      false,
    ],
    [
      "callsMustNot on a match",
      { callsMustNot: [{ tool: "interrupt_agent" }] },
      [call("interrupt_agent", {})],
      "",
      false,
    ],
    [
      "callsMustNot on another tool",
      { callsMustNot: [{ tool: "interrupt_agent" }] },
      [call("read_agent_reply", {})],
      "",
      true,
    ],
    ["noCalls with a call", { noCalls: true }, [call("read_agent_reply", {})], "Done.", false],
    ["noCalls without a call", { noCalls: true }, [], "Done.", true],
    ["an invalid call fails any case", {}, [call("send_to_agent", {}, false)], "", false],
    [
      "maxWords over the limit",
      { calls: [{ tool: "send_to_agent", maxWords: { message: 3 } }] },
      [send("one two three four")],
      "",
      false,
    ],
    [
      "maxWords within the limit",
      { calls: [{ tool: "send_to_agent", maxWords: { message: 4 } }] },
      [send("one two three four")],
      "",
      true,
    ],
    ["the default spoken limit", {}, [], words(SPOKEN_MAX_WORDS + 1), false],
    ["a spoken limit override", { spokenMaxWords: 100 }, [], words(SPOKEN_MAX_WORDS + 1), true],
    [
      "anywhereMust from an argument",
      { anywhereMust: [/Pocket/] },
      [send("run the Pocket tests")],
      "Sent.",
      true,
    ],
    ["anywhereMust from speech", { anywhereMust: [/Pocket/] }, [], "Did you mean Pocket?", true],
    [
      "anywhereMust from neither",
      { anywhereMust: [/Pocket/] },
      [send("run the pockit tests")],
      "Sent.",
      false,
    ],
    [
      "an array argument on its JSON text",
      { calls: [{ tool: "answer_agent_question", args: { answers: [/"q1"/, /Postgres/] } }] },
      [
        call("answer_agent_question", {
          request_id: "req-1",
          answers: [{ question_id: "q1", choices: ["Postgres"] }],
        }),
      ],
      "",
      true,
    ],
  ])("%s", (_name, expectation, calls, spoken, pass) => {
    expect(grade(expectation, { calls, spoken }).pass).toBe(pass);
  });
});

it("cases use the tools and argument shapes the server defines", () => {
  const tools = new Map(VOICE_AGENT_TOOLS.map((tool) => [tool.name, tool]));
  const named = cases.flatMap((entry) => [
    ...entry.history.flatMap((turn) => ("call" in turn ? [turn.call] : [])),
    ...Object.keys(entry.results ?? {}),
    ...(entry.expect.calls ?? []).map((matcher) => matcher.tool),
    ...(entry.expect.callsMustNot ?? []).map((matcher) => matcher.tool),
  ]);
  expect(
    [...named, ...Object.keys(DEFAULT_TOOL_RESULTS)].filter((name) => !tools.has(name)),
  ).toEqual([]);
  expect([...tools.keys()].filter((name) => !(name in DEFAULT_TOOL_RESULTS))).toEqual([]);
  const undecodable = cases.flatMap((entry) =>
    entry.history.flatMap((turn) =>
      "call" in turn && Option.isNone(tools.get(turn.call)!.decode(JSON.stringify(turn.arguments)))
        ? [`${entry.id}: ${turn.call}`]
        : [],
    ),
  );
  expect(undecodable).toEqual([]);
  expect(new Set(cases.map((entry) => entry.id)).size).toBe(cases.length);
});
