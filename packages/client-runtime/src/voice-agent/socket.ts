// @effect-diagnostics globalTimers:off - imperative WebSocket callbacks own and clear their timers.
import {
  isUnknownUnionMember,
  ReceivedVoiceAgentEvent,
  VOICE_AGENT_INPUT_FRAME_BYTES,
  VOICE_AGENT_MAX_AUDIO_FRAME_BYTES,
  VOICE_AGENT_MAX_QUEUED_INPUT_BYTES,
  VOICE_AGENT_READY_TIMEOUT_MS,
  VOICE_AGENT_SAMPLE_RATE,
  VOICE_AGENT_SILENCE_TIMEOUT_MS,
  type VoiceAgentCloseReason,
  type VoiceAgentCommand,
  type VoiceAgentEvent,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(ReceivedVoiceAgentEvent));

/** Frames of microphone audio in `VOICE_AGENT_SILENCE_TIMEOUT_MS`. */
const SILENCE_FRAMES =
  (VOICE_AGENT_SILENCE_TIMEOUT_MS * VOICE_AGENT_SAMPLE_RATE * 2) /
  1_000 /
  VOICE_AGENT_INPUT_FRAME_BYTES;

/** How a socket the client did not end itself came to an end. Reported once. */
export type VoiceAgentSocketEnd =
  | {
      readonly kind: "closed";
      readonly reason: VoiceAgentCloseReason | null;
      readonly message?: string;
    }
  /** The socket failed or closed before it opened. */
  | { readonly kind: "connect-failed" }
  /** No `ready` within `VOICE_AGENT_READY_TIMEOUT_MS` of creating the socket. */
  | { readonly kind: "start-timeout" }
  /** Closed or errored after opening with no `closed` event, or stayed backed up too long. */
  | { readonly kind: "lost" }
  | { readonly kind: "consent-revoked" };

/** Every event except the one the socket consumes itself. */
export type VoiceAgentSessionEvent = Exclude<VoiceAgentEvent, { readonly type: "closed" }>;

export type VoiceAgentSocket = {
  /** False when the frame was not sent: not ready yet, ended, or the socket is backed up. */
  readonly sendAudio: (pcm: Int16Array) => boolean;
  readonly sendPlaybackFlushed: (flushId: number, itemId: string | null, playedMs: number) => void;
  /** The user ended the session. Sends `end`, closes, and reports nothing afterwards. */
  readonly end: () => void;
};

/**
 * One media socket for one voice session. Nothing here reconnects, and there is no ping: after
 * `ready` the microphone streams without pause, so frames that cannot be sent are the liveness
 * signal. The count of dropped frames is the time; no clock is read.
 */
export function openVoiceAgentSocket(input: {
  readonly url: string;
  /** Project, thread and the destination the user consented to. */
  readonly start: Omit<Extract<VoiceAgentCommand, { readonly type: "start" }>, "type">;
  /** False once consent for this destination is gone. Read before anything leaves the device. */
  readonly canSend: () => boolean;
  readonly onEvent: (event: VoiceAgentSessionEvent) => void;
  /** One downstream binary frame. The buffer is the callee's to keep or transfer. */
  readonly onAudio: (pcm: Int16Array) => void;
  readonly onEnd: (end: VoiceAgentSocketEnd) => void;
  readonly createSocket?: (url: string) => WebSocket;
}): VoiceAgentSocket {
  const socket = (input.createSocket ?? ((url) => new WebSocket(url)))(input.url);
  socket.binaryType = "arraybuffer";
  let opened = false;
  let ready = false;
  let ended = false;
  let droppedInARow = 0;

  let startTimer: ReturnType<typeof setTimeout> | undefined;

  const close = () => {
    ended = true;
    clearTimeout(startTimer);
    socket.close();
  };
  const finish = (end: VoiceAgentSocketEnd) => {
    if (ended) return;
    close();
    input.onEnd(end);
  };
  // Covers a hung connect as well as a slow endpoint.
  startTimer = setTimeout(() => finish({ kind: "start-timeout" }), VOICE_AGENT_READY_TIMEOUT_MS);

  socket.addEventListener("open", () => {
    if (ended) return;
    opened = true;
    if (!input.canSend()) return finish({ kind: "consent-revoked" });
    socket.send(JSON.stringify({ type: "start", ...input.start }));
  });
  socket.addEventListener("message", (message) => {
    if (ended) return;
    const data: unknown = message.data;
    if (typeof data === "string") {
      const decoded = decodeEvent(data);
      // A malformed event and an event type from a newer server are both skipped.
      if (Option.isNone(decoded) || isUnknownUnionMember(decoded.value)) return;
      const event = decoded.value;
      if (event.type === "closed") {
        return finish({
          kind: "closed",
          reason: event.reason,
          ...(event.message === undefined ? {} : { message: event.message }),
        });
      }
      if (event.type === "ready") {
        ready = true;
        clearTimeout(startTimer);
      }
      input.onEvent(event);
      return;
    }
    if (!(data instanceof ArrayBuffer)) return;
    const bytes = data.byteLength;
    if (bytes === 0 || bytes % 2 !== 0 || bytes > VOICE_AGENT_MAX_AUDIO_FRAME_BYTES) return;
    // The wire is little-endian PCM16 and so is every platform this client runs on.
    input.onAudio(new Int16Array(data));
  });
  const onGone = () => finish({ kind: opened ? "lost" : "connect-failed" });
  socket.addEventListener("close", onGone);
  socket.addEventListener("error", onGone);

  return {
    sendAudio: (pcm) => {
      if (ended || !ready) return false;
      if (!input.canSend()) {
        finish({ kind: "consent-revoked" });
        return false;
      }
      // React Native's WebSocket may not report `bufferedAmount`.
      if ((socket.bufferedAmount ?? 0) > VOICE_AGENT_MAX_QUEUED_INPUT_BYTES) {
        droppedInARow += 1;
        if (droppedInARow >= SILENCE_FRAMES) finish({ kind: "lost" });
        return false;
      }
      droppedInARow = 0;
      // Microphone frames are never views of shared memory, which is all the DOM type excludes.
      socket.send(pcm as Int16Array<ArrayBuffer>);
      return true;
    },
    sendPlaybackFlushed: (flushId, itemId, playedMs) => {
      if (ended) return;
      socket.send(JSON.stringify({ type: "playback-flushed", flushId, itemId, playedMs }));
    },
    end: () => {
      if (ended) return;
      if (opened) socket.send('{"type":"end"}');
      close();
    },
  };
}
