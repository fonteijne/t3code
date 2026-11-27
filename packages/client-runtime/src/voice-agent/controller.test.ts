import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  VOICE_AGENT_INPUT_FRAME_BYTES,
  VOICE_AGENT_READY_TIMEOUT_MS,
  type VoiceAgentEvent,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  acquireVoiceMicrophone,
  releaseVoiceMicrophone,
  resetVoiceInputGlobalsForTests,
  VoiceInputController,
  voiceMicrophoneHeld,
} from "../voice-input/controller.ts";
import {
  VoiceAgentController,
  type VoiceAgentCaption,
  type VoiceAgentCapturePort,
  type VoiceAgentPlaybackCut,
  type VoiceAgentPlaybackPort,
  type VoiceAgentStartInput,
  type VoiceAgentState,
} from "./controller.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class TestSocket extends EventTarget {
  sent: (string | Int16Array)[] = [];
  closed = false;
  binaryType = "blob";
  bufferedAmount = 0;
  send(data: string | Int16Array) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.dispatchEvent(new Event("close"));
  }
  open() {
    this.dispatchEvent(new Event("open"));
  }
  receive(event: VoiceAgentEvent | Record<string, unknown>) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
  }
  receiveAudio(samples = 480) {
    this.dispatchEvent(new MessageEvent("message", { data: new ArrayBuffer(samples * 2) }));
  }
  commands() {
    return this.sent.flatMap((data) => (typeof data === "string" ? [JSON.parse(data)] : []));
  }
}

const projectId = ProjectId.make("project-a");
const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const endpointId = ProviderInstanceId.make("gateway");
const baseUrl = "https://gateway.test/v1";
const STREAM_URL = "wss://environment.test/ws/voice-agent?wsTicket=ticket";
const frame = () => new Int16Array(VOICE_AGENT_INPUT_FRAME_BYTES / 2);

type CaptureInput = Parameters<VoiceAgentCapturePort["start"]>[0];
type PlaybackInput = Parameters<VoiceAgentPlaybackPort["start"]>[0];

type HarnessOverrides = {
  /** What opening the microphone waits for, or fails with. */
  readonly captureStart?: () => Promise<void>;
  readonly playbackStart?: () => Promise<void>;
  readonly getStreamUrl?: () => Promise<string>;
};

function createHarness(overrides: HarnessOverrides = {}) {
  const socket = new TestSocket();
  const order: string[] = [];
  const states: VoiceAgentState[] = [];
  const captions: ReadonlyArray<VoiceAgentCaption>[] = [];
  const enqueued: string[] = [];
  const flushes: ReturnType<typeof deferred<VoiceAgentPlaybackCut>>[] = [];
  const captureStarted = deferred<CaptureInput>();
  let captureInput: CaptureInput | null = null;
  let playbackInput: PlaybackInput | null = null;
  let consent = true;
  const capture = {
    start: async (input: CaptureInput) => {
      order.push("capture.start");
      captureInput = input;
      captureStarted.resolve(input);
      await overrides.captureStart?.();
    },
    stop: vi.fn(),
  } satisfies VoiceAgentCapturePort;
  const playback = {
    start: async (input: PlaybackInput) => {
      order.push("playback.start");
      playbackInput = input;
      await overrides.playbackStart?.();
    },
    enqueue: (_pcm: Int16Array, itemId: string) => {
      enqueued.push(itemId);
    },
    flush: () => {
      const flush = deferred<VoiceAgentPlaybackCut>();
      flushes.push(flush);
      return flush.promise;
    },
    stop: vi.fn(),
  } satisfies VoiceAgentPlaybackPort;
  const controller = new VoiceAgentController({
    capture,
    playback,
    onStateChange: (state) => states.push(state),
    onCaptionsChange: (next) => captions.push(next),
    createSocket: (url) => {
      order.push(`socket ${url}`);
      return socket as unknown as WebSocket;
    },
  });
  const input: VoiceAgentStartInput = {
    projectId,
    threadId: threadA,
    endpointId,
    baseUrl,
    getStreamUrl: async () => {
      order.push("ticket");
      return overrides.getStreamUrl ? overrides.getStreamUrl() : STREAM_URL;
    },
    hasConsent: () => consent,
  };
  const harness = {
    controller,
    socket,
    capture,
    playback,
    input,
    order,
    states,
    captions,
    enqueued,
    flushes,
    captureStarted: captureStarted.promise,
    /** Null while the microphone was never opened. */
    microphone: () => captureInput,
    speaker: () => {
      if (!playbackInput) throw new Error("Playback was never started.");
      return playbackInput;
    },
    revokeConsent: () => {
      consent = false;
    },
    phase: () => controller.currentState.phase,
    /** Starts and brings the session to `ready` on thread A. */
    goLive: async () => {
      await controller.start(input);
      socket.open();
      socket.receive({ type: "ready", threadId: threadA });
    },
    /** Resolves the oldest unanswered flush and lets the controller act on it. */
    answerFlush: async (at: number, cut: VoiceAgentPlaybackCut) => {
      flushes[at]!.resolve(cut);
      await flushes[at]!.promise;
    },
    reports: () => socket.commands().filter((command) => command.type === "playback-flushed"),
  };
  return harness;
}

type Harness = ReturnType<typeof createHarness>;

describe("voice agent controller", () => {
  beforeEach(() => {
    resetVoiceInputGlobalsForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("unlocks playback in the starting gesture and opens the microphone before the endpoint", async () => {
    const harness = createHarness();
    const started = harness.controller.start(harness.input);
    // Nothing has been awaited yet: this is still the click that started voice mode.
    expect(harness.order).toEqual(["playback.start"]);
    expect(harness.phase()).toBe("connecting");

    await started;
    expect(harness.order).toEqual([
      "playback.start",
      "capture.start",
      "ticket",
      `socket ${STREAM_URL}`,
    ]);
    expect(voiceMicrophoneHeld()).toBe(true);

    harness.socket.open();
    expect(harness.socket.commands()).toEqual([
      { type: "start", projectId, threadId: threadA, endpointId, baseUrl },
    ]);
    // The microphone is already open; what it captures before `ready` goes nowhere.
    harness.microphone()?.onFrame(frame());
    expect(harness.socket.sent).toHaveLength(1);

    harness.socket.receive({ type: "ready", threadId: threadA });
    const first = frame();
    harness.microphone()?.onFrame(first);
    expect(harness.socket.sent[1]).toBe(first);
    expect(harness.states.map((state) => state.phase)).toEqual(["connecting", "listening"]);
    expect(harness.controller.currentState.threadId).toBe(threadA);

    // A second start while one is running is not a second session.
    await harness.controller.start(harness.input);
    expect(harness.order).toHaveLength(4);
  });

  const started = (itemId: string): VoiceAgentEvent => ({ type: "agent-speech-started", itemId });
  const done = (itemId: string): VoiceAgentEvent => ({ type: "agent-speech-done", itemId });

  it.each<{
    readonly name: string;
    readonly before: ReadonlyArray<VoiceAgentEvent>;
    readonly cutItem: string;
    readonly cut: VoiceAgentPlaybackCut | "never";
    readonly report: { readonly itemId: string | null; readonly playedMs: number } | null;
  }>([
    {
      name: "the open item still had unplayed audio",
      before: [started("item_A")],
      cutItem: "item_A",
      cut: { itemId: "item_A", playedMs: 480.7, pending: true },
      report: { itemId: "item_A", playedMs: 480 },
    },
    {
      name: "a finished item still had unplayed audio",
      before: [started("item_A"), done("item_A"), started("item_B")],
      cutItem: "item_A",
      cut: { itemId: "item_A", playedMs: 1_200, pending: true },
      report: { itemId: "item_A", playedMs: 1_200 },
    },
    {
      name: "everything received of the open item had played",
      before: [started("item_A")],
      cutItem: "item_A",
      cut: { itemId: "item_A", playedMs: 900, pending: false },
      report: { itemId: "item_A", playedMs: 900 },
    },
    {
      name: "no audio of the open item had arrived",
      before: [started("item_A"), done("item_A"), started("item_B")],
      cutItem: "item_B",
      cut: { itemId: "item_A", playedMs: 900, pending: false },
      report: { itemId: "item_B", playedMs: 0 },
    },
    {
      name: "nothing was open and nothing unplayed",
      before: [started("item_A"), done("item_A")],
      cutItem: "item_A",
      cut: { itemId: "item_A", playedMs: 900, pending: false },
      report: { itemId: null, playedMs: 0 },
    },
    {
      name: "the player never said where it was",
      before: [started("item_A")],
      cutItem: "item_A",
      cut: "never",
      report: null,
    },
  ])("cuts playback on barge-in when $name", async ({ before, cutItem, cut, report }) => {
    const harness = createHarness();
    await harness.goLive();
    for (const event of before) harness.socket.receive(event);

    harness.socket.receive({ type: "user-speech-started", flushId: 7 });
    expect(harness.flushes).toHaveLength(1);
    expect(harness.phase()).toBe("userSpeaking");
    // Audio the server sent before it saw the barge-in, and a bracket that reopens for a cut item.
    harness.socket.receiveAudio();
    harness.socket.receive(started(cutItem));
    harness.socket.receiveAudio();
    expect(harness.enqueued).toEqual([]);

    if (cut === "never") {
      await vi.advanceTimersByTimeAsync(1_000);
      // The server has used its own estimate by now; a late answer would corrupt the next flush.
      await harness.answerFlush(0, { itemId: "item_A", playedMs: 300, pending: true });
    } else {
      await vi.advanceTimersByTimeAsync(999);
      await harness.answerFlush(0, cut);
    }
    expect(harness.reports()).toEqual(
      report === null ? [] : [{ type: "playback-flushed", flushId: 7, ...report }],
    );

    harness.socket.receive(started("item_C"));
    harness.socket.receiveAudio();
    expect(harness.enqueued).toEqual(["item_C"]);
  });

  it("answers each barge-in with its own flush id", async () => {
    const harness = createHarness();
    await harness.goLive();
    harness.socket.receive(started("item_A"));
    harness.socket.receive({ type: "user-speech-started", flushId: 0 });
    harness.socket.receive({ type: "user-speech-started", flushId: 1 });
    await harness.answerFlush(0, { itemId: "item_A", playedMs: 250, pending: true });
    await harness.answerFlush(1, { itemId: "item_A", playedMs: 250, pending: false });
    expect(harness.reports()).toEqual([
      { type: "playback-flushed", flushId: 0, itemId: "item_A", playedMs: 250 },
      { type: "playback-flushed", flushId: 1, itemId: null, playedMs: 0 },
    ]);
  });

  it("derives the live phase from speech, playback and running calls", async () => {
    const harness = createHarness();
    await harness.goLive();
    const { socket, controller } = harness;
    const activity = () => controller.currentState.activity;

    socket.receive({ type: "user-speech-started", flushId: 0 });
    expect(harness.phase()).toBe("userSpeaking");
    socket.receive({ type: "user-speech-stopped" });
    expect(harness.phase()).toBe("listening");

    // The bracket is not playback: the server sends audio seconds ahead of the speaker.
    socket.receive(started("item_A"));
    expect(harness.phase()).toBe("listening");
    harness.speaker().onPlayingChange(true);
    expect(harness.phase()).toBe("agentSpeaking");
    socket.receive(done("item_A"));
    expect(harness.phase()).toBe("agentSpeaking");
    socket.receive({ type: "user-speech-started", flushId: 1 });
    expect(harness.phase()).toBe("userSpeaking");
    socket.receive({ type: "user-speech-stopped" });
    expect(harness.phase()).toBe("agentSpeaking");
    harness.speaker().onPlayingChange(false);
    expect(harness.phase()).toBe("listening");

    socket.receive({
      type: "tool-activity",
      callId: "call_1",
      kind: "send-request",
      status: "started",
    });
    expect([harness.phase(), activity()]).toEqual(["working", "send-request"]);
    socket.receive({
      type: "tool-activity",
      callId: "call_2",
      kind: "from-a-newer-server",
      status: "started",
    });
    expect([harness.phase(), activity()]).toEqual(["working", "other"]);
    socket.receive({ type: "tool-activity", callId: "call_2", kind: null, status: "completed" });
    expect([harness.phase(), activity()]).toEqual(["working", "send-request"]);
    const notified = harness.states.length;
    socket.receive({
      type: "tool-activity",
      callId: "call_1",
      kind: "send-request",
      status: "started",
    });
    harness.speaker().onPlayingChange(false);
    expect(harness.states).toHaveLength(notified);
    socket.receive({
      type: "tool-activity",
      callId: "call_1",
      kind: "send-request",
      status: "failed",
    });
    expect([harness.phase(), activity()]).toEqual(["listening", null]);

    socket.receive({ type: "error", code: "response-failed", message: "The gateway is busy." });
    expect(controller.currentState).toMatchObject({
      phase: "listening",
      warning: "The gateway is busy.",
    });
    socket.receive({ type: "user-speech-started", flushId: 2 });
    expect(controller.currentState.warning).toBeNull();
  });

  const closeFromServer = (closed: Record<string, unknown>) => (harness: Harness) =>
    harness.socket.receive({ type: "closed", ...closed });
  const notAllowed = Object.assign(new Error("denied"), { name: "NotAllowedError" });

  it.each<{
    readonly name: string;
    readonly overrides?: HarnessOverrides;
    readonly prepare?: (harness: Harness) => void;
    /** Whether the session reaches `ready` (and then moves to thread B) before it stops. */
    readonly live: boolean;
    readonly stop?: (harness: Harness) => void;
    readonly expected: Partial<VoiceAgentState>;
  }>([
    {
      name: "the server confirming the end",
      live: true,
      stop: closeFromServer({ reason: "ended" }),
      expected: { phase: "idle", errorAction: null },
    },
    {
      name: "the idle limit",
      live: true,
      stop: closeFromServer({ reason: "idle" }),
      expected: { phase: "ended", errorAction: null },
    },
    {
      name: "the session time limit",
      live: true,
      stop: closeFromServer({ reason: "time-limit" }),
      expected: { phase: "ended", errorAction: null },
    },
    {
      name: "an endpoint that refuses",
      live: true,
      stop: closeFromServer({ reason: "endpoint-refused", message: "Gateway refused (HTTP 401)." }),
      expected: {
        phase: "error",
        errorCode: "endpoint-refused",
        message: "Gateway refused (HTTP 401).",
        errorAction: "settings",
      },
    },
    {
      name: "a thread that is gone",
      live: false,
      stop: (harness) => {
        harness.socket.open();
        closeFromServer({ reason: "not-found", message: "That thread no longer exists." })(harness);
      },
      expected: {
        phase: "error",
        errorCode: "not-found",
        message: "That thread no longer exists.",
        errorAction: null,
      },
    },
    {
      name: "a reason only a newer server knows",
      live: true,
      stop: closeFromServer({ reason: "from-the-future", message: "Something new happened." }),
      expected: { phase: "error", message: "Something new happened.", errorAction: "retry" },
    },
    {
      name: "a dropped connection",
      live: true,
      stop: (harness) => harness.socket.dispatchEvent(new Event("close")),
      expected: { phase: "error", errorCode: "connection-lost", errorAction: "retry" },
    },
    {
      name: "a socket that never opens",
      live: false,
      stop: (harness) => harness.socket.dispatchEvent(new Event("error")),
      expected: { phase: "error", errorCode: "connect-failed", errorAction: "retry" },
    },
    {
      name: "an endpoint that never gets ready",
      live: false,
      stop: (harness) => {
        harness.socket.open();
        vi.advanceTimersByTime(VOICE_AGENT_READY_TIMEOUT_MS);
      },
      expected: { phase: "error", errorCode: "start-timeout", errorAction: "retry" },
    },
    {
      name: "consent revoked mid-session",
      live: true,
      stop: (harness) => {
        harness.revokeConsent();
        harness.microphone()?.onFrame(frame());
      },
      expected: { phase: "error", errorCode: "consent-revoked", errorAction: "retry" },
    },
    {
      name: "consent missing at start",
      live: false,
      prepare: (harness) => harness.revokeConsent(),
      expected: { phase: "error", errorCode: "consent-required", errorAction: "retry" },
    },
    {
      name: "the microphone disconnecting",
      live: true,
      stop: (harness) => harness.microphone()?.onFailure("microphone-disconnected"),
      expected: { phase: "error", errorCode: "microphone-disconnected", errorAction: "retry" },
    },
    {
      name: "the microphone being refused",
      live: false,
      overrides: { captureStart: () => Promise.reject(notAllowed) },
      expected: { phase: "error", errorCode: "microphone-blocked", errorAction: "retry" },
    },
    {
      name: "the microphone failing to open",
      live: false,
      overrides: { captureStart: () => Promise.reject(new Error("no device")) },
      expected: { phase: "error", errorCode: "microphone-failed", errorAction: "retry" },
    },
    {
      name: "audio output that cannot start",
      live: false,
      overrides: { playbackStart: () => Promise.reject(new Error("no output")) },
      expected: { phase: "error", errorCode: "audio-unavailable", errorAction: "retry" },
    },
    {
      name: "audio output failing mid-session",
      live: true,
      stop: (harness) => harness.speaker().onFailure(),
      expected: { phase: "error", errorCode: "audio-unavailable", errorAction: "retry" },
    },
    {
      name: "a ticket that cannot be minted",
      live: false,
      overrides: { getStreamUrl: () => Promise.reject(new Error("offline")) },
      expected: { phase: "error", errorCode: "connect-failed", errorAction: "retry" },
    },
  ])("releases everything after $name", async ({ overrides, prepare, live, stop, expected }) => {
    const harness = createHarness(overrides);
    prepare?.(harness);
    if (live) {
      await harness.goLive();
      harness.socket.receive({ type: "thread-changed", threadId: threadB });
      expect(harness.controller.currentState.threadId).toBe(threadB);
    } else {
      await harness.controller.start(harness.input);
    }
    stop?.(harness);

    const state = harness.controller.currentState;
    expect(state).toMatchObject(expected);
    expect(state.errorCode).toBe(expected.errorCode);
    // The notice belongs to the thread the session was last on.
    expect(state.threadId).toBe(live && state.phase !== "idle" ? threadB : null);
    expect(state.message === null).toBe(state.phase === "idle");
    expect(harness.capture.stop).toHaveBeenCalled();
    expect(harness.playback.stop).toHaveBeenCalled();
    expect(voiceMicrophoneHeld()).toBe(false);
    expect(harness.microphone()?.signal.aborted ?? true).toBe(true);
    expect(harness.speaker().signal.aborted).toBe(true);

    // Nothing of the stopped session reaches the endpoint or the speaker afterwards.
    const sent = harness.socket.sent.length;
    harness.microphone()?.onFrame(frame());
    harness.socket.receive(started("item_late"));
    harness.socket.receiveAudio();
    harness.speaker().onPlayingChange(true);
    expect(harness.socket.sent).toHaveLength(sent);
    expect(harness.enqueued).toEqual([]);
    expect(harness.controller.currentState).toBe(state);

    harness.controller.dismiss();
    expect(harness.controller.currentState).toMatchObject({ phase: "idle", threadId: null });
  });

  it("shares one microphone with dictation, in both directions", async () => {
    const dictation = await acquireVoiceMicrophone();
    const blocked = createHarness();
    await blocked.controller.start(blocked.input);
    expect(blocked.controller.currentState).toMatchObject({
      phase: "error",
      errorCode: "microphone-busy",
      errorAction: "retry",
    });
    expect(blocked.order).toEqual(["playback.start"]);
    expect(voiceMicrophoneHeld()).toBe(true);
    releaseVoiceMicrophone(dictation);

    const harness = createHarness();
    await harness.goLive();
    const dictationStates: Array<{ readonly errorCode?: string }> = [];
    const recorder = {
      uri: null,
      prepareToRecordAsync: vi.fn(async () => undefined),
      record: vi.fn(),
      stop: async () => undefined,
    };
    const voiceInput = new VoiceInputController({
      recorder,
      getTranscriber: () => null,
      requestPermission: async () => ({ granted: true, canAskAgain: true }),
      configureRecording: async () => undefined,
      releaseRecording: async () => undefined,
      deleteRecording: () => undefined,
      readDraft: () => ({ ownerKey: "draft", text: "", selection: { start: 0, end: 0 } }),
      commitDraft: () => undefined,
      onStateChange: (state) => dictationStates.push(state),
    });
    await voiceInput.start();
    expect(dictationStates.at(-1)?.errorCode).toBe("already-recording");
    expect(recorder.prepareToRecordAsync).not.toHaveBeenCalled();
    expect(harness.phase()).toBe("listening");

    harness.controller.end();
    expect(harness.socket.commands().at(-1)).toEqual({ type: "end" });
    expect(harness.phase()).toBe("idle");
    expect(voiceMicrophoneHeld()).toBe(false);
  });

  it("cancels a start that is still waiting on the microphone prompt", async () => {
    const prompt = deferred<void>();
    const harness = createHarness({ captureStart: () => prompt.promise });
    const start = harness.controller.start(harness.input);
    const microphone = await harness.captureStarted;
    expect(voiceMicrophoneHeld()).toBe(true);

    harness.controller.end();
    expect(harness.states.map((state) => state.phase)).toEqual(["connecting", "idle"]);
    expect(voiceMicrophoneHeld()).toBe(false);
    expect(microphone.signal.aborted).toBe(true);
    expect(harness.capture.stop).toHaveBeenCalled();

    // The user answers the prompt after all.
    prompt.resolve();
    await start;
    expect(harness.order).toEqual(["playback.start", "capture.start"]);
    expect(harness.phase()).toBe("idle");
  });

  it("captions what the agent says and marks what a barge-in cut", async () => {
    const harness = createHarness();
    await harness.goLive();
    const { socket, controller } = harness;
    socket.receive(started("item_A"));
    socket.receive({ type: "caption-delta", itemId: "item_A", delta: "On " });
    socket.receive({ type: "caption-delta", itemId: "item_A", delta: "it" });
    socket.receive(done("item_A"));
    // The endpoint finishes the transcript after the audio.
    socket.receive({ type: "caption-done", itemId: "item_A", text: "On it." });
    socket.receive(started("item_B"));
    socket.receive({ type: "caption-delta", itemId: "item_B", delta: "Next" });
    expect(controller.currentCaptions).toEqual([
      { itemId: "item_A", text: "On it.", done: true, interrupted: false },
      { itemId: "item_B", text: "Next", done: false, interrupted: false },
    ]);
    expect(harness.captions.at(-1)).toBe(controller.currentCaptions);

    socket.receive({ type: "user-speech-started", flushId: 0 });
    await harness.answerFlush(0, { itemId: "item_A", playedMs: 300, pending: true });
    const cut = [{ itemId: "item_A", text: "On it.", done: true, interrupted: true }];
    expect(controller.currentCaptions).toEqual(cut);

    const notified = harness.captions.length;
    socket.receive({ type: "caption-delta", itemId: "item_A", delta: " Late." });
    socket.receive({ type: "caption-delta", itemId: "item_B", delta: " thing" });
    socket.receive({ type: "caption-done", itemId: "item_B", text: "Next thing." });
    expect(controller.currentCaptions).toEqual(cut);
    expect(harness.captions).toHaveLength(notified);

    socket.receive(started("item_C"));
    socket.receive({ type: "caption-done", itemId: "item_C", text: "Done." });
    expect(controller.currentCaptions).toEqual([
      ...cut,
      { itemId: "item_C", text: "Done.", done: true, interrupted: false },
    ]);

    controller.end();
    expect(controller.currentCaptions).toEqual([]);
  });
});
