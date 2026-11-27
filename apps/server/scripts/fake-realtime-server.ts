#!/usr/bin/env node
/**
 * A fake OpenAI-Realtime endpoint for trying voice mode without a paid gateway. It drives a
 * manual pass and is no model of an endpoint: tones for speech, no errors for bad input, no
 * cancel of its own. Its event shapes were never checked against a live endpoint.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Command, Flag } from "effect/cli";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import {
  type FakeRealtimeConnection,
  fakeRealtime,
  fakeRealtimeServer,
} from "../src/voiceAgent/RealtimeUpstream.testkit.ts";

export type FakeRealtimeTurn =
  | { readonly type: "speech"; readonly milliseconds: number; readonly transcript: string }
  | {
      readonly type: "call";
      readonly name: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    };

/** What the newest connection answers its next user turn with, when a pass asked for a tool. */
export interface FakeRealtimeNextTurn {
  override: FakeRealtimeTurn | undefined;
}

// One step per user turn: a short reply, a forwarded request, a reply long enough to interrupt.
const CYCLE: ReadonlyArray<FakeRealtimeTurn> = [
  { type: "speech", milliseconds: 3_000, transcript: "Fake reply one." },
  {
    type: "call",
    name: "send_to_agent",
    arguments: { message: "Reply with one short sentence." },
  },
  { type: "speech", milliseconds: 25_000, transcript: "Fake long reply. Talk over it." },
];
const DELTA_MS = 100;
const REPORT_MS = 2_000;
const REPORT_TRANSCRIPT_LENGTH = 120;
const PCM_BYTES_PER_MS = 48;
// The fake's own turn detection on the microphone audio; it says nothing about server VAD.
const SPEECH_RMS = 0.02;
const SILENCE_MS = 500;

const ReceivedEvent = Schema.Struct({
  type: Schema.String,
  audio: Schema.optionalKey(Schema.String),
  response_id: Schema.optionalKey(Schema.String),
  item_id: Schema.optionalKey(Schema.String),
  content_index: Schema.optionalKey(Schema.Number),
  audio_end_ms: Schema.optionalKey(Schema.Number),
  item: Schema.optionalKey(
    Schema.Struct({
      type: Schema.optionalKey(Schema.String),
      output: Schema.optionalKey(Schema.String),
      content: Schema.optionalKey(
        Schema.Array(Schema.Struct({ text: Schema.optionalKey(Schema.String) })),
      ),
    }),
  ),
});
const decodeReceivedEvent = Schema.decodeUnknownOption(ReceivedEvent);
const decodeNextTurn = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      tool: Schema.NonEmptyString,
      arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);

/** Loudness of 16-bit little-endian PCM, from 0 to 1. */
export const pcmLoudness = (pcm: Uint8Array): number => {
  const samples = Math.floor(pcm.byteLength / 2);
  if (samples === 0) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let squares = 0;
  for (let index = 0; index < samples; index++) {
    const sample = view.getInt16(index * 2, true) / 32_768;
    squares += sample * sample;
  }
  return Math.sqrt(squares / samples);
};

/** Plays the endpoint's side of one connection until its socket closes. */
export const runFakeRealtimeBrain = Effect.fn("fakeRealtime.runBrain")(function* (
  connection: FakeRealtimeConnection,
  options: {
    readonly speed: number;
    readonly next: FakeRealtimeNextTurn;
    /** Where the sequence of the session is printed, one line per call. */
    readonly log: (line: string) => Effect.Effect<void>;
  },
) {
  let ids = 0;
  let userTurns = 0;
  let speaking = false;
  let quietMs = 0;
  // The function output or the note the next `response.create` is about.
  let pendingText: string | undefined;
  let active: { readonly responseId: string; readonly fiber: Fiber.Fiber<void> } | undefined;
  let lastLine: string | undefined;
  let repeats = 0;

  // Microphone audio arrives 25 times a second, so a repeated line is printed once with a count.
  const log = Effect.fnUntraced(function* (line: string) {
    if (line === lastLine) {
      repeats++;
      return;
    }
    if (repeats > 0) yield* options.log(`  (${repeats} more)`);
    lastLine = line;
    repeats = 0;
    yield* options.log(line);
  });

  const speak = Effect.fnUntraced(function* (
    responseId: string,
    turn: Extract<FakeRealtimeTurn, { readonly type: "speech" }>,
  ) {
    const itemId = `item_fake_${ids++}`;
    for (let sent = 0; sent < turn.milliseconds; sent += DELTA_MS) {
      connection.send(fakeRealtime.audioDelta(itemId, DELTA_MS));
      yield* Effect.sleep(DELTA_MS / options.speed);
    }
    // The order one real session showed: the audio ends before its transcript.
    connection.send(fakeRealtime.audioDone(itemId));
    connection.send(fakeRealtime.transcriptDone(itemId, turn.transcript));
    connection.send(fakeRealtime.responseDone(responseId));
    active = undefined;
  });

  /** Ends the response in progress, if it is the one named. No id names whatever is running. */
  const cancel = Effect.fnUntraced(function* (responseId: string | undefined) {
    const current = active;
    if (current === undefined) return;
    if (responseId !== undefined && responseId !== current.responseId) return;
    active = undefined;
    yield* Fiber.interrupt(current.fiber);
    connection.send(fakeRealtime.responseDone(current.responseId, "cancelled"));
  });

  const respond = Effect.fnUntraced(function* (turn: FakeRealtimeTurn) {
    yield* cancel(undefined);
    const responseId = `resp_fake_${ids++}`;
    connection.send(fakeRealtime.responseCreated(responseId));
    if (turn.type === "call") {
      yield* log(`-> function call ${turn.name}`);
      connection.send(fakeRealtime.functionCall(`call_fake_${ids++}`, turn.name, turn.arguments));
      connection.send(fakeRealtime.responseDone(responseId));
      return;
    }
    yield* log(`-> ${turn.milliseconds / 1_000} s of speech: ${turn.transcript}`);
    active = { responseId, fiber: yield* Effect.forkScoped(speak(responseId, turn)) };
  });

  const hear = Effect.fnUntraced(function* (audio: string) {
    const pcm = Buffer.from(audio, "base64");
    if (pcmLoudness(pcm) > SPEECH_RMS) {
      quietMs = 0;
      if (speaking) return;
      speaking = true;
      connection.send(fakeRealtime.speechStarted());
      return;
    }
    if (!speaking) return;
    quietMs += pcm.byteLength / PCM_BYTES_PER_MS;
    if (quietMs < SILENCE_MS) return;
    speaking = false;
    connection.send(fakeRealtime.speechStopped());
    const override = options.next.override;
    options.next.override = undefined;
    yield* respond(override ?? CYCLE[userTurns++ % CYCLE.length]!);
  });

  const listen = Effect.gen(function* () {
    // The address the server dialed, to compare with the one the consent dialog names.
    yield* log(`Connection on host ${String(connection.headers.host)}`);
    connection.send(fakeRealtime.sessionCreated());
    while (true) {
      const received = decodeReceivedEvent(yield* Queue.take(connection.received));
      if (Option.isNone(received)) continue;
      const event = received.value;
      yield* log(`<- ${event.type}`);
      switch (event.type) {
        case "session.update":
          connection.send(fakeRealtime.sessionUpdated());
          break;
        case "input_audio_buffer.append":
          yield* hear(event.audio ?? "");
          break;
        case "conversation.item.create":
          pendingText =
            event.item?.type === "function_call_output"
              ? event.item.output
              : (event.item?.content?.[0]?.text ?? pendingText);
          break;
        case "response.create": {
          const transcript = (pendingText ?? "Fake reply.").slice(0, REPORT_TRANSCRIPT_LENGTH);
          pendingText = undefined;
          yield* respond({ type: "speech", milliseconds: REPORT_MS, transcript });
          break;
        }
        case "response.cancel":
          yield* cancel(event.response_id);
          break;
        case "conversation.item.truncate":
          connection.send({
            type: "conversation.item.truncated",
            item_id: event.item_id,
            content_index: event.content_index ?? 0,
            audio_end_ms: event.audio_end_ms,
          });
          break;
        case "conversation.item.delete":
          connection.send({ type: "conversation.item.deleted", item_id: event.item_id });
          break;
        default:
          break;
      }
    }
  });

  yield* Effect.raceFirst(listen, connection.closed).pipe(Effect.scoped);
  yield* log("Connection closed");
});

export const fakeRealtimeServerCommand = Command.make(
  "fake-realtime-server",
  {
    port: Flag.Int("port").pipe(
      Flag.withDefault(8765),
      Flag.withDescription("Port to listen on, on 127.0.0.1."),
    ),
    key: Flag.String("key").pipe(
      Flag.optional,
      Flag.withDescription("Refuse any other API key with HTTP 401. Without it every key works."),
    ),
    speed: Flag.Finite("speed").pipe(
      Flag.filter(
        (speed) => speed > 0,
        () => "Speed must be greater than zero.",
      ),
      Flag.withDefault(2.7),
      Flag.withDescription("How many times faster than real time speech is generated."),
    ),
  },
  ({ port, key, speed }) =>
    Effect.gen(function* () {
      let newest: FakeRealtimeNextTurn | undefined;
      const server = yield* fakeRealtimeServer({
        port,
        refuseUpgrade: ({ authorization }) =>
          Option.isSome(key) && authorization !== `Bearer ${key.value}` ? 401 : undefined,
        // POST /fake/next {"tool": "<name>", "arguments": {...}}: the newest connection answers
        // its next user turn with that function call instead of its next step.
        handleRequest: (request, response) => {
          if (request.method !== "POST" || request.url !== "/fake/next") return false;
          const chunks: Array<Buffer> = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            const body = decodeNextTurn(Buffer.concat(chunks).toString("utf8"));
            if (Option.isNone(body) || newest === undefined) {
              response.writeHead(400).end();
              return;
            }
            newest.override = {
              type: "call",
              name: body.value.tool,
              arguments: body.value.arguments ?? {},
            };
            response.writeHead(204).end();
          });
          return true;
        },
      });
      yield* Console.log(
        [
          "Fake realtime endpoint. In Settings, Providers, add a text generator with:",
          `  Base URL     ${server.baseUrl}`,
          `  API key      ${Option.getOrElse(key, () => "anything")}`,
          "  Voice model  fake-realtime",
          "Then pick it as the voice agent in Settings, Voice.",
        ].join("\n"),
      );
      while (true) {
        const connection = yield* Queue.take(server.connections);
        const next: FakeRealtimeNextTurn = { override: undefined };
        newest = next;
        yield* Effect.forkScoped(
          runFakeRealtimeBrain(connection, { speed, next, log: Console.log }),
        );
      }
    }).pipe(Effect.scoped),
).pipe(
  Command.withDescription(
    "Run a fake OpenAI-Realtime endpoint for trying voice mode: node apps/server/scripts/fake-realtime-server.ts --port 8765",
  ),
);

if (import.meta.main) {
  Command.run(fakeRealtimeServerCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
