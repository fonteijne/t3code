// @effect-diagnostics nodeBuiltinImport:off - a TCP server that never answers a handshake, and inspect to search a failure for the key.
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import * as NodeNet from "node:net";
import * as NodeUtil from "node:util";
import * as RealtimeUpstream from "./RealtimeUpstream.ts";
import {
  acceptFakeSession,
  fakeRealtime,
  type FakeRealtimeServer,
  fakeRealtimeServer,
} from "./RealtimeUpstream.testkit.ts";

const KEY = "sk-voice-test-key";
const MODEL = "team/gpt-realtime-2.1";

const input = (
  baseUrl: string,
  overrides: Partial<RealtimeUpstream.RealtimeUpstreamInput> = {},
): RealtimeUpstream.RealtimeUpstreamInput => ({
  baseUrl,
  apiKey: Redacted.make(KEY),
  model: MODEL,
  label: "Gateway",
  instructions: "Be brief.",
  tools: [],
  ...overrides,
});

/** Dials the fake, plays the compliant opening and hands back both ends. */
const connected = Effect.fn("connected")(function* (
  server: FakeRealtimeServer,
  overrides: Partial<RealtimeUpstream.RealtimeUpstreamInput> = {},
) {
  const upstream = yield* RealtimeUpstream.RealtimeUpstream;
  const connecting = yield* Effect.forkChild(upstream.connect(input(server.baseUrl, overrides)));
  const fake = yield* Queue.take(server.connections);
  const update = yield* acceptFakeSession(fake);
  const connection = yield* Fiber.join(connecting);
  return { connection, fake, update };
});

/** Every event up to and including the first of the given type. */
const eventsUntil = Effect.fn("eventsUntil")(function* (
  connection: RealtimeUpstream.RealtimeConnection,
  type: RealtimeUpstream.RealtimeEvent["type"],
) {
  const events: Array<RealtimeUpstream.RealtimeEvent> = [];
  while (!events.some((event) => event.type === type)) events.push(...(yield* connection.events));
  return events;
});

const live = <A, E>(effect: Effect.Effect<A, E, RealtimeUpstream.RealtimeUpstream | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(RealtimeUpstream.layer));

it.live.each([
  { name: "a base URL ending in /v1", suffix: "", apiKey: Redacted.make(KEY) },
  { name: "a base URL with a trailing slash", suffix: "/", apiKey: Redacted.make(KEY) },
  { name: "an endpoint without a key", suffix: "", apiKey: undefined },
])("opens a GA realtime session on $name", ({ suffix, apiKey }) =>
  live(
    Effect.gen(function* () {
      const server = yield* fakeRealtimeServer();
      const parameters = { type: "object", properties: {}, additionalProperties: false };
      const { fake, update } = yield* connected(server, {
        baseUrl: `${server.baseUrl}${suffix}`,
        apiKey,
        // What `VOICE_AGENT_TOOLS` entries carry beyond the endpoint's four keys.
        tools: [
          {
            name: "list_threads",
            description: "List threads.",
            parameters,
            kind: "list-threads",
            decode: () => undefined,
          } as RealtimeUpstream.RealtimeUpstreamInput["tools"][number],
        ],
      });

      expect(fake.path).toBe("/v1/realtime?model=team%2Fgpt-realtime-2.1");
      expect(fake.headers.authorization).toBe(apiKey === undefined ? undefined : `Bearer ${KEY}`);
      expect(fake.headers["openai-beta"]).toBeUndefined();
      expect(update).toStrictEqual({
        type: "session.update",
        session: {
          type: "realtime",
          output_modalities: ["audio"],
          instructions: "Be brief.",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24_000 },
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500,
                create_response: true,
                interrupt_response: true,
              },
            },
            output: { format: { type: "audio/pcm", rate: 24_000 } },
          },
          tools: [
            { type: "function", name: "list_threads", description: "List threads.", parameters },
          ],
          tool_choice: "auto",
        },
      });
    }),
  ),
);

/** What a failed connect leaves behind: the error, and every line it logged. */
const failedConnect = Effect.fn("failedConnect")(function* (baseUrl: string) {
  const logged: Array<string> = [];
  const logger = Logger.make(({ message }) => {
    logged.push(NodeUtil.inspect(message, { depth: null }));
  });
  const upstream = yield* RealtimeUpstream.RealtimeUpstream;
  const exit = yield* upstream
    .connect(input(baseUrl))
    .pipe(Effect.exit, Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  const error = yield* Effect.flip(exit);
  // Everything reachable from the failure, hidden properties included.
  const everything = NodeUtil.inspect([exit, logged], { depth: null, showHidden: true });
  return { error, logged, everything };
});

it.live.each([
  { status: 401, reason: "endpoint-refused", reported: 401 },
  { status: 404, reason: "endpoint-refused", reported: 404 },
  { status: 429, reason: "endpoint-refused", reported: 429 },
  { status: 503, reason: "endpoint-unreachable", reported: undefined },
] as const)("a refused upgrade with $status is $reason", ({ status, reason, reported }) =>
  live(
    Effect.gen(function* () {
      const server = yield* fakeRealtimeServer({ refuseUpgrade: () => status });
      const { error, logged, everything } = yield* failedConnect(server.baseUrl);

      expect({ reason: error.reason, status: error.status, endpoint: error.endpoint }).toEqual({
        reason,
        status: reported,
        endpoint: "Gateway",
      });
      expect(server.connectionCount()).toBe(0);
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain("voice endpoint refused the session");
      expect(logged[0]).toContain(reason);
      // The key travelled in the refused request. It must not come back in the error or a log.
      expect(everything).not.toContain(KEY);
    }),
  ),
);

it.live("a closed port is endpoint-unreachable", () =>
  live(
    Effect.gen(function* () {
      const baseUrl = yield* fakeRealtimeServer().pipe(
        Effect.map((server) => server.baseUrl),
        Effect.scoped,
      );
      const { error, everything } = yield* failedConnect(baseUrl);

      expect({ reason: error.reason, status: error.status }).toEqual({
        reason: "endpoint-unreachable",
        status: undefined,
      });
      expect(everything).not.toContain(KEY);
    }),
  ),
);

it.live("translates the endpoint's events and writes the adapter's own", () =>
  live(
    Effect.gen(function* () {
      const server = yield* fakeRealtimeServer();
      const { connection, fake } = yield* connected(server);
      const call = (callId: string) => ({
        type: "function_call",
        status: "completed",
        call_id: callId,
        name: "send_to_agent",
        arguments: '{"message":"hi"}',
      });

      fake.send(fakeRealtime.speechStarted());
      fake.send(fakeRealtime.speechStopped());
      fake.send(fakeRealtime.responseCreated("resp_1"));
      fake.send(fakeRealtime.audioDelta("item_1", 100));
      fake.send(fakeRealtime.audioDone("item_1"));
      fake.send(fakeRealtime.transcriptDelta("item_1", "Hel"));
      fake.send(fakeRealtime.transcriptDone("item_1", "Hello."));
      fake.send(fakeRealtime.audioDelta("x".repeat(257), 100));
      fake.send(fakeRealtime.functionCall("call_1", "send_to_agent", { message: "hi" }));
      fake.send(fakeRealtime.functionCall("call_cut", "send_to_agent", {}, "incomplete"));
      fake.send(fakeRealtime.functionCall("c".repeat(257), "send_to_agent", {}));
      fake.send({ type: "rate_limits.updated", rate_limits: [] });
      fake.send(fakeRealtime.responseDone("resp_1", "completed", [call("call_1"), call("call_2")]));

      const events = yield* eventsUntil(connection, "response-ended");
      expect(
        events.map((event) =>
          event.type === "audio" ? { ...event, pcm: event.pcm.byteLength } : event,
        ),
      ).toEqual([
        { type: "speech-started" },
        { type: "speech-stopped" },
        { type: "response-started", responseId: "resp_1" },
        { type: "audio", itemId: "item_1", pcm: 4_800 },
        { type: "audio-ended", itemId: "item_1" },
        { type: "caption-delta", itemId: "item_1", delta: "Hel" },
        { type: "caption-done", itemId: "item_1", text: "Hello." },
        // Reported by `response.output_item.done` and again by `response.done`: once.
        {
          type: "function-call",
          callId: "call_1",
          name: "send_to_agent",
          arguments: '{"message":"hi"}',
        },
        {
          type: "function-call",
          callId: "call_2",
          name: "send_to_agent",
          arguments: '{"message":"hi"}',
        },
        { type: "response-ended", status: "completed" },
      ]);

      yield* connection.createResponse({ tools: false });
      yield* connection.createResponse({ tools: true });
      yield* connection.appendAudio(Uint8Array.of(1, 2, 3, 4));
      yield* connection.cancelResponse("resp_1");
      yield* connection.cancelResponse(undefined);
      yield* connection.sendFunctionOutput("call_1", '{"status":"started"}');
      yield* connection.injectNote("[T3 Code] Done.");
      yield* connection.truncate("item_1", 1_500);
      yield* connection.deleteItem("item_2");
      const sent = yield* Effect.all(Array.from({ length: 9 }, () => Queue.take(fake.received)));
      expect(sent).toStrictEqual([
        { type: "response.create", event_id: "t3-response-0", response: { tool_choice: "none" } },
        { type: "response.create", event_id: "t3-response-1" },
        { type: "input_audio_buffer.append", audio: "AQIDBA==" },
        { type: "response.cancel", event_id: "t3-quiet-0", response_id: "resp_1" },
        { type: "response.cancel", event_id: "t3-quiet-1" },
        {
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: "call_1", output: '{"status":"started"}' },
        },
        {
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "system",
            content: [{ type: "input_text", text: "[T3 Code] Done." }],
          },
        },
        {
          type: "conversation.item.truncate",
          event_id: "t3-quiet-2",
          item_id: "item_1",
          content_index: 0,
          audio_end_ms: 1_500,
        },
        { type: "conversation.item.delete", event_id: "t3-quiet-3", item_id: "item_2" },
      ]);
    }),
  ),
);

it.live("reads the endpoint's errors and its close", () =>
  live(
    Effect.gen(function* () {
      const upstream = yield* RealtimeUpstream.RealtimeUpstream;
      const server = yield* fakeRealtimeServer();

      // An `error` answer to the first `session.update`: not a realtime session we can use.
      const refusing = yield* Effect.forkChild(
        Effect.flip(upstream.connect(input(server.baseUrl))),
      );
      const strict = yield* Queue.take(server.connections);
      strict.send(fakeRealtime.sessionCreated());
      expect((yield* Queue.take(strict.received)).type).toBe("session.update");
      strict.send(fakeRealtime.error("unknown_parameter"));
      const refused = yield* Fiber.join(refusing);
      expect({ reason: refused.reason, status: refused.status }).toEqual({
        reason: "endpoint-refused",
        status: undefined,
      });

      // Only an error that answers one of our reply requests reaches the session.
      const { connection, fake } = yield* connected(server);
      fake.send(fakeRealtime.error("response_cancel_not_active", "t3-quiet-0"));
      fake.send(fakeRealtime.error("conversation_already_has_active_response", "t3-response-0"));
      expect(yield* eventsUntil(connection, "response-refused")).toEqual([
        { type: "response-refused" },
      ]);

      fake.close(1011, "guardrail");
      const closed = yield* Effect.flip(connection.events);
      expect(closed.reason).toBe("endpoint-closed");
    }),
  ),
);

it.live("abandons a dial that never answers without an unhandled error", () =>
  live(
    Effect.gen(function* () {
      const dialed = Promise.withResolvers<NodeNet.Socket>();
      // Accepts the connection and never answers the WebSocket handshake.
      const silent = yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<NodeNet.Server>((resolve) => {
              const server = NodeNet.createServer((socket) => dialed.resolve(socket));
              server.listen(0, "127.0.0.1", () => resolve(server));
            }),
        ),
        (server) =>
          Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
      const address = silent.address();
      if (typeof address !== "object" || !address) throw new Error("Missing port");
      const upstream = yield* RealtimeUpstream.RealtimeUpstream;
      const connecting = yield* Effect.forkChild(
        Effect.scoped(upstream.connect(input(`http://127.0.0.1:${address.port}/v1`))),
      );
      const transport = yield* Effect.promise(() => dialed.promise);
      const abandoned = new Promise<void>((resolve) => transport.once("close", () => resolve()));
      transport.resume();
      yield* Fiber.interrupt(connecting);
      yield* Effect.promise(() => abandoned);
    }),
  ),
);
