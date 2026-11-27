// Nothing spoken becomes an orchestration event, a turn item or an RPC payload: audio and
// captions only ever travel on the media socket described here.
import * as Schema from "effect/Schema";
import {
  ForwardCompatibleNullable,
  ForwardCompatibleUnion,
  NonNegativeInt,
  ProjectId,
  ThreadId,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const VOICE_AGENT_STREAM_PATH = "/ws/voice-agent";

/** Both directions: 16-bit little-endian mono PCM at this rate, in binary frames. */
export const VOICE_AGENT_SAMPLE_RATE = 24_000;
const VOICE_AGENT_BYTES_PER_SECOND = VOICE_AGENT_SAMPLE_RATE * 2;

/** One second. A longer binary frame, or one with an odd length, ends the session. */
export const VOICE_AGENT_MAX_AUDIO_FRAME_BYTES = VOICE_AGENT_BYTES_PER_SECOND;
/** What a client should send per frame: 40 ms, small enough for the endpoint's turn detection. */
export const VOICE_AGENT_INPUT_FRAME_BYTES = VOICE_AGENT_BYTES_PER_SECOND / 25;
/** Microphone audio waiting to be sent, on either hop. Audio that arrives beyond it is dropped. */
export const VOICE_AGENT_MAX_QUEUED_INPUT_BYTES = VOICE_AGENT_BYTES_PER_SECOND * 5;
/** Generated agent audio the server holds for pacing. Beyond it the response is cancelled. */
export const VOICE_AGENT_MAX_QUEUED_OUTPUT_BYTES = VOICE_AGENT_BYTES_PER_SECOND * 5 * 60;
/** How far ahead of real-time playback the server sends agent audio. */
export const VOICE_AGENT_PLAYBACK_LEAD_MS = 5_000;
/** Unplayed agent audio a client keeps. Beyond it the oldest is dropped. */
export const VOICE_AGENT_MAX_BUFFERED_PLAYBACK_MS = 10_000;
/** A JSON command or event is at most this long in UTF-8. */
export const VOICE_AGENT_MAX_COMMAND_BYTES = 128_000;

/**
 * After `ready` the server gives up when no client frame arrived for this long, and the client
 * when it could not send a microphone frame for this long because its socket stayed backed up.
 */
export const VOICE_AGENT_SILENCE_TIMEOUT_MS = 15_000;
/** The server waits this long for `start` after the upgrade. */
export const VOICE_AGENT_START_TIMEOUT_MS = 10_000;
/** The client waits this long for `ready` after `start`. */
export const VOICE_AGENT_READY_TIMEOUT_MS = 20_000;
/** The server waits this long for `playback-flushed`, then truncates at its own estimate. */
export const VOICE_AGENT_FLUSH_REPORT_TIMEOUT_MS = 2_000;
/** Nobody spoke and nothing is pending for this long: the session ends with `idle`. */
export const VOICE_AGENT_IDLE_TIMEOUT_MS = 5 * 60_000;
/** A session ends with `time-limit` after this long, whatever is happening. */
export const VOICE_AGENT_MAX_SESSION_MS = 30 * 60_000;

/** A conversation item of the realtime session. Opaque; only ever echoed back. */
export const VoiceAgentItemId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
export type VoiceAgentItemId = typeof VoiceAgentItemId.Type;

export const VoiceAgentCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("start"),
    projectId: ProjectId,
    /** The thread to talk to. Absent starts unbound: the first forwarded request creates one. */
    threadId: Schema.optionalKey(ThreadId),
    /**
     * The destination this device consented to, as its settings name it. The server refuses when
     * either differs from what it resolves; it never connects to a value from here.
     */
    endpointId: ProviderInstanceId,
    baseUrl: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("playback-flushed"),
    /** The `flushId` of the `user-speech-started` this answers. */
    flushId: NonNegativeInt,
    /** The earliest item not fully played when playback was cut, or null if there was none. */
    itemId: Schema.NullOr(VoiceAgentItemId),
    /** Milliseconds of that item that reached the audio output. */
    playedMs: NonNegativeInt,
  }),
  Schema.Struct({ type: Schema.Literal("end") }),
]);
export type VoiceAgentCommand = typeof VoiceAgentCommand.Type;

/** What a server decodes: a command type from a newer client is skipped, not an error. */
export const ReceivedVoiceAgentCommand = ForwardCompatibleUnion(VoiceAgentCommand.members, "type");
export type ReceivedVoiceAgentCommand = typeof ReceivedVoiceAgentCommand.Type;

/** Why a session could not start or could not continue. */
export const VoiceAgentFailureReason = Schema.Literals([
  "not-enabled",
  "not-configured",
  "not-found",
  "endpoint-unreachable",
  "endpoint-refused",
  "endpoint-unreadable-key",
  "endpoint-closed",
  "client-timeout",
  "protocol",
  "internal",
]);
export type VoiceAgentFailureReason = typeof VoiceAgentFailureReason.Type;

export const VoiceAgentCloseReason = Schema.Literals([
  "ended",
  "idle",
  "time-limit",
  ...VoiceAgentFailureReason.literals,
]);
export type VoiceAgentCloseReason = typeof VoiceAgentCloseReason.Type;

/** A problem the session survives. */
export const VoiceAgentErrorCode = Schema.Literals(["response-failed"]);
export type VoiceAgentErrorCode = typeof VoiceAgentErrorCode.Type;

/** What the voice agent is doing for the user, for a status line. */
export const VoiceAgentActivityKind = Schema.Literals([
  "send-request",
  "read-reply",
  "stop-agent",
  "read-question",
  "answer-question",
  "start-thread",
  "list-threads",
  "switch-thread",
]);
export type VoiceAgentActivityKind = typeof VoiceAgentActivityKind.Type;

export const VoiceAgentEvent = Schema.Union([
  /** The endpoint accepted the session. Microphone audio is read from here on. */
  Schema.Struct({ type: Schema.Literal("ready"), threadId: Schema.NullOr(ThreadId) }),
  /** Cut playback now and answer with `playback-flushed` carrying this id. Ends any open agent item. */
  Schema.Struct({ type: Schema.Literal("user-speech-started"), flushId: NonNegativeInt }),
  Schema.Struct({ type: Schema.Literal("user-speech-stopped") }),
  /** Binary frames from here to the matching `agent-speech-done` are this item's audio. */
  Schema.Struct({ type: Schema.Literal("agent-speech-started"), itemId: VoiceAgentItemId }),
  /** No more audio follows for the item. */
  Schema.Struct({ type: Schema.Literal("agent-speech-done"), itemId: VoiceAgentItemId }),
  /** What the voice agent is saying. Never what the user said. */
  Schema.Struct({
    type: Schema.Literal("caption-delta"),
    itemId: VoiceAgentItemId,
    delta: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("caption-done"),
    itemId: VoiceAgentItemId,
    text: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("tool-activity"),
    callId: Schema.String,
    /** A kind from a newer server decodes to null; show a generic label. */
    kind: ForwardCompatibleNullable(VoiceAgentActivityKind),
    status: Schema.Literals(["started", "completed", "failed"]),
  }),
  /** The session now talks to this thread: one was created, or the user asked to switch. */
  Schema.Struct({ type: Schema.Literal("thread-changed"), threadId: ThreadId }),
  Schema.Struct({
    type: Schema.Literal("error"),
    code: ForwardCompatibleNullable(VoiceAgentErrorCode),
    message: Schema.String,
  }),
  /** Always the last event. The server closes the socket right after it. */
  Schema.Struct({
    type: Schema.Literal("closed"),
    /** A reason from a newer server decodes to null; show `message`. */
    reason: ForwardCompatibleNullable(VoiceAgentCloseReason),
    message: Schema.optionalKey(Schema.String),
  }),
]);
export type VoiceAgentEvent = typeof VoiceAgentEvent.Type;

/** What a client decodes: an event type from a newer server is skipped, not an error. */
export const ReceivedVoiceAgentEvent = ForwardCompatibleUnion(VoiceAgentEvent.members, "type");
export type ReceivedVoiceAgentEvent = typeof ReceivedVoiceAgentEvent.Type;

export class VoiceAgentError extends Schema.TaggedError<VoiceAgentError>()("VoiceAgentError", {
  reason: VoiceAgentFailureReason,
  /** The text generator's label or host, for the message. */
  endpoint: Schema.optionalKey(Schema.String),
  /** The HTTP status of a refused upgrade, when the endpoint answered with one. */
  status: Schema.optionalKey(Schema.Int),
}) {
  override get message() {
    const name = this.endpoint ?? "The voice endpoint";
    switch (this.reason) {
      case "not-enabled":
        return "Voice mode is off on this environment. Turn it on in Settings → Labs.";
      case "not-configured":
        return "Voice mode has no voice model to talk to, or its endpoint changed. Check Settings → Voice.";
      case "not-found":
        return "That project or thread no longer exists on this environment.";
      case "endpoint-unreachable":
        return `Couldn’t reach ${name}. Check the base URL and your connection.`;
      case "endpoint-refused":
        return this.status === undefined
          ? `${name} did not accept a realtime voice session. Check the voice model in Settings → Providers. The endpoint may not support the OpenAI Realtime API.`
          : `${name} refused the voice session (HTTP ${this.status}). Check the API key and the voice model in Settings → Providers.`;
      case "endpoint-unreadable-key":
        return `Couldn’t read the API key for ${name}. Unlock the vault on this environment or update the key in Settings → Providers. No audio was sent.`;
      case "endpoint-closed":
        return `${name} ended the voice session. Start voice mode again.`;
      case "client-timeout":
        return "The voice connection stopped responding.";
      case "protocol":
        return "The voice connection sent something this environment could not read.";
      case "internal":
        return "Voice mode failed on this environment. Try again.";
    }
  }
}
