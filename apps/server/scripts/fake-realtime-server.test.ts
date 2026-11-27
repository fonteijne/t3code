import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import type { FakeRealtimeConnection } from "../src/voiceAgent/RealtimeUpstream.testkit.ts";
import {
  type FakeRealtimeNextTurn,
  pcmLoudness,
  runFakeRealtimeBrain,
} from "./fake-realtime-server.ts";

type WireEvent = { readonly type: string; readonly [key: string]: unknown };

const isWireEvent = (value: object): value is WireEvent =>
  "type" in value && typeof value.type === "string";

/** 40 ms of microphone audio as the T3 server appends it. */
const microphone = (amplitude: number) => {
  const pcm = Buffer.alloc(1_920);
  for (let sample = 0; sample < pcm.byteLength / 2; sample++) {
    pcm.writeInt16LE(sample % 2 === 0 ? amplitude : -amplitude, sample * 2);
  }
  return { type: "input_audio_buffer.append", audio: pcm.toString("base64") };
};

/** The brain on a connection without a socket, generating speech twice as fast as real time. */
const startBrain = Effect.fn("startBrain")(function* () {
  const received = yield* Queue.unbounded<WireEvent>();
  const sent = yield* Queue.unbounded<WireEvent>();
  const closed = yield* Deferred.make<void>();
  const lines: Array<string> = [];
  const next: FakeRealtimeNextTurn = { override: undefined };
  const connection: FakeRealtimeConnection = {
    path: "/v1/realtime?model=fake-realtime",
    headers: { host: "127.0.0.1:8765" },
    received,
    send: (event) => {
      if (isWireEvent(event)) Queue.offerUnsafe(sent, event);
    },
    close: () => {
      Deferred.doneUnsafe(closed, Effect.void);
    },
    closed: Deferred.await(closed),
  };
  const brain = yield* Effect.forkScoped(
    runFakeRealtimeBrain(connection, {
      speed: 2,
      next,
      log: (line) => Effect.sync(() => void lines.push(line)),
    }),
  );
  const receive = (...events: ReadonlyArray<WireEvent>) =>
    Effect.asVoid(Queue.offerAll(received, events));
  return {
    brain,
    connection,
    lines,
    next,
    receive,
    /** The types of the next events the brain sends, waiting for them. */
    sentTypes: (count: number) =>
      Effect.map(Queue.takeN(sent, count), (events) => events.map((event) => event.type)),
    nextSent: Queue.take(sent),
    unread: Queue.clear(sent),
    /** The developer says something and falls silent for a little over half a second. */
    userTurn: receive(microphone(8_000), ...Array.from({ length: 13 }, () => microphone(0))),
  };
});

it("measures loudness of 16-bit PCM", () => {
  expect(pcmLoudness(new Uint8Array(0))).toBe(0);
  expect(pcmLoudness(new Uint8Array(1_920))).toBe(0);
  expect(pcmLoudness(Buffer.from(microphone(8_000).audio, "base64"))).toBeCloseTo(8_000 / 32_768);
});

it.effect("plays the cycle of replies, one per user turn, and reports what it receives", () =>
  Effect.gen(function* () {
    const fake = yield* startBrain();
    expect(yield* fake.sentTypes(1)).toEqual(["session.created"]);
    yield* fake.receive({ type: "session.update" });
    expect(yield* fake.sentTypes(1)).toEqual(["session.updated"]);

    // First turn: three seconds of speech in 100 ms deltas, twice as fast as real time.
    yield* fake.userTurn;
    expect(yield* fake.sentTypes(4)).toEqual([
      "input_audio_buffer.speech_started",
      "input_audio_buffer.speech_stopped",
      "response.created",
      "response.output_audio.delta",
    ]);
    yield* TestClock.adjust("1450 millis");
    expect(yield* fake.sentTypes(29)).toEqual(
      Array.from({ length: 29 }, () => "response.output_audio.delta"),
    );
    expect(yield* fake.unread).toEqual([]);
    yield* TestClock.adjust("50 millis");
    // The audio ends before its transcript, the order one real session showed.
    expect(yield* fake.sentTypes(1)).toEqual(["response.output_audio.done"]);
    expect(yield* fake.nextSent).toMatchObject({
      type: "response.output_audio_transcript.done",
      transcript: "Fake reply one.",
    });
    expect(yield* fake.nextSent).toMatchObject({
      type: "response.done",
      response: { status: "completed" },
    });

    // Second turn: a forwarded request, then the function output read back as speech.
    yield* fake.userTurn;
    yield* fake.sentTypes(3);
    expect(yield* fake.nextSent).toMatchObject({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "send_to_agent",
        arguments: '{"message":"Reply with one short sentence."}',
      },
    });
    expect(yield* fake.sentTypes(1)).toEqual(["response.done"]);
    yield* fake.receive(
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call_fake_3",
          output: '{"status":"started"}',
        },
      },
      { type: "response.create" },
    );
    expect(yield* fake.sentTypes(2)).toEqual(["response.created", "response.output_audio.delta"]);
    yield* TestClock.adjust("1 second");
    yield* fake.sentTypes(20);
    expect(yield* fake.nextSent).toMatchObject({
      type: "response.output_audio_transcript.done",
      transcript: '{"status":"started"}',
    });
    yield* fake.sentTypes(1);

    expect(fake.lines).toEqual([
      "Connection on host 127.0.0.1:8765",
      "<- session.update",
      "<- input_audio_buffer.append",
      "  (13 more)",
      "-> 3 s of speech: Fake reply one.",
      "<- input_audio_buffer.append",
      "  (13 more)",
      "-> function call send_to_agent",
      "<- conversation.item.create",
      "<- response.create",
      '-> 2 s of speech: {"status":"started"}',
    ]);
  }),
);

it.effect("calls the tool a pass asked for, and stops a reply that is cancelled by id", () =>
  Effect.gen(function* () {
    const fake = yield* startBrain();
    yield* fake.sentTypes(1);

    // What `POST /fake/next` sets: the next turn calls this tool, and the cycle does not move.
    fake.next.override = { type: "call", name: "list_threads", arguments: {} };
    yield* fake.userTurn;
    yield* fake.sentTypes(3);
    expect(yield* fake.nextSent).toMatchObject({
      type: "response.output_item.done",
      item: { name: "list_threads", arguments: "{}" },
    });
    yield* fake.sentTypes(1);
    expect(fake.next.override).toBeUndefined();

    // A note followed by `response.create` is read back, cut to 120 characters.
    yield* fake.receive(
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: "n".repeat(200) }],
        },
      },
      { type: "response.create" },
    );
    const created = yield* fake.nextSent;
    expect(created).toMatchObject({ type: "response.created", response: { id: "resp_fake_2" } });
    expect(yield* fake.sentTypes(1)).toEqual(["response.output_audio.delta"]);

    // A cancel that names another reply does nothing; one that names this reply ends it.
    yield* fake.receive({ type: "response.cancel", response_id: "resp_other" });
    yield* TestClock.adjust("50 millis");
    expect(yield* fake.sentTypes(1)).toEqual(["response.output_audio.delta"]);
    yield* fake.receive(
      { type: "response.cancel", response_id: "resp_fake_2" },
      {
        type: "conversation.item.truncate",
        item_id: "item_fake_3",
        content_index: 0,
        audio_end_ms: 150,
      },
      { type: "conversation.item.delete", item_id: "item_fake_9" },
    );
    expect(yield* fake.nextSent).toMatchObject({
      type: "response.done",
      response: { id: "resp_fake_2", status: "cancelled" },
    });
    expect(yield* fake.nextSent).toEqual({
      type: "conversation.item.truncated",
      item_id: "item_fake_3",
      content_index: 0,
      audio_end_ms: 150,
    });
    expect(yield* fake.nextSent).toEqual({
      type: "conversation.item.deleted",
      item_id: "item_fake_9",
    });
    yield* TestClock.adjust("5 seconds");
    expect(yield* fake.unread).toEqual([]);

    // The cycle starts where it was: the override did not use up its first step.
    yield* fake.userTurn;
    yield* fake.sentTypes(4);
    fake.connection.close();
    yield* Fiber.join(fake.brain);
    expect(fake.lines.at(-1)).toBe("Connection closed");
    yield* TestClock.adjust("5 seconds");
    expect(yield* fake.unread).toEqual([]);
  }),
);
