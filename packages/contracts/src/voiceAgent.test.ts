import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import { isUnknownUnionMember, ProjectId, ThreadId, UnknownUnionMember } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  ReceivedVoiceAgentCommand,
  ReceivedVoiceAgentEvent,
  VoiceAgentCommand,
  VoiceAgentEvent,
} from "./voiceAgent.ts";

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(VoiceAgentEvent));
const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(ReceivedVoiceAgentEvent));
const encodeCommand = Schema.encodeSync(Schema.fromJsonString(VoiceAgentCommand));
const decodeCommand = Schema.decodeUnknownOption(Schema.fromJsonString(ReceivedVoiceAgentCommand));

const threadId = ThreadId.make("thread-a");
const start = {
  type: "start",
  projectId: ProjectId.make("project-a"),
  endpointId: ProviderInstanceId.make("gateway"),
  baseUrl: "https://gateway.test/v1",
} as const;

const events: ReadonlyArray<VoiceAgentEvent> = [
  { type: "ready", threadId },
  { type: "ready", threadId: null },
  { type: "user-speech-started", flushId: 0 },
  { type: "user-speech-stopped" },
  { type: "agent-speech-started", itemId: "item_A" },
  { type: "agent-speech-done", itemId: "item_A" },
  { type: "caption-delta", itemId: "item_A", delta: "On " },
  { type: "caption-done", itemId: "item_A", text: "On it." },
  { type: "tool-activity", callId: "call_1", kind: "send-request", status: "started" },
  { type: "thread-changed", threadId },
  { type: "error", code: "response-failed", message: "The endpoint could not answer." },
  { type: "closed", reason: "ended" },
  { type: "closed", reason: "endpoint-refused", message: "Gateway refused the voice session." },
];

it.each(events)("carries a $type event across the socket unchanged", (event) => {
  expect(decodeEvent(encodeEvent(event))).toEqual(Option.some(event));
});

it("reads events from a newer server without dropping the session", () => {
  const unknown = decodeEvent(JSON.stringify({ type: "agent-thinking", itemId: "item_A" }));
  expect(Option.exists(unknown, isUnknownUnionMember)).toBe(true);
  expect(unknown).toEqual(Option.some(new UnknownUnionMember("type", "agent-thinking")));

  expect(
    decodeEvent(JSON.stringify({ type: "closed", reason: "from-the-future", message: "x" })),
  ).toEqual(Option.some({ type: "closed", reason: null, message: "x" }));
  expect(
    decodeEvent(
      JSON.stringify({
        type: "tool-activity",
        callId: "call_1",
        kind: "rename-thread",
        status: "completed",
      }),
    ),
  ).toEqual(
    Option.some({ type: "tool-activity", callId: "call_1", kind: null, status: "completed" }),
  );

  // A known type must decode in full: it never passes as an unknown member.
  expect(decodeEvent(JSON.stringify({ type: "agent-speech-started" }))).toEqual(Option.none());
});

it("accepts only commands a session can act on", () => {
  expect(decodeCommand(encodeCommand(start))).toEqual(Option.some(start));
  const bound = { ...start, threadId };
  expect(decodeCommand(encodeCommand(bound))).toEqual(Option.some(bound));
  const { endpointId: _endpointId, ...withoutEndpoint } = start;
  expect(decodeCommand(JSON.stringify(withoutEndpoint))).toEqual(Option.none());
  const { baseUrl: _baseUrl, ...withoutBaseUrl } = start;
  expect(decodeCommand(JSON.stringify(withoutBaseUrl))).toEqual(Option.none());

  const flushed = { type: "playback-flushed", flushId: 3, itemId: null, playedMs: 0 } as const;
  expect(decodeCommand(encodeCommand(flushed))).toEqual(Option.some(flushed));
  for (const broken of [{ playedMs: -1 }, { playedMs: 1.5 }, { flushId: -1 }, { flushId: 0.5 }]) {
    expect(decodeCommand(JSON.stringify({ ...flushed, itemId: "item_A", ...broken }))).toEqual(
      Option.none(),
    );
  }

  expect(decodeCommand(JSON.stringify({ type: "mute", muted: true }))).toEqual(
    Option.some(new UnknownUnionMember("type", "mute")),
  );
});
