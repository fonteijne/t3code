// @effect-diagnostics globalTimers:off - the flush report deadline is owned and cleared here.
import type {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  VoiceAgentActivityKind,
  VoiceAgentFailureReason,
  VoiceAgentLaunchSettings,
} from "@t3tools/contracts";
import { mFallback } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import {
  acquireVoiceMicrophone,
  releaseVoiceMicrophone,
  type VoiceMicrophoneLease,
} from "../voice-input/controller.ts";
import {
  VOICE_AGENT_LOCAL_ERROR_COPY,
  VOICE_AGENT_UNKNOWN_END_COPY,
  voiceAgentEndedMessage,
} from "./copy.ts";
import {
  openVoiceAgentSocket,
  type VoiceAgentSessionEvent,
  type VoiceAgentSocket,
  type VoiceAgentSocketEnd,
} from "./socket.ts";

/**
 * The microphone. The platform owns the device, the permission prompt, echo cancellation and
 * resampling, and delivers 24 kHz mono PCM16.
 */
export interface VoiceAgentCapturePort {
  /**
   * Opens the microphone and starts delivering frames. Rejects with an error named
   * `NotAllowedError` when access is refused. After `signal` aborts it must release the
   * microphone even if the prompt is answered later.
   */
  start(input: {
    readonly signal: AbortSignal;
    /** `VOICE_AGENT_INPUT_FRAME_BYTES` per frame. The buffer is the callee's to keep. */
    readonly onFrame: (pcm: Int16Array) => void;
    /** The microphone went away or its processing stopped. Called at most once. */
    readonly onFailure: (code: "microphone-disconnected" | "microphone-failed") => void;
  }): Promise<void>;
  /** Accepted at any time, including before or during `start`. */
  stop(): void;
}

/** Where playback was when it was cut. */
export type VoiceAgentPlaybackCut = {
  /** The earliest item with unplayed audio, else the last item that played, else null. */
  readonly itemId: string | null;
  /** Milliseconds of that item that reached the output. */
  readonly playedMs: number;
  /** Whether that item still had unplayed audio. */
  readonly pending: boolean;
};

/** The speaker. Plays 24 kHz mono PCM16 in the order it is enqueued. */
export interface VoiceAgentPlaybackPort {
  /**
   * Makes output audible. Must begin unlocking the output synchronously, before its first await:
   * the controller calls it inside the user gesture that starts voice mode.
   */
  start(input: {
    readonly signal: AbortSignal;
    /** True when audio starts reaching the output, false when the buffer has run empty. */
    readonly onPlayingChange: (playing: boolean) => void;
    /** Output stopped working. Called at most once. */
    readonly onFailure: () => void;
  }): Promise<void>;
  /** The buffer is the callee's to keep or transfer. */
  enqueue(pcm: Int16Array, itemId: string): void;
  /**
   * Silences output at once, drops everything buffered and reports where playback was. Resolves in
   * call order. May never resolve if the output has died; the caller bounds its wait.
   */
  flush(): Promise<VoiceAgentPlaybackCut>;
  /** Accepted at any time, including before or during `start`. */
  stop(): void;
}

export type VoiceAgentPhase =
  | "idle"
  /** Microphone, ticket, socket, endpoint: everything before `ready`. */
  | "connecting"
  /** Live, nobody is speaking and nothing is running. */
  | "listening"
  /** The endpoint hears the user (between `user-speech-started` and `user-speech-stopped`). */
  | "userSpeaking"
  /** Agent audio is reaching the output. */
  | "agentSpeaking"
  /** A function call is running and nothing is audible. */
  | "working"
  /** The session stopped by itself for a normal reason (idle, time limit). `message` says why. */
  | "ended"
  | "error";

/**
 * Why a session failed: a server failure reason, or a failure only the client can see. Not the
 * contract's `VoiceAgentErrorCode`, which is the code of the non-fatal `error` event.
 */
export type VoiceAgentFailureCode =
  | VoiceAgentFailureReason
  | "microphone-blocked"
  | "microphone-busy"
  | "microphone-failed"
  | "microphone-disconnected"
  | "audio-unavailable"
  | "consent-required"
  | "consent-revoked"
  | "connect-failed"
  | "start-timeout"
  | "connection-lost";

export type VoiceAgentState = {
  readonly phase: VoiceAgentPhase;
  /**
   * The thread the session talks to. Null before `ready` and while unbound. Kept through `ended`
   * and `error`, so the notice shows on the thread the session was last on; cleared on `idle`.
   */
  readonly threadId: ThreadId | null;
  /** The newest function call still running. `"other"` is a kind this client does not know. */
  readonly activity: VoiceAgentActivityKind | "other" | null;
  /** A reply the endpoint could not produce, until someone speaks again. Server-authored English. */
  readonly warning: string | null;
  /** Text for `ended` and `error`, in the UI language where the client wrote it. */
  readonly message: string | null;
  readonly errorCode?: VoiceAgentFailureCode;
  readonly errorAction: "retry" | "settings" | null;
};

/** One thing the voice agent said. There are no captions of the user's speech. */
export type VoiceAgentCaption = {
  readonly itemId: string;
  readonly text: string;
  readonly done: boolean;
  /** The user cut this reply off; the text may run past what was heard. */
  readonly interrupted: boolean;
};

/** True from the starting gesture until the session is over: the microphone is this session's. */
export function voiceAgentIsActive(state: VoiceAgentState): boolean {
  return state.phase !== "idle" && state.phase !== "ended" && state.phase !== "error";
}

export type VoiceAgentStartInput = {
  readonly projectId: ProjectId;
  readonly threadId?: ThreadId;
  /** The destination the user consented to; sent in `start` so the server can refuse another. */
  readonly endpointId: ProviderInstanceId;
  readonly baseUrl: string;
  /** The composer's model and modes: a thread the voice agent creates uses them. */
  readonly launch?: VoiceAgentLaunchSettings;
  /** Mints the ticket and builds the URL. Called once per start. */
  readonly getStreamUrl: (options: { readonly signal: AbortSignal }) => Promise<string>;
  /** False once this destination's consent is gone. Read before every frame. */
  readonly hasConsent: () => boolean;
};

export type VoiceAgentControllerDependencies = {
  readonly capture: VoiceAgentCapturePort;
  readonly playback: VoiceAgentPlaybackPort;
  readonly onStateChange: (state: VoiceAgentState) => void;
  readonly onCaptionsChange: (captions: ReadonlyArray<VoiceAgentCaption>) => void;
  /** Resolves error copy in the UI language; English when omitted. */
  readonly resolve?: MFunctionType;
  readonly createSocket?: (url: string) => WebSocket;
};

type StartStage = "microphone" | "playback" | "ticket";

const IDLE_STATE: VoiceAgentState = {
  phase: "idle",
  threadId: null,
  activity: null,
  warning: null,
  message: null,
  errorAction: null,
};

const NO_CAPTIONS: ReadonlyArray<VoiceAgentCaption> = [];
const MAX_CAPTIONS = 50;
const MAX_OPENED_ITEMS = 32;

/**
 * How long the player has to say where it was cut. Half of the server's wait for the report; past
 * it the server has used its own estimate, so a late answer is never sent.
 */
const FLUSH_REPORT_DEADLINE_MS = 1_000;

function startFailureCode(error: unknown, stage: StartStage): VoiceAgentFailureCode {
  if (stage === "playback") return "audio-unavailable";
  if (stage === "ticket") return "connect-failed";
  return typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "NotAllowedError"
    ? "microphone-blocked"
    : "microphone-failed";
}

function errorActionFor(code: VoiceAgentFailureCode): VoiceAgentState["errorAction"] {
  switch (code) {
    case "not-enabled":
    case "not-configured":
    case "endpoint-refused":
    case "endpoint-unreadable-key":
      return "settings";
    // The project or thread is gone; retrying the same target cannot work.
    case "not-found":
      return null;
    default:
      return "retry";
  }
}

const isLocalFailure = (
  code: VoiceAgentFailureCode,
): code is keyof typeof VOICE_AGENT_LOCAL_ERROR_COPY => code in VOICE_AGENT_LOCAL_ERROR_COPY;

/**
 * One voice session at a time: microphone lease, capture, playback and the media socket. It never
 * reconnects; a session that stops is started again by the user.
 */
export class VoiceAgentController {
  private readonly dependencies: VoiceAgentControllerDependencies;
  private state: VoiceAgentState = IDLE_STATE;
  private captions: ReadonlyArray<VoiceAgentCaption> = NO_CAPTIONS;
  private operationToken = 0;
  private abort: AbortController | null = null;
  private socket: VoiceAgentSocket | null = null;
  private lease: VoiceMicrophoneLease | null = null;
  private stage: StartStage = "playback";
  private ready = false;
  private threadId: ThreadId | null = null;
  private warning: string | null = null;
  private userSpeaking = false;
  private playing = false;
  private readonly pendingCalls = new Map<string, VoiceAgentActivityKind | "other">();
  /** The item whose audio the next binary frame belongs to. */
  private openItemId: string | null = null;
  /** Items opened since the last barge-in, oldest first. */
  private openedItems: ReadonlyArray<string> = [];
  /** Items the last barge-in cut: no bracket reopens and no caption grows for these. */
  private cutItemIds: ReadonlySet<string> = new Set();

  constructor(dependencies: VoiceAgentControllerDependencies) {
    this.dependencies = dependencies;
  }

  private get resolve(): MFunctionType {
    return this.dependencies.resolve ?? mFallback;
  }

  get currentState(): VoiceAgentState {
    return this.state;
  }

  get currentCaptions(): ReadonlyArray<VoiceAgentCaption> {
    return this.captions;
  }

  async start(input: VoiceAgentStartInput): Promise<void> {
    if (voiceAgentIsActive(this.state)) return;
    const token = ++this.operationToken;
    const abort = new AbortController();
    this.abort = abort;
    this.reset();
    this.setState({ ...IDLE_STATE, phase: "connecting" });
    try {
      // Before the first await: browsers only start audio output inside the gesture that asked for it.
      this.stage = "playback";
      const playbackReady = this.dependencies.playback.start({
        signal: abort.signal,
        onPlayingChange: (playing) => {
          if (this.isCurrent(token)) this.setPlaying(playing);
        },
        onFailure: () => {
          if (this.isCurrent(token)) this.fail("audio-unavailable");
        },
      });
      // Awaited below, after the microphone; a rejection before that is not unhandled.
      void playbackReady.catch(() => undefined);

      // The microphone comes before the ticket: a permission prompt can outlive a ticket, and
      // nothing is opened at the endpoint for a microphone the user then refuses.
      this.stage = "microphone";
      const lease = await acquireVoiceMicrophone();
      if (!this.isCurrent(token)) {
        releaseVoiceMicrophone(lease);
        return;
      }
      if (!lease) return this.fail("microphone-busy");
      this.lease = lease;
      if (!input.hasConsent()) return this.fail("consent-required");
      await this.dependencies.capture.start({
        signal: abort.signal,
        // Frames captured before `ready` are dropped by the socket; late live audio is worth nothing.
        onFrame: (pcm) => {
          if (this.isCurrent(token)) this.socket?.sendAudio(pcm);
        },
        onFailure: (code) => {
          if (this.isCurrent(token)) this.fail(code);
        },
      });
      if (!this.isCurrent(token)) return;

      this.stage = "playback";
      await playbackReady;
      if (!this.isCurrent(token)) return;

      this.stage = "ticket";
      const url = await input.getStreamUrl({ signal: abort.signal });
      if (!this.isCurrent(token)) return;
      this.socket = openVoiceAgentSocket({
        url,
        start: {
          projectId: input.projectId,
          ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
          endpointId: input.endpointId,
          baseUrl: input.baseUrl,
          ...(input.launch === undefined ? {} : { launch: input.launch }),
        },
        canSend: input.hasConsent,
        onEvent: (event) => {
          if (this.isCurrent(token)) this.handleEvent(event);
        },
        onAudio: (pcm) => {
          if (this.isCurrent(token)) this.handleAudio(pcm);
        },
        onEnd: (end) => {
          if (this.isCurrent(token)) this.handleSocketEnd(end);
        },
        ...(this.dependencies.createSocket ? { createSocket: this.dependencies.createSocket } : {}),
      });
    } catch (error) {
      if (!this.isCurrent(token)) return;
      this.fail(startFailureCode(error, this.stage));
    }
  }

  /** The user ends the session, or cancels a start. Lands in `idle` from any phase. */
  end(): void {
    if (this.state.phase === "idle") return;
    if (voiceAgentIsActive(this.state)) this.teardown();
    this.toIdle();
  }

  /** Leaves `ended` or `error` for `idle`. */
  dismiss(): void {
    if (this.state.phase === "ended" || this.state.phase === "error") this.toIdle();
  }

  private handleEvent(event: VoiceAgentSessionEvent): void {
    switch (event.type) {
      case "ready":
        this.ready = true;
        this.threadId = event.threadId;
        break;
      case "user-speech-started":
        this.bargeIn(event.flushId);
        break;
      case "user-speech-stopped":
        this.userSpeaking = false;
        break;
      case "agent-speech-started":
        if (this.cutItemIds.has(event.itemId)) return;
        this.openItemId = event.itemId;
        this.openedItems = [...this.openedItems, event.itemId].slice(-MAX_OPENED_ITEMS);
        this.warning = null;
        break;
      case "agent-speech-done":
        if (this.openItemId === event.itemId) this.openItemId = null;
        return;
      case "caption-delta":
        this.updateCaption(event.itemId, (text) => ({ text: text + event.delta }));
        return;
      case "caption-done":
        this.updateCaption(event.itemId, () => ({ text: event.text, done: true }));
        return;
      case "tool-activity":
        if (event.status === "started") this.pendingCalls.set(event.callId, event.kind ?? "other");
        else this.pendingCalls.delete(event.callId);
        break;
      case "thread-changed":
        this.threadId = event.threadId;
        break;
      case "error":
        this.warning = event.message;
        break;
    }
    this.publish();
  }

  private handleAudio(pcm: Int16Array): void {
    // A frame outside a bracket belongs to no item, or to one a barge-in already cut.
    if (this.openItemId !== null) this.dependencies.playback.enqueue(pcm, this.openItemId);
  }

  private bargeIn(flushId: number): void {
    const openItem = this.openItemId;
    const opened = this.openedItems;
    this.openItemId = null;
    this.openedItems = [];
    this.cutItemIds = new Set(opened);
    this.userSpeaking = true;
    this.warning = null;
    const socket = this.socket;
    const token = this.operationToken;
    // Never report a flush late: past the deadline the server has truncated at its own estimate.
    let settled = false;
    const deadline = setTimeout(() => {
      settled = true;
    }, FLUSH_REPORT_DEADLINE_MS);
    void this.dependencies.playback.flush().then(
      (cut) => {
        clearTimeout(deadline);
        if (settled || !this.isCurrent(token)) return;
        settled = true;
        const report = cut.pending
          ? { itemId: cut.itemId, playedMs: cut.playedMs }
          : openItem !== null
            ? { itemId: openItem, playedMs: cut.itemId === openItem ? cut.playedMs : 0 }
            : { itemId: null, playedMs: 0 };
        socket?.sendPlaybackFlushed(
          flushId,
          report.itemId,
          Math.max(0, Math.floor(report.playedMs)),
        );
        this.markCaptions(report.itemId, opened);
      },
      () => clearTimeout(deadline),
    );
  }

  /** The cut item is marked; items after it were never heard and the server deletes them. */
  private markCaptions(itemId: string | null, opened: ReadonlyArray<string>): void {
    const index = itemId === null ? -1 : opened.indexOf(itemId);
    if (index < 0) return;
    const unheard = new Set(opened.slice(index + 1));
    const affected = (caption: VoiceAgentCaption) =>
      unheard.has(caption.itemId) || (caption.itemId === itemId && !caption.interrupted);
    if (!this.captions.some(affected)) return;
    this.setCaptions(
      this.captions
        .filter((caption) => !unheard.has(caption.itemId))
        .map((caption) => (affected(caption) ? { ...caption, interrupted: true } : caption)),
    );
  }

  private updateCaption(itemId: string, update: (text: string) => Partial<VoiceAgentCaption>) {
    if (this.cutItemIds.has(itemId)) return;
    const current = this.captions.find((caption) => caption.itemId === itemId);
    this.setCaptions(
      current
        ? this.captions.map((caption) =>
            caption === current ? { ...current, ...update(current.text) } : caption,
          )
        : [
            ...this.captions,
            { itemId, text: "", done: false, interrupted: false, ...update("") },
          ].slice(-MAX_CAPTIONS),
    );
  }

  private handleSocketEnd(end: VoiceAgentSocketEnd): void {
    switch (end.kind) {
      case "lost":
        return this.fail("connection-lost");
      case "connect-failed":
      case "start-timeout":
      case "consent-revoked":
        return this.fail(end.kind);
      case "closed":
        break;
    }
    if (end.reason === "ended") {
      this.teardown();
      return this.toIdle();
    }
    if (end.reason === "idle" || end.reason === "time-limit") {
      this.teardown();
      return this.setState({
        ...IDLE_STATE,
        phase: "ended",
        threadId: this.threadId,
        message: voiceAgentEndedMessage(end.reason, this.resolve),
      });
    }
    this.fail(end.reason, end.message);
  }

  /** `code` is null for a reason only a newer server knows; its message is all there is. */
  private fail(code: VoiceAgentFailureCode | null, serverMessage?: string): void {
    this.teardown();
    const message =
      code !== null && isLocalFailure(code)
        ? this.resolve(VOICE_AGENT_LOCAL_ERROR_COPY[code])
        : // Server-authored English, shown as is.
          (serverMessage ?? this.resolve(VOICE_AGENT_UNKNOWN_END_COPY));
    this.setState({
      ...IDLE_STATE,
      phase: "error",
      threadId: this.threadId,
      message,
      ...(code === null ? {} : { errorCode: code }),
      errorAction: code === null ? "retry" : errorActionFor(code),
    });
  }

  private teardown(): void {
    // Every pending callback of this session becomes stale.
    this.operationToken += 1;
    this.abort?.abort();
    this.abort = null;
    this.socket?.end();
    this.socket = null;
    this.dependencies.capture.stop();
    this.dependencies.playback.stop();
    releaseVoiceMicrophone(this.lease);
    this.lease = null;
  }

  private toIdle(): void {
    this.reset();
    this.setState(IDLE_STATE);
  }

  private reset(): void {
    this.ready = false;
    this.threadId = null;
    this.warning = null;
    this.userSpeaking = false;
    this.playing = false;
    this.pendingCalls.clear();
    this.openItemId = null;
    this.openedItems = [];
    this.cutItemIds = new Set();
    if (this.captions.length > 0) this.setCaptions(NO_CAPTIONS);
  }

  private setPlaying(playing: boolean): void {
    this.playing = playing;
    this.publish();
  }

  /** The live phase is derived from what is happening, never stored. */
  private publish(): void {
    // userSpeaking wins: a flush has just been ordered, so playback is on its way to silent.
    const live = this.userSpeaking
      ? "userSpeaking"
      : this.playing
        ? "agentSpeaking"
        : this.pendingCalls.size > 0
          ? "working"
          : "listening";
    let activity: VoiceAgentState["activity"] = null;
    for (const kind of this.pendingCalls.values()) activity = kind;
    this.setState({
      ...IDLE_STATE,
      phase: this.ready ? live : "connecting",
      threadId: this.threadId,
      activity,
      warning: this.warning,
    });
  }

  private isCurrent(token: number): boolean {
    return token === this.operationToken;
  }

  private setCaptions(captions: ReadonlyArray<VoiceAgentCaption>): void {
    this.captions = captions;
    this.dependencies.onCaptionsChange(captions);
  }

  private setState(state: VoiceAgentState): void {
    const previous = this.state;
    if (
      previous.phase === state.phase &&
      previous.threadId === state.threadId &&
      previous.activity === state.activity &&
      previous.warning === state.warning &&
      previous.message === state.message &&
      previous.errorCode === state.errorCode &&
      previous.errorAction === state.errorAction
    )
      return;
    this.state = state;
    this.dependencies.onStateChange(state);
  }
}
