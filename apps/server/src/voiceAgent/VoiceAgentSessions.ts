// One voice session: the client's media socket on one side, the realtime endpoint on the other.
// A single loop fiber owns the session state and is the only writer to the client, so events and
// audio cannot reorder and `closed` is always last. Everything else only puts into its mailbox.
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import {
  AuthOrchestrationOperateScope,
  ReceivedVoiceAgentCommand,
  SettingsSecretValue,
  VOICE_AGENT_FLUSH_REPORT_TIMEOUT_MS,
  VOICE_AGENT_IDLE_TIMEOUT_MS,
  VOICE_AGENT_MAX_AUDIO_FRAME_BYTES,
  VOICE_AGENT_MAX_COMMAND_BYTES,
  VOICE_AGENT_MAX_QUEUED_INPUT_BYTES,
  VOICE_AGENT_MAX_QUEUED_OUTPUT_BYTES,
  VOICE_AGENT_MAX_SESSION_MS,
  VOICE_AGENT_PLAYBACK_LEAD_MS,
  VOICE_AGENT_SILENCE_TIMEOUT_MS,
  VOICE_AGENT_START_TIMEOUT_MS,
  VOICE_AGENT_STREAM_PATH,
  type VoiceAgentActivityKind,
  type VoiceAgentCloseReason,
  type VoiceAgentCommand,
  VoiceAgentError,
  type VoiceAgentEvent,
  isSecretReference,
  isUnknownUnionMember,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { resolveVoiceAgent, type VoiceAgentResolution } from "@t3tools/shared/voiceAgent";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";

import { authenticateMediaRequest, failEnvironmentInternal } from "../auth/http.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import * as ServerSettings from "../serverSettings.ts";
import { generatorLabel } from "../textGeneration/TextGenerators.ts";
import { type FlushSnapshot, makePacedOutput, type PacedChunk } from "./outputPacing.ts";
import * as RealtimeUpstream from "./RealtimeUpstream.ts";
import * as VoiceAgentThreads from "./VoiceAgentThreads.ts";
import {
  buildVoiceAgentInstructions,
  VOICE_AGENT_TOOL_ERRORS,
  VOICE_AGENT_TOOLS,
  voiceAgentNote,
} from "./voiceAgentPrompt.ts";

export class VoiceAgentSessions extends Context.Service<
  VoiceAgentSessions,
  {
    /**
     * Runs one voice session on an accepted client socket until it ends. Every ending the client
     * can still hear about is sent as `closed` before this returns.
     */
    readonly serve: (input: {
      readonly client: Socket.Socket;
      /** Bytes written to the client and not yet sent, to hold audio back from a stalled one. */
      readonly sendBufferBytes: () => number;
    }) => Effect.Effect<void>;
  }
>()("t3/voiceAgent/VoiceAgentSessions") {}

type ResolvedVoiceAgent = Extract<VoiceAgentResolution, { readonly available: true }>;
type FunctionCall = Extract<RealtimeUpstream.RealtimeEvent, { readonly type: "function-call" }>;
type StartCommand = Extract<VoiceAgentCommand, { readonly type: "start" }>;

interface LiveSession {
  readonly connection: RealtimeUpstream.RealtimeConnection;
  readonly resolved: ResolvedVoiceAgent;
  readonly binding: VoiceAgentThreads.VoiceAgentBinding;
}

type SessionInput =
  | { readonly _tag: "command"; readonly command: VoiceAgentCommand }
  | { readonly _tag: "violation" }
  | { readonly _tag: "started"; readonly live: LiveSession }
  | { readonly _tag: "failed"; readonly error: VoiceAgentError }
  | {
      readonly _tag: "upstream";
      readonly events: ReadonlyArray<RealtimeUpstream.RealtimeEvent>;
    }
  | {
      readonly _tag: "tool-result";
      readonly callId: string;
      readonly outcome: VoiceAgentThreads.VoiceAgentToolOutcome;
    }
  | { readonly _tag: "notice"; readonly notice: VoiceAgentThreads.VoiceAgentThreadNotice }
  | { readonly _tag: "start-deadline" }
  | { readonly _tag: "deadline"; readonly reason: "client-timeout" | "idle" | "time-limit" };

const MAILBOX_CAPACITY = 256;
const TOOL_QUEUE_CAPACITY = 8;
const MAX_OPEN_FLUSHES = 8;
/** The contract's five seconds of microphone PCM, as the base64 the upstream socket carries. */
const UPSTREAM_SEND_HIGH_WATER_BYTES = Math.ceil((VOICE_AGENT_MAX_QUEUED_INPUT_BYTES * 4) / 3);
const CLIENT_SEND_HIGH_WATER_BYTES = 256 * 1024;
// The endpoint creates its own reply when the user stops speaking; ours must not collide with it.
const AUTO_RESPONSE_GRACE_MS = 2_000;
const KEY_READ_TIMEOUT = "5 seconds";
const RESPONSE_FAILED_MESSAGE = "The voice model could not produce a reply. Try again.";
const TOO_MANY_CALLS_OUTPUT = JSON.stringify({ error: VOICE_AGENT_TOOL_ERRORS.tooManyCalls });
const TOOL_FAILED_OUTPUT = JSON.stringify({ error: VOICE_AGENT_TOOL_ERRORS.failed });

const decodeCommand = Schema.decodeUnknownOption(Schema.fromJsonString(ReceivedVoiceAgentCommand));
const sameCredential = Schema.toEquivalence(SettingsSecretValue);

const TOOL_KINDS: ReadonlyMap<string, VoiceAgentActivityKind> = new Map(
  VOICE_AGENT_TOOLS.map((tool) => [tool.name, tool.kind]),
);

const closeCode = (reason: VoiceAgentCloseReason): number => {
  switch (reason) {
    case "ended":
    case "idle":
    case "time-limit":
      return 1000;
    case "protocol":
    case "client-timeout":
    case "not-enabled":
    case "not-configured":
    case "not-found":
      return 1008;
    default:
      return 1011;
  }
};

const unavailable = (resolution: Extract<VoiceAgentResolution, { readonly available: false }>) =>
  new VoiceAgentError({
    reason: resolution.reason === "not-enabled" ? "not-enabled" : "not-configured",
  });

/** Whether settings still send this session's audio to the same place with the same key. */
const sameDestination = (started: ResolvedVoiceAgent, now: ResolvedVoiceAgent): boolean =>
  now.endpointId === started.endpointId &&
  now.endpoint.baseUrl === started.endpoint.baseUrl &&
  now.model === started.model &&
  sameCredential(now.endpoint.apiKey, started.endpoint.apiKey);

const chunkFrame = (chunk: PacedChunk): string | Uint8Array => {
  switch (chunk.type) {
    case "start":
      return JSON.stringify({
        type: "agent-speech-started",
        itemId: chunk.itemId,
      } satisfies VoiceAgentEvent);
    case "audio":
      return chunk.bytes;
    case "caption":
      return JSON.stringify(chunk.event satisfies VoiceAgentEvent);
    case "done":
      return JSON.stringify({
        type: "agent-speech-done",
        itemId: chunk.itemId,
      } satisfies VoiceAgentEvent);
  }
};

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const resolver = yield* SecretResolver.SecretResolver;
  const threads = yield* VoiceAgentThreads.VoiceAgentThreads;
  const upstream = yield* RealtimeUpstream.RealtimeUpstream;
  const random = yield* SecureRandom.SecureRandom;

  const startSession = Effect.fn("VoiceAgentSessions.start")(function* (
    command: StartCommand,
    mailbox: Queue.Queue<SessionInput>,
    scope: Scope.Scope,
  ) {
    const internal = (stage: string) => (error: { readonly _tag: string }) =>
      Effect.logWarning("A voice session could not start.", { stage, errorTag: error._tag }).pipe(
        Effect.andThen(Effect.fail(new VoiceAgentError({ reason: "internal" }))),
      );
    // Subscribed before the read, so a change between the two is not lost.
    const changes = yield* settingsService.subscribeChanges.pipe(Scope.provide(scope));
    const settings = yield* settingsService.getSettings.pipe(Effect.catch(internal("settings")));
    const resolved = resolveVoiceAgent(settings, command.projectId);
    if (!resolved.available) return yield* unavailable(resolved);
    // The device consented to one destination. Anything else is refused before the key is read
    // and before anything is dialed; nothing from the command is ever used to connect.
    if (
      command.endpointId !== resolved.endpointId ||
      command.baseUrl !== resolved.endpoint.baseUrl
    ) {
      return yield* new VoiceAgentError({ reason: "not-configured" });
    }
    // A live session does not survive its destination changing: the Labs switch turned off, the
    // endpoint removed or re-pointed, the voice model or the key replaced.
    yield* changes.pipe(
      Stream.map((next) => resolveVoiceAgent(next, command.projectId)),
      Stream.filter((next) => !next.available || !sameDestination(resolved, next)),
      Stream.take(1),
      Stream.runForEach((next) =>
        Queue.offer(mailbox, {
          _tag: "failed",
          error: next.available
            ? new VoiceAgentError({ reason: "not-configured" })
            : unavailable(next),
        }),
      ),
      Effect.forkIn(scope),
    );
    const sessionId = yield* random.uuidV4();
    const { binding, context } = yield* threads.open({
      projectId: command.projectId,
      threadId: command.threadId ?? null,
      sessionId,
      ...(command.launch === undefined ? {} : { launch: command.launch }),
    });
    const label = generatorLabel(resolved.endpoint);
    const unreadable = () =>
      new VoiceAgentError({ reason: "endpoint-unreadable-key", endpoint: label });
    const source = resolved.endpoint.apiKey;
    // A vault that locked since the last session must not authorize a new one.
    if (isSecretReference(source)) yield* resolver.invalidate([source]);
    const key = yield* requireSettingsSecret(resolver, source).pipe(
      Effect.mapError(unreadable),
      Effect.timeoutOrElse({
        duration: KEY_READ_TIMEOUT,
        orElse: () => Effect.fail(unreadable()),
      }),
    );
    const connection = yield* upstream
      .connect({
        baseUrl: resolved.endpoint.baseUrl,
        // An empty saved key means a keyless local gateway: no header.
        apiKey: key === "" ? undefined : Redacted.make(key),
        model: resolved.model,
        label,
        instructions: buildVoiceAgentInstructions(context),
        tools: VOICE_AGENT_TOOLS,
      })
      .pipe(Scope.provide(scope));
    return { connection, resolved, binding } satisfies LiveSession;
  });

  const serve: VoiceAgentSessions["Service"]["serve"] = Effect.fn("VoiceAgentSessions.serve")(
    function* (input) {
      const scope = yield* Scope.Scope;
      // Acquiring the reader completes the upgrade.
      const acquired = yield* input.client.reader.pipe(Effect.option);
      if (Option.isNone(acquired)) return;
      const reader = acquired.value;
      const writer = yield* input.client.writer;
      const mailbox = yield* Queue.bounded<SessionInput>(MAILBOX_CAPACITY);
      const heard = yield* Queue.sliding<void>(1);
      const activity = yield* Queue.sliding<void>(1);
      const toolCalls = yield* Queue.dropping<FunctionCall>(TOOL_QUEUE_CAPACITY);
      const output = makePacedOutput({
        leadMs: VOICE_AGENT_PLAYBACK_LEAD_MS,
        maxQueuedBytes: VOICE_AGENT_MAX_QUEUED_OUTPUT_BYTES,
      });

      // Mutable, and touched only by the loop fiber. `micSink` is the one exception: the loop
      // sets it and the client reader reads it.
      let phase: "awaiting-start" | "starting" | "live" = "awaiting-start";
      let live: LiveSession | undefined;
      let micSink: RealtimeUpstream.RealtimeConnection | undefined;
      let binding: VoiceAgentThreads.VoiceAgentBinding | undefined;
      let watcher: Fiber.Fiber<void> | undefined;
      let userSpeaking = false;
      let responseActive = false;
      // Our `response.create` is out and the endpoint has not answered it yet.
      let responseRequested = false;
      let activeResponseId: string | undefined;
      let awaitingAutoResponseUntil: number | undefined;
      // "report": only a `[T3 Code]` note waits to be spoken. "full": a tool result waits.
      let wantResponse: "no" | "report" | "full" = "no";
      let toolsRunning = 0;
      let threadBusy = false;
      let nextFlushId = 0;
      let outputWakeAt: number | undefined;
      let closeReason: VoiceAgentCloseReason | undefined;
      let toolCallCount = 0;
      let bargeIns = 0;
      let droppedMicFrames = 0;
      // Flushes the client has not answered yet, by the id sent with `user-speech-started`.
      const openFlushes = new Map<
        number,
        { readonly snapshot: FlushSnapshot; readonly deadlineAt: number }
      >();
      const runningTools = new Map<string, VoiceAgentActivityKind | null>();

      const offer = (message: SessionInput) => Queue.offer(mailbox, message);
      const signalActivity = Queue.offer(activity, undefined);
      // A failed write means the client is going away, and the client reader reports that.
      const send = (event: VoiceAgentEvent) => Effect.ignore(writer.write(JSON.stringify(event)));

      const close = Effect.fn("VoiceAgentSessions.close")(function* (
        reason: VoiceAgentCloseReason,
        message?: string,
      ) {
        micSink = undefined;
        closeReason = reason;
        yield* send({ type: "closed", reason, ...(message === undefined ? {} : { message }) });
        yield* Effect.ignore(writer.write(new Socket.CloseEvent(closeCode(reason))));
        return true;
      });
      const fail = (error: VoiceAgentError) => close(error.reason, error.message);

      // One reply at a time, and never on top of the user or of a reply the endpoint is about to
      // start. Untraced: it runs per upstream event inside the `VoiceAgentSessions.serve` span.
      const maybeRespond = Effect.fnUntraced(function* (
        connection: RealtimeUpstream.RealtimeConnection,
      ) {
        if (
          wantResponse === "no" ||
          responseActive ||
          responseRequested ||
          userSpeaking ||
          toolsRunning > 0
        ) {
          return;
        }
        if (awaitingAutoResponseUntil !== undefined) return;
        // A reply that only reports a note may not call tools: the note carries the coding
        // agent's text.
        const tools = wantResponse === "full";
        wantResponse = "no";
        responseRequested = true;
        yield* connection.createResponse({ tools });
      });

      // Items play in the order sent, so one position describes all of them.
      const applyFlush = (
        connection: RealtimeUpstream.RealtimeConnection,
        snapshot: FlushSnapshot,
        report: FlushSnapshot["estimate"],
      ): Effect.Effect<void> => {
        const position = (at: FlushSnapshot["estimate"]) =>
          at.itemId === null
            ? snapshot.sent.length
            : snapshot.sent.findIndex((item) => item.itemId === at.itemId);
        let heard = report;
        let at = position(report);
        // An id this server never sent: fall back to its own clock.
        if (at === -1) {
          heard = snapshot.estimate;
          at = position(heard);
        }
        const sends: Array<Effect.Effect<void>> = [];
        const current = snapshot.sent[at];
        if (current !== undefined) {
          // The endpoint refuses a truncate beyond the audio it generated.
          const heardMs = Math.min(heard.playedMs, current.sentMs);
          sends.push(
            heardMs === 0
              ? connection.deleteItem(current.itemId)
              : connection.truncate(current.itemId, heardMs),
          );
        }
        for (const item of snapshot.sent.slice(at + 1)) {
          sends.push(connection.deleteItem(item.itemId));
        }
        for (const itemId of snapshot.unsent) sends.push(connection.deleteItem(itemId));
        return Effect.all(sends, { discard: true });
      };

      const startWatcher = Effect.fn("VoiceAgentSessions.startWatcher")(function* (
        target: VoiceAgentThreads.VoiceAgentBinding,
      ) {
        if (watcher !== undefined) yield* Fiber.interrupt(watcher);
        watcher = undefined;
        // The new watcher's first notice reports the real value.
        threadBusy = false;
        const { projectId, threadId } = target;
        if (threadId === null) return;
        watcher = yield* threads.watch({ projectId, threadId }).pipe(
          Stream.runForEach((notice) => offer({ _tag: "notice", notice })),
          Effect.forkIn(scope),
        );
      });

      // finishTool, onSpeechStarted, onUpstreamEvent and onLiveInput run per upstream event or
      // client input; `VoiceAgentSessions.serve` is their span.
      const finishTool = Effect.fnUntraced(function* (
        connection: RealtimeUpstream.RealtimeConnection,
        callId: string,
        ok: boolean,
        toolOutput: string,
      ) {
        toolsRunning--;
        const kind = runningTools.get(callId) ?? null;
        runningTools.delete(callId);
        yield* connection.sendFunctionOutput(callId, toolOutput);
        yield* send({
          type: "tool-activity",
          callId,
          kind,
          status: ok ? "completed" : "failed",
        });
      });

      // Barge-in. Nothing here reaches orchestration: the coding agent keeps working.
      const onSpeechStarted = Effect.fnUntraced(function* (
        connection: RealtimeUpstream.RealtimeConnection,
        now: number,
      ) {
        userSpeaking = true;
        bargeIns++;
        const snapshot = output.flush(now);
        outputWakeAt = undefined;
        const flushId = nextFlushId++;
        openFlushes.set(flushId, {
          snapshot,
          deadlineAt: now + VOICE_AGENT_FLUSH_REPORT_TIMEOUT_MS,
        });
        if (openFlushes.size > MAX_OPEN_FLUSHES) {
          for (const [oldestId, oldest] of openFlushes) {
            openFlushes.delete(oldestId);
            yield* applyFlush(connection, oldest.snapshot, oldest.snapshot.estimate);
            break;
          }
        }
        // By id, so it can only hit the reply being cut, never the reply to the interruption.
        if (responseActive) yield* connection.cancelResponse(activeResponseId);
        yield* send({ type: "user-speech-started", flushId });
      });

      const onUpstreamEvent = Effect.fnUntraced(function* (
        connection: RealtimeUpstream.RealtimeConnection,
        event: RealtimeUpstream.RealtimeEvent,
        now: number,
      ) {
        switch (event.type) {
          case "speech-started":
            yield* onSpeechStarted(connection, now);
            return yield* signalActivity;
          case "speech-stopped":
            userSpeaking = false;
            awaitingAutoResponseUntil = now + AUTO_RESPONSE_GRACE_MS;
            yield* send({ type: "user-speech-stopped" });
            return yield* signalActivity;
          case "response-started":
            responseActive = true;
            activeResponseId = event.responseId;
            // The endpoint's own reply already has every note and tool result in its context. Ours
            // may not have what arrived after we asked for it, so that still gets a reply.
            if (!responseRequested) wantResponse = "no";
            responseRequested = false;
            awaitingAutoResponseUntil = undefined;
            return yield* signalActivity;
          case "response-ended":
            responseActive = false;
            responseRequested = false;
            activeResponseId = undefined;
            output.endAll();
            if (event.status === "failed") {
              yield* send({
                type: "error",
                code: "response-failed",
                message: RESPONSE_FAILED_MESSAGE,
              });
            }
            yield* maybeRespond(connection);
            return yield* signalActivity;
          case "response-refused":
            responseRequested = false;
            return yield* send({
              type: "error",
              code: "response-failed",
              message: RESPONSE_FAILED_MESSAGE,
            });
          case "audio":
            // Held audio still plays out; only the generation stops.
            if (output.push(event.itemId, event.pcm) === "overflow") {
              yield* connection.cancelResponse(activeResponseId);
            }
            return;
          case "audio-ended":
            output.end(event.itemId);
            return;
          case "caption-delta":
          case "caption-done":
            output.caption(event.itemId, event);
            return;
          case "function-call": {
            toolCallCount++;
            toolsRunning++;
            const kind = TOOL_KINDS.get(event.name) ?? null;
            runningTools.set(event.callId, kind);
            yield* send({
              type: "tool-activity",
              callId: event.callId,
              kind,
              status: "started",
            });
            if (!(yield* Queue.offer(toolCalls, event))) {
              yield* finishTool(connection, event.callId, false, TOO_MANY_CALLS_OUTPUT);
              wantResponse = "full";
              yield* maybeRespond(connection);
            }
            return yield* signalActivity;
          }
        }
      });

      const onLiveInput = Effect.fnUntraced(function* (
        session: LiveSession,
        message: Extract<
          SessionInput,
          { readonly _tag: "command" | "upstream" | "tool-result" | "notice" }
        >,
      ) {
        const { connection } = session;
        switch (message._tag) {
          case "command": {
            const { command } = message;
            if (command.type === "end") return yield* close("ended");
            if (command.type === "start") {
              return yield* fail(new VoiceAgentError({ reason: "protocol" }));
            }
            // A report for a flush that is not open (answered, timed out, never issued) is
            // ignored, so it can never touch a later reply.
            const flush = openFlushes.get(command.flushId);
            if (flush === undefined) return false;
            openFlushes.delete(command.flushId);
            yield* applyFlush(connection, flush.snapshot, command);
            return false;
          }
          case "upstream": {
            const now = yield* Clock.currentTimeMillis;
            for (const event of message.events) yield* onUpstreamEvent(connection, event, now);
            return false;
          }
          case "tool-result": {
            const { outcome } = message;
            yield* finishTool(connection, message.callId, outcome.ok, outcome.output);
            const previous = binding;
            binding = outcome.binding;
            if (
              outcome.binding.threadId !== null &&
              outcome.binding.threadId !== previous?.threadId
            ) {
              yield* send({ type: "thread-changed", threadId: outcome.binding.threadId });
              yield* startWatcher(outcome.binding);
            }
            wantResponse = "full";
            yield* maybeRespond(connection);
            yield* signalActivity;
            return false;
          }
          case "notice": {
            const { notice } = message;
            // A watcher that was replaced may still have had a notice in the mailbox.
            if (notice.threadId !== binding?.threadId) return false;
            if (notice.type === "activity") {
              threadBusy = notice.busy;
            } else {
              // In the conversation at once, so any later reply sees it; spoken when nobody is.
              yield* connection.injectNote(voiceAgentNote(notice));
              if (wantResponse === "no") wantResponse = "report";
              yield* maybeRespond(connection);
            }
            yield* signalActivity;
            return false;
          }
        }
      });

      const idleTimer = Effect.gen(function* () {
        while (true) {
          const active = yield* Queue.take(activity).pipe(
            Effect.timeoutOption(VOICE_AGENT_IDLE_TIMEOUT_MS),
          );
          // A working coding agent keeps the session open; the hard cap still ends it.
          if (Option.isNone(active) && !threadBusy && toolsRunning === 0) {
            return yield* offer({ _tag: "deadline", reason: "idle" });
          }
        }
      });

      const silenceTimer = Effect.gen(function* () {
        while (true) {
          const frame = yield* Queue.take(heard).pipe(
            Effect.timeoutOption(VOICE_AGENT_SILENCE_TIMEOUT_MS),
          );
          if (Option.isNone(frame)) {
            return yield* offer({ _tag: "deadline", reason: "client-timeout" });
          }
        }
      });

      const goLive = Effect.fn("VoiceAgentSessions.goLive")(function* (session: LiveSession) {
        const { connection } = session;
        phase = "live";
        live = session;
        binding = session.binding;
        micSink = connection;
        yield* connection.events.pipe(
          Effect.flatMap((events) =>
            events.length === 0 ? Effect.void : offer({ _tag: "upstream", events }),
          ),
          Effect.forever,
          Effect.catch((error) => offer({ _tag: "failed", error })),
          Effect.forkIn(scope),
        );
        // One worker: calls run in arrival order because each may change the binding.
        let workerBinding = session.binding;
        yield* Queue.take(toolCalls).pipe(
          Effect.flatMap((call) =>
            // A request that started to be dispatched finishes even when the client hangs up.
            Effect.uninterruptible(threads.execute(workerBinding, call)).pipe(
              // A defect still answers the call, or the session would wait for it for good.
              Effect.catchDefect((defect) =>
                Effect.logError("A voice agent tool call died.", defect).pipe(
                  Effect.as({
                    ok: false,
                    output: TOOL_FAILED_OUTPUT,
                    binding: { ...workerBinding, calls: workerBinding.calls + 1 },
                  }),
                ),
              ),
              Effect.flatMap((outcome) => {
                workerBinding = outcome.binding;
                return offer({ _tag: "tool-result", callId: call.callId, outcome });
              }),
            ),
          ),
          Effect.forever,
          Effect.forkIn(scope),
        );
        yield* startWatcher(session.binding);
        // Not armed earlier: between `start` and `ready` a client sends nothing.
        yield* Effect.forkIn(silenceTimer, scope);
        yield* Effect.forkIn(idleTimer, scope);
        yield* send({ type: "ready", threadId: session.binding.threadId });
        yield* signalActivity;
      });

      // Runs for every input of the session; `VoiceAgentSessions.serve` is the span. True once
      // `closed` was sent.
      const handle = Effect.fnUntraced(function* (message: SessionInput) {
        switch (message._tag) {
          case "violation":
            return yield* fail(new VoiceAgentError({ reason: "protocol" }));
          case "deadline":
            return message.reason === "client-timeout"
              ? yield* fail(new VoiceAgentError({ reason: "client-timeout" }))
              : yield* close(message.reason);
          case "start-deadline":
            return phase === "awaiting-start"
              ? yield* fail(new VoiceAgentError({ reason: "client-timeout" }))
              : false;
          case "failed":
            return yield* fail(message.error);
          case "started":
            yield* goLive(message.live);
            return false;
          case "command":
            if (phase === "awaiting-start") {
              const { command } = message;
              if (command.type !== "start") {
                return yield* fail(new VoiceAgentError({ reason: "protocol" }));
              }
              phase = "starting";
              yield* startSession(command, mailbox, scope).pipe(
                Effect.matchEffect({
                  onFailure: (error) => offer({ _tag: "failed", error }),
                  onSuccess: (started) => offer({ _tag: "started", live: started }),
                }),
                Effect.catchDefect((defect) =>
                  Effect.logError("A voice session could not start.", defect).pipe(
                    Effect.andThen(
                      offer({ _tag: "failed", error: new VoiceAgentError({ reason: "internal" }) }),
                    ),
                  ),
                ),
                Effect.forkIn(scope),
              );
              return false;
            }
            if (phase === "starting") {
              if (message.command.type === "end") return yield* close("ended");
              return message.command.type === "start"
                ? yield* fail(new VoiceAgentError({ reason: "protocol" }))
                : false;
            }
            break;
          default:
            break;
        }
        return live === undefined ? false : yield* onLiveInput(live, message);
      });

      // Runs after every input and at every deadline of the loop.
      const tick = Effect.fnUntraced(function* (session: LiveSession) {
        const { connection } = session;
        const now = yield* Clock.currentTimeMillis;
        for (const [flushId, flush] of openFlushes) {
          if (flush.deadlineAt > now) continue;
          openFlushes.delete(flushId);
          yield* applyFlush(connection, flush.snapshot, flush.snapshot.estimate);
        }
        if (awaitingAutoResponseUntil !== undefined && awaitingAutoResponseUntil <= now) {
          awaitingAutoResponseUntil = undefined;
        }
        yield* maybeRespond(connection);
        const taken = output.take(now, input.sendBufferBytes() <= CLIENT_SEND_HIGH_WATER_BYTES);
        outputWakeAt = taken.nextAtMs;
        const [first, ...rest] = taken.chunks.map(chunkFrame);
        if (first === undefined) return;
        yield* Effect.ignore(writer.writeAll([first, ...rest]));
        if (taken.chunks.some((chunk) => chunk.type === "audio")) yield* signalActivity;
      });

      const nextWakeAt = (): number | undefined => {
        let wakeAt = outputWakeAt;
        const earlier = (at: number | undefined) => {
          if (at !== undefined && (wakeAt === undefined || at < wakeAt)) wakeAt = at;
        };
        earlier(awaitingAutoResponseUntil);
        for (const flush of openFlushes.values()) earlier(flush.deadlineAt);
        return wakeAt;
      };

      const loop = Effect.gen(function* () {
        while (true) {
          let message = yield* Queue.poll(mailbox);
          if (Option.isNone(message)) {
            const wakeAt = live === undefined ? undefined : nextWakeAt();
            if (wakeAt === undefined) {
              message = Option.some(yield* Queue.take(mailbox));
            } else {
              const wait = wakeAt - (yield* Clock.currentTimeMillis);
              if (wait > 0) message = yield* Queue.take(mailbox).pipe(Effect.timeoutOption(wait));
            }
          }
          if (Option.isSome(message) && (yield* handle(message.value))) return;
          if (live !== undefined) yield* tick(live);
        }
      });

      // Runs for every client frame. Microphone audio skips the mailbox, so its latency never
      // waits behind agent audio; it touches no session state except `micSink`.
      const readClient = Effect.gen(function* () {
        let startSeen = false;
        let violated = false;
        while (true) {
          const frames = yield* reader.pull;
          yield* Queue.offer(heard, undefined);
          // After a violation the loop sends `closed`; keep reading only to notice the close.
          if (violated) continue;
          let audio: Array<Uint8Array> = [];
          const forwardAudio = Effect.suspend(() => {
            const [first, ...rest] = audio;
            audio = [];
            if (first === undefined || micSink === undefined) return Effect.void;
            // A burst after a network stall becomes one upstream event.
            return micSink.appendAudio(rest.length === 0 ? first : Buffer.concat([first, ...rest]));
          });
          for (const frame of frames) {
            if (typeof frame === "string") {
              yield* forwardAudio;
              if (Buffer.byteLength(frame, "utf8") > VOICE_AGENT_MAX_COMMAND_BYTES) {
                violated = true;
                break;
              }
              const command = decodeCommand(frame);
              // A malformed known command is a violation; a type from a newer client is skipped.
              if (Option.isNone(command)) {
                violated = true;
                break;
              }
              if (isUnknownUnionMember(command.value)) continue;
              if (command.value.type === "start") startSeen = true;
              yield* offer({ _tag: "command", command: command.value });
              continue;
            }
            if (
              !startSeen ||
              frame.byteLength < 2 ||
              frame.byteLength % 2 !== 0 ||
              frame.byteLength > VOICE_AGENT_MAX_AUDIO_FRAME_BYTES
            ) {
              violated = true;
              break;
            }
            // Between `start` and `ready` there is nowhere to send it.
            if (micSink === undefined) continue;
            // Arriving audio is dropped, not the oldest: what a socket already buffered cannot be
            // taken back, and late live audio is worth nothing.
            if (micSink.bufferedBytes() > UPSTREAM_SEND_HIGH_WATER_BYTES) {
              droppedMicFrames++;
              continue;
            }
            audio.push(frame);
          }
          if (violated) {
            yield* offer({ _tag: "violation" });
          } else {
            yield* forwardAudio;
          }
        }
      });

      yield* Effect.sleep(VOICE_AGENT_START_TIMEOUT_MS).pipe(
        Effect.andThen(offer({ _tag: "start-deadline" })),
        Effect.forkIn(scope),
      );
      yield* Effect.sleep(VOICE_AGENT_MAX_SESSION_MS).pipe(
        Effect.andThen(offer({ _tag: "deadline", reason: "time-limit" })),
        Effect.forkIn(scope),
      );

      // The loop returns once it has sent `closed`; the reader returns when the client is gone.
      // Nothing is written after the race: the scope then closes the endpoint socket, the watcher,
      // the timers and the settings subscription, after a tool call in flight has finished.
      yield* Effect.raceFirst(loop, readClient).pipe(
        Effect.ignore,
        Effect.ensuring(
          // Bounded values only: never a caption, a tool argument, a model name or a key.
          Effect.suspend(() =>
            Effect.annotateCurrentSpan({
              "voice.project_id": binding?.projectId ?? "none",
              "voice.thread_bound": binding !== undefined && binding.threadId !== null,
              "voice.close_reason": closeReason ?? "client-gone",
              "voice.tool_calls": toolCallCount,
              "voice.barge_ins": bargeIns,
              "voice.mic_frames_dropped": droppedMicFrames,
            }),
          ),
        ),
      );
    },
    Effect.scoped,
  );

  return VoiceAgentSessions.of({ serve });
});

export const layer = Layer.effect(VoiceAgentSessions, make);

// The service is taken when the layer is built, so it is wired beside the route; the auth
// services stay request-level, as for the other media routes.
export const routeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const voice = yield* VoiceAgentSessions;
    return HttpRouter.add(
      "GET",
      VOICE_AGENT_STREAM_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.headers.upgrade?.toLowerCase() !== "websocket") {
          return HttpServerResponse.text("Bad Request", { status: 400 });
        }
        const session = yield* authenticateMediaRequest(AuthOrchestrationOperateScope);
        const sessions = yield* SessionStore.SessionStore;
        const transport = NodeHttpServerRequest.toIncomingMessage(request).socket;
        const invalidated = sessions
          .awaitInvalidation(session.sessionId, session.proofKeyThumbprint)
          .pipe(
            Effect.catchTags({
              SessionCredentialVerificationError: (error) =>
                failEnvironmentInternal("internal_error", error).pipe(Effect.ignore),
            }),
          );
        const client = yield* request.upgrade;
        // A revoked session gets no `closed` event: its socket is destroyed.
        yield* Effect.raceFirst(
          voice
            .serve({ client, sendBufferBytes: () => transport.writableLength })
            .pipe(Effect.onInterrupt(() => Effect.sync(() => transport.destroy()))),
          invalidated,
        );
        return HttpServerResponse.empty();
      }),
    );
  }),
);
