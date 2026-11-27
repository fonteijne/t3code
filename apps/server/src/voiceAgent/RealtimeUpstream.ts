// The OpenAI-Realtime-compatible WebSocket adapter. Vendor event names stop in this module; a
// second protocol would be a second layer for the same tag.
import * as NodeWS from "@effect/platform-node/NodeWS";
import { VOICE_AGENT_MAX_COMMAND_BYTES, VoiceAgentError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";

/** What a realtime speech endpoint reports, in this server's words. Vendor names stop here. */
export type RealtimeEvent =
  | { readonly type: "speech-started" }
  | { readonly type: "speech-stopped" }
  | { readonly type: "response-started"; readonly responseId: string | undefined }
  | {
      readonly type: "response-ended";
      readonly status: "completed" | "cancelled" | "failed" | "incomplete";
    }
  | { readonly type: "audio"; readonly itemId: string; readonly pcm: Uint8Array }
  | { readonly type: "audio-ended"; readonly itemId: string }
  | { readonly type: "caption-delta"; readonly itemId: string; readonly delta: string }
  | { readonly type: "caption-done"; readonly itemId: string; readonly text: string }
  | {
      readonly type: "function-call";
      readonly callId: string;
      readonly name: string;
      /** JSON text as the model wrote it. */
      readonly arguments: string;
    }
  /** The endpoint refused one of our `createResponse` requests. */
  | { readonly type: "response-refused" };

export interface RealtimeUpstreamInput {
  /** The saved text generator's base URL. Never a client-provided value. */
  readonly baseUrl: string;
  /** Undefined when the saved key is empty: keyless local gateways get no header. */
  readonly apiKey: Redacted.Redacted<string> | undefined;
  readonly model: string;
  /** The text generator's label or host, for error messages only. */
  readonly label: string;
  readonly instructions: string;
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  }>;
}

export interface RealtimeConnection {
  /** The next batch of events, possibly empty. Fails once the endpoint closes or breaks. */
  readonly events: Effect.Effect<ReadonlyArray<RealtimeEvent>, VoiceAgentError>;
  readonly appendAudio: (pcm: Uint8Array) => Effect.Effect<void>;
  /** `tools: false` asks for a reply that only speaks (a report of a `[T3 Code]` note). */
  readonly createResponse: (options: { readonly tools: boolean }) => Effect.Effect<void>;
  readonly cancelResponse: (responseId: string | undefined) => Effect.Effect<void>;
  readonly sendFunctionOutput: (callId: string, output: string) => Effect.Effect<void>;
  readonly injectNote: (text: string) => Effect.Effect<void>;
  readonly truncate: (itemId: string, audioEndMs: number) => Effect.Effect<void>;
  readonly deleteItem: (itemId: string) => Effect.Effect<void>;
  /** Bytes handed to the socket and not yet on the wire. */
  readonly bufferedBytes: () => number;
}

export class RealtimeUpstream extends Context.Service<
  RealtimeUpstream,
  {
    /** Opens and configures a session. The connection closes with the scope. */
    readonly connect: (
      input: RealtimeUpstreamInput,
    ) => Effect.Effect<RealtimeConnection, VoiceAgentError, Scope.Scope>;
  }
>()("t3/voiceAgent/RealtimeUpstream") {}

const UPSTREAM_OPEN_TIMEOUT = "6 seconds";
const UPSTREAM_HANDSHAKE_TIMEOUT = "6 seconds";
const UPSTREAM_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
/** The length limit of `VoiceAgentItemId`; also applied to call and response ids. */
const MAX_ID_LENGTH = 256;
const MAX_FUNCTION_NAME_LENGTH = 64;
/** Keeps a caption event for the client well inside `VOICE_AGENT_MAX_COMMAND_BYTES`. */
const MAX_CAPTION_LENGTH = 16_000;
const MAX_SEEN_CALLS = 256;
const RESPONSE_EVENT_PREFIX = "t3-response-";
const QUIET_EVENT_PREFIX = "t3-quiet-";

/** `https://gw.example/v1` + `gpt-realtime-2.1` -> `wss://gw.example/v1/realtime?model=gpt-realtime-2.1`. */
const realtimeUrl = (baseUrl: string, model: string): URL => {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/realtime`;
  url.searchParams.set("model", model);
  return url;
};

const UpstreamItem = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  call_id: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  arguments: Schema.optionalKey(Schema.String),
});
const UpstreamEvent = Schema.Struct({
  type: Schema.String,
  item_id: Schema.optionalKey(Schema.String),
  delta: Schema.optionalKey(Schema.String),
  transcript: Schema.optionalKey(Schema.String),
  item: Schema.optionalKey(UpstreamItem),
  response: Schema.optionalKey(
    Schema.Struct({
      id: Schema.optionalKey(Schema.String),
      status: Schema.optionalKey(Schema.String),
      output: Schema.optionalKey(Schema.Array(UpstreamItem)),
    }),
  ),
  error: Schema.optionalKey(
    Schema.Struct({
      type: Schema.optionalKey(Schema.NullOr(Schema.String)),
      code: Schema.optionalKey(Schema.NullOr(Schema.String)),
      event_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
});
type UpstreamItem = typeof UpstreamItem.Type;
type UpstreamEvent = typeof UpstreamEvent.Type;

const decodeUpstreamEvent = Schema.decodeUnknownOption(Schema.fromJsonString(UpstreamEvent));
const frameDecoder = new TextDecoder();

/** A frame that is not one of the events read here is skipped. */
const decodeFrame = (frame: string | Uint8Array): UpstreamEvent | undefined =>
  Option.getOrUndefined(
    decodeUpstreamEvent(typeof frame === "string" ? frame : frameDecoder.decode(frame)),
  );

// `ws` reports a refused upgrade as an `error` whose message is this text with the HTTP status
// (ws/lib/websocket.js, the `response` handler of the upgrade request).
const REFUSED_UPGRADE = /Unexpected server response: (\d{3})/;

const messageOf = (value: unknown): string | undefined =>
  Predicate.hasProperty(value, "message") && typeof value.message === "string"
    ? value.message
    : undefined;

/**
 * Why a dial failed. Two reasons, and the status is passed on, not interpreted. The socket error
 * is dropped here on purpose: its cause references the request and with it the key.
 */
const upgradeFailure = (error: Socket.SocketError, label: string): VoiceAgentError => {
  const cause = error.reason._tag === "SocketOpenError" ? error.reason.cause : undefined;
  const message =
    messageOf(cause) ??
    (Predicate.hasProperty(cause, "error") ? messageOf(cause.error) : undefined);
  const status = Number(REFUSED_UPGRADE.exec(message ?? "")?.[1]);
  return Number.isInteger(status) && status < 500
    ? new VoiceAgentError({ reason: "endpoint-refused", endpoint: label, status })
    : new VoiceAgentError({ reason: "endpoint-unreachable", endpoint: label });
};

const sessionUpdate = (input: RealtimeUpstreamInput): string =>
  JSON.stringify({
    type: "session.update",
    session: {
      type: "realtime",
      output_modalities: ["audio"],
      instructions: input.instructions,
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
      // Only these four keys: a strict endpoint answers an unknown session parameter with an error.
      tools: input.tools.map(({ name, description, parameters }) => ({
        type: "function",
        name,
        description,
        parameters,
      })),
      tool_choice: "auto",
    },
  });

const appendAudioEvent = (pcm: Uint8Array): string =>
  `{"type":"input_audio_buffer.append","audio":"${Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64")}"}`;

const createResponseEvent = (eventId: string, tools: boolean): string =>
  JSON.stringify({
    type: "response.create",
    event_id: eventId,
    ...(tools ? {} : { response: { tool_choice: "none" } }),
  });

const cancelResponseEvent = (eventId: string, responseId: string | undefined): string =>
  JSON.stringify({
    type: "response.cancel",
    event_id: eventId,
    ...(responseId === undefined ? {} : { response_id: responseId }),
  });

const functionOutputEvent = (callId: string, output: string): string =>
  JSON.stringify({
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: callId, output },
  });

// Role `system`: the note is the app's words, not the developer's speech.
const noteEvent = (text: string): string =>
  JSON.stringify({
    type: "conversation.item.create",
    item: { type: "message", role: "system", content: [{ type: "input_text", text }] },
  });

const truncateEvent = (eventId: string, itemId: string, audioEndMs: number): string =>
  JSON.stringify({
    type: "conversation.item.truncate",
    event_id: eventId,
    item_id: itemId,
    content_index: 0,
    audio_end_ms: audioEndMs,
  });

const deleteItemEvent = (eventId: string, itemId: string): string =>
  JSON.stringify({ type: "conversation.item.delete", event_id: eventId, item_id: itemId });

/** An endpoint's own word for an error, cut down to something safe to log. */
const logToken = (value: string | null | undefined) => value?.replace(/[^\w.-]/g, "").slice(0, 64);

const boundedId = (id: string | undefined): string | undefined =>
  id !== undefined && id.length > 0 && id.length <= MAX_ID_LENGTH ? id : undefined;

const responseStatus = (
  status: string | undefined,
): Extract<RealtimeEvent, { readonly type: "response-ended" }>["status"] =>
  status === "completed" || status === "cancelled" || status === "failed" ? status : "incomplete";

type TranslationWarning =
  | { readonly type: "oversized-call" }
  | {
      readonly type: "endpoint-error";
      readonly code: string | undefined;
      readonly errorType: string | undefined;
    };

/** Turns the endpoint's events into `RealtimeEvent`s. Holds the function calls already seen. */
const makeTranslator = () => {
  const seenCalls = new Set<string>();

  const functionCall = (
    item: UpstreamItem,
    events: Array<RealtimeEvent>,
  ): TranslationWarning | undefined => {
    if (item.type !== "function_call") return undefined;
    // A call cut off by an interruption arrives `incomplete` and must not run.
    if (item.status !== undefined && item.status !== "completed") return undefined;
    const { call_id: callId, name } = item;
    if (callId === undefined || name === undefined || seenCalls.has(callId)) return undefined;
    const args = item.arguments ?? "";
    if (
      callId.length > MAX_ID_LENGTH ||
      name.length > MAX_FUNCTION_NAME_LENGTH ||
      args.length > VOICE_AGENT_MAX_COMMAND_BYTES
    ) {
      return { type: "oversized-call" };
    }
    seenCalls.add(callId);
    if (seenCalls.size > MAX_SEEN_CALLS) {
      for (const oldest of seenCalls) {
        seenCalls.delete(oldest);
        break;
      }
    }
    events.push({ type: "function-call", callId, name, arguments: args });
    return undefined;
  };

  return (event: UpstreamEvent, events: Array<RealtimeEvent>): TranslationWarning | undefined => {
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        events.push({ type: "speech-started" });
        return undefined;
      case "input_audio_buffer.speech_stopped":
        events.push({ type: "speech-stopped" });
        return undefined;
      case "response.created":
        events.push({ type: "response-started", responseId: boundedId(event.response?.id) });
        return undefined;
      case "response.output_audio.delta":
      case "response.audio.delta": {
        const itemId = boundedId(event.item_id);
        if (itemId === undefined || event.delta === undefined) return undefined;
        events.push({ type: "audio", itemId, pcm: Buffer.from(event.delta, "base64") });
        return undefined;
      }
      case "response.output_audio.done":
      case "response.audio.done": {
        const itemId = boundedId(event.item_id);
        if (itemId !== undefined) events.push({ type: "audio-ended", itemId });
        return undefined;
      }
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta": {
        const itemId = boundedId(event.item_id);
        if (itemId === undefined || event.delta === undefined) return undefined;
        events.push({
          type: "caption-delta",
          itemId,
          delta: event.delta.slice(0, MAX_CAPTION_LENGTH),
        });
        return undefined;
      }
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done": {
        const itemId = boundedId(event.item_id);
        if (itemId === undefined || event.transcript === undefined) return undefined;
        events.push({
          type: "caption-done",
          itemId,
          text: event.transcript.slice(0, MAX_CAPTION_LENGTH),
        });
        return undefined;
      }
      case "response.output_item.done":
        return event.item === undefined ? undefined : functionCall(event.item, events);
      case "response.done": {
        let warning: TranslationWarning | undefined;
        if (event.response?.status === "completed") {
          for (const item of event.response.output ?? []) {
            warning = functionCall(item, events) ?? warning;
          }
        }
        events.push({ type: "response-ended", status: responseStatus(event.response?.status) });
        return warning;
      }
      case "error":
        // Only a refused reply matters to the user. A refused cancel, truncate or delete is
        // expected in normal operation, for example a cancel with nothing in progress.
        if (event.error?.event_id?.startsWith(RESPONSE_EVENT_PREFIX) === true) {
          events.push({ type: "response-refused" });
        }
        return {
          type: "endpoint-error",
          code: logToken(event.error?.code),
          errorType: logToken(event.error?.type),
        };
      default:
        return undefined;
    }
  };
};

const connect = Effect.fn("RealtimeUpstream.connect")(
  function* (input: RealtimeUpstreamInput) {
    const refused = new VoiceAgentError({ reason: "endpoint-refused", endpoint: input.label });
    const closed = new VoiceAgentError({ reason: "endpoint-closed", endpoint: input.label });
    const url = yield* Effect.try({
      try: () => realtimeUrl(input.baseUrl, input.model),
      catch: () => new VoiceAgentError({ reason: "endpoint-unreachable", endpoint: input.label }),
    });
    // Protocol and host only: the path carries the model, the headers carry the key.
    yield* Effect.annotateCurrentSpan({
      "voice.endpoint.protocol": url.protocol,
      "voice.endpoint.host": url.host,
    });
    // Never log `raw`: it holds the upgrade request and with it the `Authorization` header.
    let raw: NodeWS.WebSocket | undefined;
    const socket = yield* Socket.makeWebSocket(url.href, {
      openTimeout: UPSTREAM_OPEN_TIMEOUT,
    }).pipe(
      // `ws`, not Node's global WebSocket: it reports the status of a refused upgrade, never
      // follows a redirect (the key stays on the origin it was saved for) and pauses reads.
      Effect.provideService(Socket.WebSocketConstructor, (target) => {
        raw = new NodeWS.WebSocket(target, {
          maxPayload: UPSTREAM_MAX_PAYLOAD_BYTES,
          ...(input.apiKey === undefined
            ? {}
            : { headers: { authorization: `Bearer ${Redacted.value(input.apiKey)}` } }),
        });
        // Effect drops its listeners before closing a socket that is still connecting, and `ws`
        // then emits an `error` nobody handles, which exits the server.
        raw.addEventListener("error", () => undefined);
        return raw;
      }),
    );
    const reader = yield* socket.reader.pipe(
      Effect.mapError((error) => upgradeFailure(error, input.label)),
    );
    const writer = yield* socket.writer;
    // A failed write means the socket is going away, and `events` reports that.
    const send = (event: string) => Effect.ignore(writer.write(event));
    const pull = Effect.mapError(reader.pull, () => closed);

    // Frames that arrived in one batch with `session.updated`, for the first `events` pull.
    let early: ReadonlyArray<string | Uint8Array> = yield* Effect.gen(function* () {
      let updateSent = false;
      while (true) {
        const frames = yield* pull;
        for (let index = 0; index < frames.length; index++) {
          const event = decodeFrame(frames[index]!);
          if (event === undefined) continue;
          if (event.type === "error") return yield* refused;
          if (!updateSent && event.type === "session.created") {
            yield* send(sessionUpdate(input));
            updateSent = true;
          } else if (updateSent && event.type === "session.updated") {
            return frames.slice(index + 1);
          }
        }
      }
    }).pipe(
      // The socket opened but never became a realtime session.
      Effect.timeoutOrElse({
        duration: UPSTREAM_HANDSHAKE_TIMEOUT,
        orElse: () => Effect.fail(refused),
      }),
    );

    const translate = makeTranslator();
    // Runs for every frame of the session; the connect span covers it.
    const events = Effect.fnUntraced(function* () {
      const frames = early.length > 0 ? early : yield* pull;
      early = [];
      const translated: Array<RealtimeEvent> = [];
      for (const frame of frames) {
        const event = decodeFrame(frame);
        if (event === undefined) continue;
        const warning = translate(event, translated);
        if (warning === undefined) continue;
        yield* warning.type === "oversized-call"
          ? Effect.logWarning("voice endpoint sent an oversized function call")
          : Effect.logWarning("voice endpoint reported an error", {
              code: warning.code,
              type: warning.errorType,
            });
      }
      return translated;
    });

    let responseRequests = 0;
    let quietRequests = 0;
    const quietId = () => `${QUIET_EVENT_PREFIX}${quietRequests++}`;

    return {
      events: events(),
      appendAudio: (pcm) => send(appendAudioEvent(pcm)),
      createResponse: ({ tools }) =>
        Effect.suspend(() =>
          send(createResponseEvent(`${RESPONSE_EVENT_PREFIX}${responseRequests++}`, tools)),
        ),
      cancelResponse: (responseId) =>
        Effect.suspend(() => send(cancelResponseEvent(quietId(), responseId))),
      sendFunctionOutput: (callId, output) => send(functionOutputEvent(callId, output)),
      injectNote: (text) => send(noteEvent(text)),
      truncate: (itemId, audioEndMs) =>
        Effect.suspend(() => send(truncateEvent(quietId(), itemId, audioEndMs))),
      deleteItem: (itemId) => Effect.suspend(() => send(deleteItemEvent(quietId(), itemId))),
      bufferedBytes: () => raw?.bufferedAmount ?? 0,
    } satisfies RealtimeConnection;
  },
  // Reason and status only: the socket error behind a failed dial can reference the key.
  Effect.tapError((error) =>
    Effect.logWarning("voice endpoint refused the session", {
      reason: error.reason,
      status: error.status,
    }),
  ),
);

export const layer = Layer.succeed(RealtimeUpstream, RealtimeUpstream.of({ connect }));
