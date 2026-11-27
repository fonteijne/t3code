import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  SecretReference,
  type ServerSettings,
  type TextGeneratorConfig,
  ThreadId,
  VOICE_AGENT_INPUT_FRAME_BYTES,
  VOICE_AGENT_MAX_AUDIO_FRAME_BYTES,
  VoiceAgentError,
  VoiceAgentEvent,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import type * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettingsService from "../serverSettings.ts";
import * as RealtimeUpstream from "./RealtimeUpstream.ts";
import * as VoiceAgentSessions from "./VoiceAgentSessions.ts";
import * as VoiceAgentThreads from "./VoiceAgentThreads.ts";

const PROJECT = ProjectId.make("project-voice");
const THREAD = ThreadId.make("thread-one");
const OTHER_THREAD = ThreadId.make("thread-two");
const ENDPOINT = ProviderInstanceId.make("gateway");
const BASE_URL = "https://gateway.example/v1";
const KEY = "sk-voice-test-key";
const VAULT_KEY = Schema.decodeSync(SecretReference)({ provider: "vault", reference: "voice/key" });

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(VoiceAgentEvent));

const settingsWith = (
  generator: Partial<TextGeneratorConfig> = {},
  overrides: Partial<ServerSettings> = {},
): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  voiceModeEnabled: true,
  textGenerators: {
    [ENDPOINT]: {
      kind: "openaiCompatible",
      label: "Gateway",
      baseUrl: BASE_URL,
      apiKey: KEY,
      enabled: true,
      voiceModel: "voice-model",
      ...generator,
    },
  },
  ...overrides,
});

/** 24 kHz 16-bit mono PCM of the given length. */
const pcm = (milliseconds: number) => new Uint8Array(milliseconds * 48);
const MIC_FRAME = new Uint8Array(VOICE_AGENT_INPUT_FRAME_BYTES);
const MIC_INTERVAL_MS = 10_000;

const audio = (itemId: string, milliseconds: number): RealtimeUpstream.RealtimeEvent => ({
  type: "audio",
  itemId,
  pcm: pcm(milliseconds),
});
const functionCall = (callId: string, name = "send_to_agent"): RealtimeUpstream.RealtimeEvent => ({
  type: "function-call",
  callId,
  name,
  arguments: '{"message":"Run the tests."}',
});
const responseStarted = (responseId: string): RealtimeUpstream.RealtimeEvent => ({
  type: "response-started",
  responseId,
});
const responseEnded: RealtimeUpstream.RealtimeEvent = {
  type: "response-ended",
  status: "completed",
};

/** What the session sent to the endpoint, apart from microphone audio. */
type Sent =
  | { readonly type: "response"; readonly tools: boolean }
  | { readonly type: "cancel"; readonly responseId: string | undefined }
  | { readonly type: "function-output"; readonly callId: string; readonly output: string }
  | { readonly type: "note"; readonly text: string }
  | { readonly type: "truncate"; readonly itemId: string; readonly audioEndMs: number }
  | { readonly type: "delete"; readonly itemId: string };

type ToolScript = (
  binding: VoiceAgentThreads.VoiceAgentBinding,
) => Effect.Effect<VoiceAgentThreads.VoiceAgentToolOutcome>;

interface HarnessOptions {
  readonly settings?: ServerSettings;
  /** What a named secret reads as; undefined is an unreadable one. */
  readonly secret?: string | undefined;
  readonly openError?: VoiceAgentError;
  readonly connectError?: VoiceAgentError;
  /** `connect` waits until the test calls `releaseConnect`. */
  readonly gateConnect?: boolean;
}

/** The scripted endpoint of one session. */
const makeEndpoint = Effect.fn("makeEndpoint")(function* (
  input: RealtimeUpstream.RealtimeUpstreamInput,
) {
  const events = yield* Queue.unbounded<
    ReadonlyArray<RealtimeUpstream.RealtimeEvent>,
    VoiceAgentError
  >();
  const sent = yield* Queue.unbounded<Sent>();
  const microphone = yield* Queue.unbounded<number>();
  let backedUpChecks = 0;
  const record = (entry: Sent) => Effect.asVoid(Queue.offer(sent, entry));
  const connection: RealtimeUpstream.RealtimeConnection = {
    events: Queue.take(events),
    appendAudio: (bytes) => Effect.asVoid(Queue.offer(microphone, bytes.byteLength)),
    createResponse: ({ tools }) => record({ type: "response", tools }),
    cancelResponse: (responseId) => record({ type: "cancel", responseId }),
    sendFunctionOutput: (callId, output) => record({ type: "function-output", callId, output }),
    injectNote: (text) => record({ type: "note", text }),
    truncate: (itemId, audioEndMs) => record({ type: "truncate", itemId, audioEndMs }),
    deleteItem: (itemId) => record({ type: "delete", itemId }),
    bufferedBytes: () => (backedUpChecks-- > 0 ? 1024 * 1024 : 0),
  };
  return {
    input,
    connection,
    emit: (...batch: ReadonlyArray<RealtimeUpstream.RealtimeEvent>) =>
      Effect.asVoid(Queue.offer(events, batch)),
    fail: (error: VoiceAgentError) => Effect.asVoid(Queue.fail(events, error)),
    /** The next thing the session sent, waiting for it. */
    nextSent: Queue.take(sent),
    /** Everything sent and not yet read. */
    sentSoFar: Queue.clear(sent),
    /** The byte length of the next microphone append, waiting for it. */
    nextMicrophone: Queue.take(microphone),
    /** The socket reports a full send buffer the next time the session looks. */
    backUpOnce: () => {
      backedUpChecks = 1;
    },
  };
});
type Endpoint = Effect.Success<ReturnType<typeof makeEndpoint>>;

const makeHarness = Effect.fn("makeHarness")(function* (options: HarnessOptions = {}) {
  let settings = options.settings ?? settingsWith();
  const settingsChanges = yield* PubSub.unbounded<ServerSettings>();
  let settingsSubscribers = 0;
  let keyReads = 0;
  let openEndpoints = 0;
  const connects = yield* Queue.unbounded<Endpoint>();
  const executed: Array<string> = [];
  const toolsEntered = yield* Queue.unbounded<string>();
  const toolScripts = yield* Queue.unbounded<ToolScript>();
  let finishedTools = 0;
  const watching = new Set<ThreadId>();
  const notices = yield* Queue.unbounded<VoiceAgentThreads.VoiceAgentThreadNotice>();
  const otherNotices = yield* Queue.unbounded<VoiceAgentThreads.VoiceAgentThreadNotice>();
  const noticesOf = (threadId: ThreadId) => (threadId === OTHER_THREAD ? otherNotices : notices);
  const connectGate = yield* Deferred.make<void>();
  if (options.gateConnect !== true) yield* Deferred.succeed(connectGate, undefined);

  const layer = VoiceAgentSessions.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ServerSettingsService.ServerSettingsService)({
          getSettings: Effect.sync(() => settings),
          subscribeChanges: Effect.acquireRelease(
            Effect.sync(() => settingsSubscribers++),
            () => Effect.sync(() => settingsSubscribers--),
          ).pipe(
            Effect.andThen(PubSub.subscribe(settingsChanges)),
            Effect.map((subscription) => Stream.fromSubscription(subscription)),
          ),
        }),
        Layer.mock(SecretResolver.SecretResolver)({
          read: (references) =>
            Effect.sync(() => {
              keyReads++;
              return references.map(() => options.secret);
            }),
          invalidate: () => Effect.void,
          label: () => Effect.succeed("Vault"),
        }),
        Layer.succeed(
          SecureRandom.SecureRandom,
          SecureRandom.make((size) => new Uint8Array(size).fill(7)),
        ),
        Layer.mock(VoiceAgentThreads.VoiceAgentThreads)({
          open: ({ projectId, threadId, sessionId }) =>
            options.openError !== undefined
              ? Effect.fail(options.openError)
              : Effect.succeed({
                  binding: { projectId, threadId, sessionId, calls: 0, ceiling: null },
                  context: {
                    projectTitle: "Voice project",
                    thread: threadId === null ? null : { title: "Thread one", status: "idle" },
                    agentsFile: "",
                    claudeFile: "",
                  },
                }),
          execute: (binding, call) =>
            Effect.suspend(() => {
              executed.push(call.name);
              return Queue.offer(toolsEntered, call.callId);
            }).pipe(
              Effect.andThen(Queue.take(toolScripts)),
              Effect.flatMap((script) => script(binding)),
            ),
          watch: ({ threadId }) =>
            Stream.unwrap(
              Effect.acquireRelease(
                Effect.sync(() => watching.add(threadId)),
                () => Effect.sync(() => watching.delete(threadId)),
              ).pipe(Effect.as(Stream.fromQueue(noticesOf(threadId)))),
            ),
        }),
        Layer.mock(RealtimeUpstream.RealtimeUpstream)({
          connect: (input) =>
            Effect.gen(function* () {
              const endpoint = yield* makeEndpoint(input);
              yield* Effect.acquireRelease(
                Effect.sync(() => openEndpoints++),
                () => Effect.sync(() => openEndpoints--),
              );
              yield* Queue.offer(connects, endpoint);
              yield* Deferred.await(connectGate);
              if (options.connectError !== undefined) return yield* options.connectError;
              return endpoint.connection;
            }),
        }),
      ),
    ),
  );
  const voice = Context.get(yield* Layer.build(layer), VoiceAgentSessions.VoiceAgentSessions);

  /** Accepts one client socket, as the route does after the upgrade. */
  const openClient = Effect.fn("openClient")(function* () {
    const inbound = yield* Queue.unbounded<
      Arr.NonEmptyReadonlyArray<string | Uint8Array>,
      Socket.SocketError
    >();
    const outbound = yield* Queue.unbounded<string | Uint8Array | Socket.CloseEvent>();
    let sendBufferBytes = 0;
    const gone = new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1001 }) });
    const serving = yield* voice
      .serve({
        client: Socket.make({
          reader: Effect.succeed({ pull: Queue.take(inbound), upgrade: () => Effect.void }),
          writer: Effect.succeed({
            write: (chunk) => Effect.asVoid(Queue.offer(outbound, chunk)),
            writeAll: (chunks) => Effect.asVoid(Queue.offerAll(outbound, chunks)),
          }),
        }),
        sendBufferBytes: () => sendBufferBytes,
      })
      .pipe(Effect.forkScoped);
    const decode = (frame: string | Uint8Array | Socket.CloseEvent) =>
      typeof frame === "string" ? decodeEvent(frame) : frame;
    const next = Effect.map(Queue.take(outbound), decode);
    /** The next JSON event, failing the test on anything else. */
    const nextEvent = Effect.map(next, (frame) => {
      if (frame instanceof Uint8Array || Socket.isCloseEvent(frame)) {
        throw new Error("Expected a JSON event from the session.");
      }
      return frame;
    });
    return {
      serving,
      /** One pulled batch: JSON for objects, the text itself for strings, binary as it is. */
      send: (first: object | string | Uint8Array, ...rest: Array<object | string | Uint8Array>) =>
        Effect.asVoid(
          Queue.offer(inbound, [
            encodeFrame(first),
            ...rest.map(encodeFrame),
          ] as Arr.NonEmptyReadonlyArray<string | Uint8Array>),
        ),
      next,
      nextEvent,
      /** Every frame up to and including the first event of the given type. */
      until: Effect.fn("until")(function* (type: VoiceAgentEvent["type"]) {
        const frames: Array<VoiceAgentEvent | Uint8Array | Socket.CloseEvent> = [];
        while (true) {
          const frame = yield* next;
          frames.push(frame);
          if (!(frame instanceof Uint8Array) && !Socket.isCloseEvent(frame) && frame.type === type)
            return frames;
        }
      }),
      /** Waits for this many frames and requires each to be audio; the total byte length. */
      audioFrames: Effect.fn("audioFrames")(function* (count: number) {
        let bytes = 0;
        for (let index = 0; index < count; index++) {
          const frame = yield* next;
          if (!(frame instanceof Uint8Array)) {
            throw new Error(`Expected audio frame ${index + 1} of ${count}.`);
          }
          expect(frame.byteLength % 2).toBe(0);
          expect(frame.byteLength).toBeLessThanOrEqual(VOICE_AGENT_MAX_AUDIO_FRAME_BYTES);
          bytes += frame.byteLength;
        }
        return bytes;
      }),
      /** Frames already written and not yet read. */
      written: Effect.map(Queue.clear(outbound), (frames) => frames.map(decode)),
      /** The client's socket closes without a word. */
      disconnect: Effect.asVoid(Queue.fail(inbound, gone)),
      setSendBufferBytes: (bytes: number) => {
        sendBufferBytes = bytes;
      },
    };
  });

  return {
    openClient,
    connects,
    executed,
    /** The call id of the next tool call that began to run, waiting for it. */
    toolEntered: Queue.take(toolsEntered),
    finishedTools: () => finishedTools,
    releaseConnect: Effect.asVoid(Deferred.succeed(connectGate, undefined)),
    watching,
    keyReads: () => keyReads,
    settingsSubscribers: () => settingsSubscribers,
    openEndpoints: () => openEndpoints,
    updateSettings: (next: ServerSettings) =>
      Effect.suspend(() => {
        settings = next;
        return Effect.asVoid(PubSub.publish(settingsChanges, next));
      }),
    /** Queues what the next tool call answers. */
    answerTool: (answer: {
      readonly ok?: boolean;
      readonly output?: string;
      readonly threadId?: ThreadId;
      readonly gate?: Deferred.Deferred<void>;
    }) =>
      Effect.asVoid(
        Queue.offer(toolScripts, (binding) =>
          (answer.gate === undefined ? Effect.void : Deferred.await(answer.gate)).pipe(
            Effect.map(() => {
              finishedTools++;
              return {
                ok: answer.ok ?? true,
                output: answer.output ?? '{"delivery":"started"}',
                binding: {
                  ...binding,
                  calls: binding.calls + 1,
                  threadId: answer.threadId ?? binding.threadId,
                },
              };
            }),
          ),
        ),
      ),
    notify: (
      watchedThread: ThreadId,
      ...notices: ReadonlyArray<VoiceAgentThreads.VoiceAgentThreadNotice>
    ) => Effect.asVoid(Queue.offerAll(noticesOf(watchedThread), notices)),
  };
});
type Harness = Effect.Success<ReturnType<typeof makeHarness>>;
type Client = Effect.Success<ReturnType<Harness["openClient"]>>;

const encodeFrame = (frame: object | string | Uint8Array): string | Uint8Array =>
  typeof frame === "string" || frame instanceof Uint8Array ? frame : JSON.stringify(frame);

const startCommand = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  type: "start",
  projectId: PROJECT,
  endpointId: ENDPOINT,
  baseUrl: BASE_URL,
  ...overrides,
});

const voiceTest = <A, E>(
  options: HarnessOptions,
  body: (harness: Harness) => Effect.Effect<A, E, Scope.Scope>,
) => Effect.scoped(Effect.flatMap(makeHarness(options), body));

/** A session that reached `ready`, bound to `threadId` when one is given. */
const liveSession = Effect.fn("liveSession")(function* (harness: Harness, threadId?: ThreadId) {
  const client = yield* harness.openClient();
  yield* client.send(startCommand(threadId === undefined ? {} : { threadId }));
  const endpoint = yield* Queue.take(harness.connects);
  expect(yield* client.nextEvent).toEqual({ type: "ready", threadId: threadId ?? null });
  return { client, endpoint };
});

/** Lets time pass in a live session whose client keeps sending microphone frames. */
const advance = Effect.fn("advance")(function* (
  client: Client,
  endpoint: Endpoint,
  milliseconds: number,
) {
  for (let left = milliseconds; left > 0; left -= MIC_INTERVAL_MS) {
    yield* client.send(MIC_FRAME);
    // The frame was read, so the session heard its client before the clock moves.
    yield* endpoint.nextMicrophone;
    yield* TestClock.adjust(Math.min(left, MIC_INTERVAL_MS));
  }
});

/**
 * The session ended the way a client can hear: `closed` is the last frame, then the socket closes,
 * and nothing the session took from a shared service is still held.
 */
const expectClosed = Effect.fn("expectClosed")(function* (
  harness: Harness,
  client: Client,
  /** A failure carries the server's sentence; the three normal endings carry none. */
  ending: "ended" | "idle" | "time-limit" | VoiceAgentError,
  code: number,
) {
  const frames = yield* client.until("closed");
  expect(frames.at(-1)).toEqual(
    typeof ending === "string"
      ? { type: "closed", reason: ending }
      : { type: "closed", reason: ending.reason, message: ending.message },
  );
  const close = yield* client.next;
  expect(Socket.isCloseEvent(close) && close.code).toBe(code);
  yield* Fiber.join(client.serving);
  expect(yield* client.written).toEqual([]);
  expect(harness.openEndpoints()).toBe(0);
  expect(harness.watching.size).toBe(0);
  expect(harness.settingsSubscribers()).toBe(0);
});

const failure = (reason: VoiceAgentError["reason"], endpoint?: string) =>
  new VoiceAgentError({ reason, ...(endpoint === undefined ? {} : { endpoint }) });

const approvalNotice = (threadId: ThreadId): VoiceAgentThreads.VoiceAgentThreadNotice => ({
  type: "approval-pending",
  threadId,
  requestKind: "command",
});
const settledNotice = (
  threadId: ThreadId,
  threadTitle = "Thread one",
): VoiceAgentThreads.VoiceAgentThreadNotice => ({
  type: "turn-settled",
  threadId,
  threadTitle,
  outcome: "completed",
  reply: "All tests pass.",
});

it.effect("relays microphone audio after ready and paces the agent's audio in one bracket", () =>
  voiceTest({ gateConnect: true }, (harness) =>
    Effect.gen(function* () {
      const client = yield* harness.openClient();
      yield* client.send(startCommand());
      const endpoint = yield* Queue.take(harness.connects);
      // Between `start` and `ready` there is nowhere to send microphone audio.
      yield* client.send(pcm(40));
      yield* harness.releaseConnect;
      expect(yield* client.nextEvent).toEqual({ type: "ready", threadId: null });
      // One pulled batch of consecutive frames is one append.
      yield* client.send(pcm(40), pcm(40), pcm(20));
      expect(yield* endpoint.nextMicrophone).toBe(pcm(100).byteLength);

      yield* endpoint.emit(responseStarted("resp_1"), audio("item_a", 7_000), {
        type: "audio-ended",
        itemId: "item_a",
      });
      expect(yield* client.nextEvent).toEqual({ type: "agent-speech-started", itemId: "item_a" });
      // The lead goes out as it arrives, the rest only as the playback clock advances.
      expect(yield* client.audioFrames(25)).toBe(pcm(5_000).byteLength);
      expect(yield* client.written).toEqual([]);
      yield* TestClock.adjust("1 second");
      expect(yield* client.audioFrames(5)).toBe(pcm(1_000).byteLength);
      expect(yield* client.written).toEqual([]);
      yield* TestClock.adjust("1 second");
      expect(yield* client.audioFrames(5)).toBe(pcm(1_000).byteLength);
      expect(yield* client.nextEvent).toEqual({ type: "agent-speech-done", itemId: "item_a" });

      // The endpoint finishes the transcript after the audio; a short reply is already done then.
      yield* TestClock.adjust("5 seconds");
      yield* endpoint.emit(responseEnded, responseStarted("resp_2"), audio("item_b", 400), {
        type: "audio-ended",
        itemId: "item_b",
      });
      expect((yield* client.until("agent-speech-done")).at(-1)).toEqual({
        type: "agent-speech-done",
        itemId: "item_b",
      });
      yield* endpoint.emit({ type: "caption-done", itemId: "item_b", text: "Sent." });
      expect(yield* client.nextEvent).toEqual({
        type: "caption-done",
        itemId: "item_b",
        text: "Sent.",
      });
      expect(harness.executed).toEqual([]);
    }),
  ),
);

it.effect("barge-in drops queued audio, cuts the reply and leaves the coding agent alone", () =>
  voiceTest({}, (harness) =>
    Effect.gen(function* () {
      const { client, endpoint } = yield* liveSession(harness, THREAD);
      yield* endpoint.emit(
        responseStarted("resp_1"),
        audio("item_a", 7_000),
        audio("item_b", 1_000),
      );
      yield* client.until("agent-speech-started");
      yield* client.audioFrames(25);
      yield* TestClock.adjust("1 second");
      // Six of item_a's seven seconds were sent; item_b never started.
      yield* client.audioFrames(5);

      yield* endpoint.emit({ type: "speech-started" });
      expect(yield* client.nextEvent).toEqual({ type: "user-speech-started", flushId: 0 });
      // By id, so the cancel can only hit the reply that is being cut.
      expect(yield* endpoint.nextSent).toEqual({ type: "cancel", responseId: "resp_1" });

      // Deltas the endpoint still emits for the cut items, and time for them to be paced out.
      yield* endpoint.emit(audio("item_a", 1_000), audio("item_b", 1_000), {
        type: "caption-delta",
        itemId: "item_a",
        delta: "late",
      });
      yield* TestClock.adjust("1 second");
      yield* client.send({
        type: "playback-flushed",
        flushId: 0,
        itemId: "item_a",
        playedMs: 9_000,
      });
      // Clamped to what was sent: the endpoint refuses a truncate beyond the real audio.
      expect(yield* endpoint.nextSent).toEqual({
        type: "truncate",
        itemId: "item_a",
        audioEndMs: 6_000,
      });
      expect(yield* endpoint.nextSent).toEqual({ type: "delete", itemId: "item_b" });

      // Nothing of the cut reply reached the client after the flush order.
      expect(yield* client.written).toEqual([]);
      yield* client.send({ type: "end" });
      yield* expectClosed(harness, client, "ended", 1000);
      expect(yield* endpoint.sentSoFar).toEqual([]);
      // Barge-in is between the developer and the speech model. No tool ran, so nothing was
      // dispatched to the thread: only `interrupt_agent` stops the coding agent.
      expect(harness.executed).toEqual([]);
    }),
  ),
);

it.effect("pairs playback reports with their flush by id", () =>
  voiceTest({}, (harness) =>
    Effect.gen(function* () {
      const { client, endpoint } = yield* liveSession(harness);
      yield* endpoint.emit(responseStarted("resp_1"), audio("item_a", 7_000));
      yield* client.until("agent-speech-started");
      yield* client.audioFrames(25);
      yield* TestClock.adjust("1 second");
      yield* client.audioFrames(5);

      // Flush 0 is never answered: after two seconds the pacing clock decides.
      yield* endpoint.emit({ type: "speech-started" });
      expect(yield* client.nextEvent).toEqual({ type: "user-speech-started", flushId: 0 });
      expect(yield* endpoint.nextSent).toEqual({ type: "cancel", responseId: "resp_1" });
      yield* TestClock.adjust("2 seconds");
      expect(yield* endpoint.nextSent).toEqual({
        type: "truncate",
        itemId: "item_a",
        audioEndMs: 1_000,
      });

      yield* endpoint.emit(
        { type: "speech-stopped" },
        responseEnded,
        responseStarted("resp_2"),
        audio("item_b", 3_000),
      );
      yield* client.until("agent-speech-started");
      yield* client.audioFrames(15);
      yield* TestClock.adjust("500 millis");
      yield* endpoint.emit({ type: "speech-started" });
      expect(yield* client.nextEvent).toEqual({ type: "user-speech-started", flushId: 1 });
      expect(yield* endpoint.nextSent).toEqual({ type: "cancel", responseId: "resp_2" });

      // A late answer to flush 0 and an answer to a flush that was never ordered do nothing.
      yield* client.send(
        { type: "playback-flushed", flushId: 0, itemId: "item_b", playedMs: 100 },
        { type: "playback-flushed", flushId: 7, itemId: "item_b", playedMs: 100 },
      );
      // The answer to flush 1 is the client's position, not the clock's 500 ms.
      yield* client.send({
        type: "playback-flushed",
        flushId: 1,
        itemId: "item_b",
        playedMs: 300,
      });
      expect(yield* endpoint.nextSent).toEqual({
        type: "truncate",
        itemId: "item_b",
        audioEndMs: 300,
      });
      // A second answer to flush 1 finds it closed.
      yield* client.send(
        { type: "playback-flushed", flushId: 1, itemId: "item_b", playedMs: 900 },
        { type: "end" },
      );
      yield* expectClosed(harness, client, "ended", 1000);
      expect(yield* endpoint.sentSoFar).toEqual([]);
    }),
  ),
);

it.effect("an unknown item in a report falls back to the pacing clock", () =>
  voiceTest({}, (harness) =>
    Effect.gen(function* () {
      const { client, endpoint } = yield* liveSession(harness);
      yield* endpoint.emit(responseStarted("resp_1"), audio("item_a", 2_000));
      yield* client.until("agent-speech-started");
      yield* client.audioFrames(10);
      yield* TestClock.adjust("700 millis");
      yield* endpoint.emit({ type: "speech-started" });
      yield* client.until("user-speech-started");
      yield* client.send({
        type: "playback-flushed",
        flushId: 0,
        itemId: "item_never_sent",
        playedMs: 5,
      });
      expect(yield* endpoint.nextSent).toEqual({ type: "cancel", responseId: "resp_1" });
      expect(yield* endpoint.nextSent).toEqual({
        type: "truncate",
        itemId: "item_a",
        audioEndMs: 700,
      });
    }),
  ),
);

it.effect("runs a tool call and asks for the reply only when nobody is speaking", () =>
  voiceTest({}, (harness) =>
    Effect.gen(function* () {
      const { client, endpoint } = yield* liveSession(harness, THREAD);
      yield* harness.answerTool({ output: '{"delivery":"steered"}' });
      yield* endpoint.emit(responseStarted("resp_1"), functionCall("call_1"));
      expect(yield* client.nextEvent).toEqual({
        type: "tool-activity",
        callId: "call_1",
        kind: "send-request",
        status: "started",
      });
      expect(yield* endpoint.nextSent).toEqual({
        type: "function-output",
        callId: "call_1",
        output: '{"delivery":"steered"}',
      });
      expect(yield* client.nextEvent).toEqual({
        type: "tool-activity",
        callId: "call_1",
        kind: "send-request",
        status: "completed",
      });
      // The reply that made the call is still in progress.
      expect(yield* endpoint.sentSoFar).toEqual([]);
      yield* endpoint.emit(responseEnded);
      expect(yield* endpoint.nextSent).toEqual({ type: "response", tools: true });

      // A result that arrives while the developer speaks waits for them to finish.
      yield* harness.answerTool({ ok: false, output: '{"error":"No thread."}' });
      yield* endpoint.emit(
        responseStarted("resp_2"),
        functionCall("call_2", "not_a_tool"),
        responseEnded,
        { type: "speech-started" },
      );
      expect((yield* client.until("tool-activity")).at(-1)).toEqual({
        type: "tool-activity",
        callId: "call_2",
        kind: null,
        status: "started",
      });
      expect((yield* client.until("tool-activity")).at(-1)).toEqual({
        type: "tool-activity",
        callId: "call_2",
        kind: null,
        status: "failed",
      });
      expect(yield* endpoint.nextSent).toMatchObject({ type: "function-output" });
      yield* endpoint.emit({ type: "speech-stopped" });
      yield* client.until("user-speech-stopped");
      // The endpoint is about to answer the developer itself; ours would collide with it.
      yield* TestClock.adjust("1900 millis");
      expect(yield* endpoint.sentSoFar).toEqual([]);
      yield* TestClock.adjust("100 millis");
      expect(yield* endpoint.nextSent).toEqual({ type: "response", tools: true });
      expect(harness.executed).toEqual(["send_to_agent", "not_a_tool"]);
    }),
  ),
);

it.effect("refuses a tool call when eight are already waiting", () =>
  voiceTest({}, (harness) =>
    Effect.gen(function* () {
      const { client, endpoint } = yield* liveSession(harness, THREAD);
      const gate = yield* Deferred.make<void>();
      yield* harness.answerTool({ gate });
      yield* endpoint.emit(responseStarted("resp_1"), functionCall("call_0"));
      yield* client.until("tool-activity");
      // call_0 is running; eight more fill the queue and the ninth has no place.
      yield* endpoint.emit(
        ...Array.from({ length: 9 }, (_, index) => functionCall(`call_${index + 1}`)),
      );
      const activity: Array<VoiceAgentEvent> = [];
      while (activity.length < 10) activity.push(yield* client.nextEvent);
      expect(activity.slice(0, 9)).toEqual(
        Array.from({ length: 9 }, (_, index) => ({
          type: "tool-activity",
          callId: `call_${index + 1}`,
          kind: "send-request",
          status: "started",
        })),
      );
      expect(activity[9]).toEqual({
        type: "tool-activity",
        callId: "call_9",
        kind: "send-request",
        status: "failed",
      });
      expect(yield* endpoint.nextSent).toEqual({
        type: "function-output",
        callId: "call_9",
        output: '{"error":"Too many requests at once. Try again."}',
      });
      expect(harness.executed).toEqual(["send_to_agent"]);
      // A call that began to run finishes before the session lets go, so let all of them finish.
      for (let waiting = 0; waiting < 8; waiting++) yield* harness.answerTool({});
      yield* Deferred.succeed(gate, undefined);
    }),
  ),
);

it.effect("follows a tool call to another thread", () =>
  voiceTest({}, (harness) =>
    Effect.gen(function* () {
      const { client, endpoint } = yield* liveSession(harness, THREAD);
      expect([...harness.watching]).toEqual([THREAD]);
      yield* harness.answerTool({ threadId: OTHER_THREAD, output: '{"thread":"Thread two"}' });
      yield* endpoint.emit(functionCall("call_1", "switch_thread"));
      expect((yield* client.until("thread-changed")).at(-1)).toEqual({
        type: "thread-changed",
        threadId: OTHER_THREAD,
      });
      expect(yield* endpoint.nextSent).toMatchObject({ type: "function-output" });
      // The instructions are not sent again: the tool result says where the new thread stands.
      expect(yield* endpoint.nextSent).toEqual({ type: "response", tools: true });

      // A notice for the thread the session left is dropped, wherever it comes from.
      yield* harness.notify(
        OTHER_THREAD,
        settledNotice(THREAD, "Thread one"),
        settledNotice(OTHER_THREAD, "Thread two"),
      );
      const note = yield* endpoint.nextSent;
      expect(note).toMatchObject({ type: "note" });
      expect(note.type === "note" && note.text).toContain('"Thread two"');
      expect(yield* endpoint.nextSent).toEqual({ type: "response", tools: false });
      expect([...harness.watching]).toEqual([OTHER_THREAD]);
      yield* client.send({ type: "end" });
      yield* expectClosed(harness, client, "ended", 1000);
      expect(yield* endpoint.sentSoFar).toEqual([]);
    }),
  ),
);

it.effect("appends a thread notice at once and reports it when nobody is speaking", () =>
  voiceTest({}, (harness) =>
    Effect.gen(function* () {
      const { client, endpoint } = yield* liveSession(harness, THREAD);
      // During a reply: the fact is in the conversation at once, the report follows the reply.
      yield* endpoint.emit(responseStarted("resp_1"));
      yield* harness.notify(THREAD, settledNotice(THREAD));
      const note = yield* endpoint.nextSent;
      expect(note.type === "note" && note.text).toContain("All tests pass.");
      expect(yield* endpoint.sentSoFar).toEqual([]);
      yield* endpoint.emit(responseEnded);
      // Tools off: the note carries text the coding agent wrote.
      expect(yield* endpoint.nextSent).toEqual({ type: "response", tools: false });

      // During the developer's speech, and in the grace after it, no reply is requested.
      yield* endpoint.emit({ type: "speech-started" });
      yield* client.until("user-speech-started");
      yield* harness.notify(THREAD, approvalNotice(THREAD));
      expect(yield* endpoint.nextSent).toMatchObject({ type: "note" });
      yield* endpoint.emit({ type: "speech-stopped" });
      yield* client.until("user-speech-stopped");
      yield* TestClock.adjust("1900 millis");
      expect(yield* endpoint.sentSoFar).toEqual([]);
      yield* TestClock.adjust("100 millis");
      expect(yield* endpoint.nextSent).toEqual({ type: "response", tools: false });

      // With a tool result waiting as well, the one reply may use tools.
      yield* harness.answerTool({});
      yield* endpoint.emit(responseStarted("resp_2"), functionCall("call_1"));
      expect(yield* endpoint.nextSent).toMatchObject({ type: "function-output" });
      yield* harness.notify(THREAD, settledNotice(THREAD));
      expect(yield* endpoint.nextSent).toMatchObject({ type: "note" });
      yield* endpoint.emit(responseEnded);
      expect(yield* endpoint.nextSent).toEqual({ type: "response", tools: true });
      yield* client.send({ type: "end" });
      yield* expectClosed(harness, client, "ended", 1000);
      expect(yield* endpoint.sentSoFar).toEqual([]);
    }),
  ),
);

it.effect("cancels a reply that outgrows the pacing queue and still plays what it holds", () =>
  voiceTest({}, (harness) =>
    Effect.gen(function* () {
      const { client, endpoint } = yield* liveSession(harness);
      const megabyte = new Uint8Array(1_000_000);
      const delta: RealtimeUpstream.RealtimeEvent = {
        type: "audio",
        itemId: "item_a",
        pcm: megabyte,
      };
      // Fourteen megabytes fit under the five minutes the session may hold; the next does not.
      yield* endpoint.emit(responseStarted("resp_1"), ...Array.from({ length: 15 }, () => delta));
      expect(yield* endpoint.nextSent).toEqual({ type: "cancel", responseId: "resp_1" });
      yield* endpoint.emit(delta, { type: "response-ended", status: "cancelled" });

      yield* advance(client, endpoint, 300_000);
      const frames = yield* client.until("agent-speech-done");
      const audioBytes = frames.reduce(
        (bytes, frame) => bytes + (frame instanceof Uint8Array ? frame.byteLength : 0),
        0,
      );
      expect(audioBytes).toBe(14 * megabyte.byteLength);
      expect(frames.filter((frame) => !(frame instanceof Uint8Array))).toEqual([
        { type: "agent-speech-started", itemId: "item_a" },
        { type: "agent-speech-done", itemId: "item_a" },
      ]);
      expect(yield* endpoint.sentSoFar).toEqual([]);
    }),
  ),
);

it.effect("holds agent audio back from a client that is not reading", () =>
  voiceTest({}, (harness) =>
    Effect.gen(function* () {
      const { client, endpoint } = yield* liveSession(harness);
      client.setSendBufferBytes(512 * 1024);
      yield* endpoint.emit(responseStarted("resp_1"), audio("item_a", 1_000));
      yield* endpoint.emit({ type: "speech-stopped" });
      // Events still pass; audio waits for the socket to drain.
      expect(yield* client.nextEvent).toEqual({ type: "user-speech-stopped" });
      yield* TestClock.adjust("1 second");
      expect(yield* client.written).toEqual([]);
      client.setSendBufferBytes(0);
      yield* TestClock.adjust("250 millis");
      expect(yield* client.nextEvent).toEqual({ type: "agent-speech-started", itemId: "item_a" });
      expect(yield* client.audioFrames(5)).toBe(pcm(1_000).byteLength);
    }),
  ),
);

it.effect("drops microphone audio while the endpoint socket is backed up", () =>
  voiceTest({}, (harness) =>
    Effect.gen(function* () {
      const { client, endpoint } = yield* liveSession(harness);
      endpoint.backUpOnce();
      yield* client.send(pcm(40));
      // The first frame was dropped, not kept for later.
      yield* client.send(pcm(20));
      expect(yield* endpoint.nextMicrophone).toBe(pcm(20).byteLength);
    }),
  ),
);

it.effect("stays open while the thread works and ends once it has been quiet", () =>
  voiceTest({}, (harness) =>
    Effect.gen(function* () {
      // Unbound: the first request launches the thread, which is working from the first moment.
      const { client, endpoint } = yield* liveSession(harness);
      yield* harness.answerTool({ threadId: THREAD });
      yield* endpoint.emit(functionCall("call_1"));
      yield* client.until("thread-changed");
      yield* harness.notify(
        THREAD,
        { type: "activity", threadId: THREAD, busy: true },
        approvalNotice(THREAD),
      );
      expect(yield* endpoint.nextSent).toMatchObject({ type: "function-output" });
      expect(yield* endpoint.nextSent).toEqual({ type: "response", tools: true });
      expect(yield* endpoint.nextSent).toMatchObject({ type: "note" });
      expect(yield* endpoint.nextSent).toEqual({ type: "response", tools: false });

      yield* advance(client, endpoint, 360_000);
      expect(yield* client.written).toEqual([]);

      yield* harness.notify(
        THREAD,
        { type: "activity", threadId: THREAD, busy: false },
        settledNotice(THREAD),
      );
      expect(yield* endpoint.nextSent).toMatchObject({ type: "note" });
      yield* advance(client, endpoint, 290_000);
      expect(yield* client.written).toEqual([]);
      yield* advance(client, endpoint, 10_000);
      yield* expectClosed(harness, client, "idle", 1000);
    }),
  ),
);

it.effect("idles after switching from a working thread to a quiet one", () =>
  voiceTest({}, (harness) =>
    Effect.gen(function* () {
      const { client, endpoint } = yield* liveSession(harness, THREAD);
      yield* harness.notify(
        THREAD,
        { type: "activity", threadId: THREAD, busy: true },
        approvalNotice(THREAD),
      );
      expect(yield* endpoint.nextSent).toMatchObject({ type: "note" });
      yield* harness.answerTool({ threadId: OTHER_THREAD });
      yield* endpoint.emit(functionCall("call_1", "switch_thread"));
      yield* client.until("thread-changed");
      // The new thread's watcher has said nothing yet; the old thread's "working" must not stick.
      yield* advance(client, endpoint, 300_000);
      yield* expectClosed(harness, client, "idle", 1000);
    }),
  ),
);

type Ending = {
  readonly name: string;
  readonly ending: Parameters<typeof expectClosed>[2];
  readonly code: number;
  readonly options?: HarnessOptions;
  /** Brings the session to the point where it must end. */
  readonly drive: (harness: Harness, client: Client) => Effect.Effect<void, never, Scope.Scope>;
};

/** Starts on a thread and waits for `ready`. */
const ready = Effect.fn("ready")(function* (harness: Harness, client: Client) {
  yield* client.send(startCommand({ threadId: THREAD }));
  const endpoint = yield* Queue.take(harness.connects);
  expect(yield* client.nextEvent).toEqual({ type: "ready", threadId: THREAD });
  return endpoint;
});

const endings: ReadonlyArray<Ending> = [
  {
    name: "the end command",
    ending: "ended",
    code: 1000,
    drive: Effect.fn(function* (harness, client) {
      yield* ready(harness, client);
      yield* client.send({ type: "end" });
    }),
  },
  {
    name: "the end command while the endpoint is still being dialed",
    ending: "ended",
    code: 1000,
    options: { gateConnect: true },
    drive: Effect.fn(function* (harness, client) {
      yield* client.send(startCommand());
      yield* Queue.take(harness.connects);
      yield* client.send({ type: "playback-flushed", flushId: 0, itemId: null, playedMs: 0 });
      yield* client.send({ type: "end" });
    }),
  },
  {
    name: "no start command in time",
    ending: failure("client-timeout"),
    code: 1008,
    drive: () => TestClock.adjust("10 seconds"),
  },
  {
    name: "a client that goes silent after ready, and not before it",
    ending: failure("client-timeout"),
    code: 1008,
    options: { gateConnect: true },
    drive: Effect.fn(function* (harness, client) {
      yield* client.send(startCommand());
      yield* Queue.take(harness.connects);
      // A client sends nothing between `start` and `ready`, however long the dial takes.
      yield* TestClock.adjust("20 seconds");
      expect(yield* client.written).toEqual([]);
      yield* harness.releaseConnect;
      expect(yield* client.nextEvent).toEqual({ type: "ready", threadId: null });
      yield* TestClock.adjust("14 seconds");
      expect(yield* client.written).toEqual([]);
      yield* TestClock.adjust("1 second");
    }),
  },
  {
    name: "five idle minutes",
    ending: "idle",
    code: 1000,
    drive: Effect.fn(function* (harness, client) {
      const endpoint = yield* ready(harness, client);
      yield* advance(client, endpoint, 290_000);
      expect(yield* client.written).toEqual([]);
      yield* advance(client, endpoint, 10_000);
    }),
  },
  {
    name: "the hard cap, while the thread is still working",
    ending: "time-limit",
    code: 1000,
    drive: Effect.fn(function* (harness, client) {
      const endpoint = yield* ready(harness, client);
      yield* harness.notify(
        THREAD,
        { type: "activity", threadId: THREAD, busy: true },
        approvalNotice(THREAD),
      );
      yield* endpoint.nextSent;
      yield* advance(client, endpoint, 29 * 60_000);
      expect(yield* client.written).toEqual([]);
      yield* advance(client, endpoint, 60_000);
    }),
  },
  {
    name: "a second start command",
    ending: failure("protocol"),
    code: 1008,
    drive: Effect.fn(function* (harness, client) {
      yield* ready(harness, client);
      yield* client.send(startCommand());
    }),
  },
  {
    name: "a command before start",
    ending: failure("protocol"),
    code: 1008,
    drive: (_harness, client) => client.send({ type: "end" }),
  },
  {
    name: "a binary frame before start",
    ending: failure("protocol"),
    code: 1008,
    drive: (_harness, client) => client.send(pcm(40)),
  },
  {
    name: "an odd binary frame, after one of exactly the maximum was accepted",
    ending: failure("protocol"),
    code: 1008,
    drive: Effect.fn(function* (harness, client) {
      const endpoint = yield* ready(harness, client);
      yield* client.send(new Uint8Array(VOICE_AGENT_MAX_AUDIO_FRAME_BYTES));
      expect(yield* endpoint.nextMicrophone).toBe(VOICE_AGENT_MAX_AUDIO_FRAME_BYTES);
      yield* client.send(new Uint8Array(41));
    }),
  },
  {
    name: "an oversized binary frame",
    ending: failure("protocol"),
    code: 1008,
    drive: Effect.fn(function* (harness, client) {
      yield* ready(harness, client);
      yield* client.send(new Uint8Array(VOICE_AGENT_MAX_AUDIO_FRAME_BYTES + 2));
    }),
  },
  {
    name: "a malformed known command",
    ending: failure("protocol"),
    code: 1008,
    drive: Effect.fn(function* (harness, client) {
      yield* ready(harness, client);
      yield* client.send({ type: "playback-flushed", flushId: "zero", itemId: null, playedMs: 0 });
    }),
  },
  {
    name: "text that is not JSON",
    ending: failure("protocol"),
    code: 1008,
    drive: (_harness, client) => client.send("start"),
  },
  {
    name: "the end command, after a command type from a newer client was skipped",
    ending: "ended",
    code: 1000,
    drive: Effect.fn(function* (harness, client) {
      yield* ready(harness, client);
      yield* client.send({ type: "mute", muted: true }, { type: "end" });
    }),
  },
  {
    name: "the endpoint closing its socket",
    ending: failure("endpoint-closed", "Gateway"),
    code: 1011,
    drive: Effect.fn(function* (harness, client) {
      const endpoint = yield* ready(harness, client);
      yield* endpoint.fail(failure("endpoint-closed", "Gateway"));
    }),
  },
  {
    name: "a refused connect",
    ending: new VoiceAgentError({ reason: "endpoint-refused", endpoint: "Gateway", status: 401 }),
    code: 1011,
    options: {
      connectError: new VoiceAgentError({
        reason: "endpoint-refused",
        endpoint: "Gateway",
        status: 401,
      }),
    },
    drive: (_harness, client) => client.send(startCommand({ threadId: THREAD })),
  },
];

it.effect.each(endings)("ends with closed as the last frame on $name", (row) =>
  voiceTest(row.options ?? {}, (harness) =>
    Effect.gen(function* () {
      const client = yield* harness.openClient();
      yield* row.drive(harness, client);
      yield* expectClosed(harness, client, row.ending, row.code);
    }),
  ),
);

it.effect("releases the endpoint when the client goes away, after the tool call in flight", () =>
  voiceTest({}, (harness) =>
    Effect.gen(function* () {
      const { client, endpoint } = yield* liveSession(harness, THREAD);
      const gate = yield* Deferred.make<void>();
      yield* harness.answerTool({ gate });
      yield* endpoint.emit(functionCall("call_1"));
      yield* client.until("tool-activity");
      expect(yield* harness.toolEntered).toBe("call_1");
      yield* client.disconnect;
      // The request that started to be dispatched finishes before the session lets go.
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(client.serving);
      expect(harness.finishedTools()).toBe(1);
      expect(harness.openEndpoints()).toBe(0);
      expect(harness.watching.size).toBe(0);
      expect(harness.settingsSubscribers()).toBe(0);
      // Nobody is left to tell.
      expect(yield* client.written).toEqual([]);
    }),
  ),
);

it.effect("lets go of everything when the route interrupts a revoked session", () =>
  voiceTest({}, (harness) =>
    Effect.gen(function* () {
      const { client, endpoint } = yield* liveSession(harness, THREAD);
      yield* endpoint.emit(responseStarted("resp_1"), audio("item_a", 7_000));
      yield* client.until("agent-speech-started");
      yield* client.audioFrames(25);
      // What the route does when the client's session is revoked.
      yield* Fiber.interrupt(client.serving);
      expect(harness.openEndpoints()).toBe(0);
      expect(harness.watching.size).toBe(0);
      expect(harness.settingsSubscribers()).toBe(0);
      // No `closed` event and no more audio: the route destroys the socket.
      yield* TestClock.adjust("10 seconds");
      expect(yield* client.written).toEqual([]);
      expect(yield* endpoint.sentSoFar).toEqual([]);
    }),
  ),
);

it.effect.each([
  {
    name: "the Labs switch is off",
    options: { settings: settingsWith({}, { voiceModeEnabled: false }) },
    start: {},
    reason: "not-enabled",
  },
  {
    name: "no text generator has a voice model",
    options: { settings: settingsWith({ voiceModel: "" }) },
    start: {},
    reason: "not-configured",
  },
  {
    name: "the device consented to another endpoint",
    options: { settings: settingsWith({ apiKey: VAULT_KEY }), secret: KEY },
    start: { endpointId: "another-gateway" },
    reason: "not-configured",
  },
  {
    name: "the device consented to another address",
    options: { settings: settingsWith({ apiKey: VAULT_KEY }), secret: KEY },
    start: { baseUrl: "https://attacker.example/v1" },
    reason: "not-configured",
  },
  {
    name: "the project is gone",
    options: {
      settings: settingsWith({ apiKey: VAULT_KEY }),
      secret: KEY,
      openError: new VoiceAgentError({ reason: "not-found" }),
    },
    start: {},
    reason: "not-found",
  },
  {
    name: "the key cannot be read",
    options: { settings: settingsWith({ apiKey: VAULT_KEY }), secret: undefined },
    start: {},
    reason: "endpoint-unreadable-key",
  },
] as const)("refuses without dialing when $name", ({ options, start, reason }) =>
  voiceTest(options, (harness) =>
    Effect.gen(function* () {
      const client = yield* harness.openClient();
      yield* client.send(startCommand(start));
      const unreadable = reason === "endpoint-unreadable-key";
      yield* expectClosed(
        harness,
        client,
        failure(reason, unreadable ? "Gateway" : undefined),
        unreadable ? 1011 : 1008,
      );
      // Nothing was dialed, and only the session that got as far as the key read it.
      expect(yield* Queue.size(harness.connects)).toBe(0);
      expect(harness.keyReads()).toBe(unreadable ? 1 : 0);
    }),
  ),
);

it.effect("sends the saved key only to the address it was saved for", () =>
  voiceTest({ settings: settingsWith({ apiKey: VAULT_KEY }), secret: KEY }, (harness) =>
    Effect.gen(function* () {
      const { client, endpoint } = yield* liveSession(harness);
      expect(endpoint.input.baseUrl).toBe(BASE_URL);
      expect(endpoint.input.model).toBe("voice-model");
      expect(endpoint.input.label).toBe("Gateway");
      expect(endpoint.input.apiKey && Redacted.value(endpoint.input.apiKey)).toBe(KEY);
      expect(endpoint.input.instructions).toContain("Project: Voice project");

      // An unrelated settings change leaves the session alone.
      yield* harness.updateSettings(settingsWith({ apiKey: VAULT_KEY, label: "Renamed" }));
      // Re-pointing the endpoint ends it: a save that changes the address clears a kept key.
      const moved = "https://elsewhere.example/v1";
      yield* harness.updateSettings(settingsWith({ baseUrl: moved, apiKey: "" }));
      yield* expectClosed(harness, client, failure("not-configured"), 1008);

      const second = yield* harness.openClient();
      // A client that has not seen the change yet is refused, and nothing is dialed for it.
      yield* second.send(startCommand());
      yield* expectClosed(harness, second, failure("not-configured"), 1008);
      expect(yield* Queue.size(harness.connects)).toBe(0);

      const third = yield* harness.openClient();
      yield* third.send(startCommand({ baseUrl: moved }));
      const next = yield* Queue.take(harness.connects);
      expect(next.input.baseUrl).toBe(moved);
      // The old key does not follow the endpoint to its new address.
      expect(next.input.apiKey).toBeUndefined();
      expect(yield* third.nextEvent).toEqual({ type: "ready", threadId: null });
    }),
  ),
);

it.effect.each([
  {
    name: "the Labs switch is turned off",
    next: settingsWith({}, { voiceModeEnabled: false }),
    reason: "not-enabled",
  },
  {
    name: "the key is replaced",
    next: settingsWith({ apiKey: "sk-another-key" }),
    reason: "not-configured",
  },
  {
    name: "the voice model is changed",
    next: settingsWith({ voiceModel: "another-voice-model" }),
    reason: "not-configured",
  },
] as const)("ends a live session when $name", ({ next, reason }) =>
  voiceTest({}, (harness) =>
    Effect.gen(function* () {
      const { client } = yield* liveSession(harness, THREAD);
      yield* harness.updateSettings(next);
      yield* expectClosed(harness, client, failure(reason), 1008);
    }),
  ),
);
