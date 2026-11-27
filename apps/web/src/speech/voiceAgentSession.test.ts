import { BearerConnectionTarget } from "@t3tools/client-runtime/connection";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  VOICE_AGENT_INPUT_FRAME_BYTES,
  type ServerSettings,
  type TextGeneratorConfig,
  type VoiceAgentEvent,
  type VoiceAgentLaunchSettings,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { voiceAgentSession, type VoiceAgentTarget } from "./voiceAgentSession";
import { chooseVoiceAgentDestination, type VoiceAgentDestination } from "./voiceConsent";

const mocks = vi.hoisted(() => ({
  settings: null as ServerSettings | null,
  voiceMode: true,
  operate: true,
  prepared: null as unknown,
}));

vi.mock("../connection/runtime", async () => {
  const [{ Atom }, { layerRemoteHttpClient }] = await Promise.all([
    import("effect/reactivity"),
    import("@t3tools/client-runtime/rpc"),
  ]);
  return {
    connectionAtomRuntime: Atom.runtime(
      layerRemoteHttpClient((input, init) => globalThis.fetch(input, init)),
    ),
  };
});
vi.mock("./browserMicrophones", () => ({ chooseRecordingMicrophone: async () => "" }));
vi.mock("../state/environments", () => {
  const environment = () =>
    mocks.settings && {
      serverConfig: {
        environment: { capabilities: { voiceMode: mocks.voiceMode } },
        settings: mocks.settings,
      },
    };
  return {
    readEnvironment: environment,
    useEnvironment: (environmentId: string | null) =>
      environmentId === null ? null : environment(),
  };
});
vi.mock("../state/session", async () => {
  const Option = await import("effect/Option");
  return {
    readPreparedConnection: () => mocks.prepared,
    usePreparedConnection: () => Option.fromNullishOr(mocks.prepared),
    useEnvironmentScope: () => mocks.operate,
  };
});

const environmentId = EnvironmentId.make("voice-environment");
const projectId = ProjectId.make("project-a");
const threadId = ThreadId.make("thread-a");
const endpointId = ProviderInstanceId.make("gateway");
const baseUrl = "https://gateway.example.test/v1";
const destination: VoiceAgentDestination = { environmentId, endpointId, baseUrl };
const target: VoiceAgentTarget = { environmentId, projectId, threadId, draftThreadId: null };
const launch: VoiceAgentLaunchSettings = {
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
  runtimeMode: "approval-required",
  interactionMode: "default",
};
const generator: TextGeneratorConfig = {
  kind: "openaiCompatible",
  baseUrl,
  apiKey: "",
  enabled: true,
  voiceModel: "realtime-voice",
};
const connection = new BearerConnectionTarget({
  environmentId,
  label: "Voice environment",
  connectionId: "voice",
});
const prepared = {
  environmentId,
  label: connection.label,
  target: connection,
  httpBaseUrl: "https://voice.example.test",
  socketUrl: "wss://voice.example.test/ws",
  httpAuthorization: { _tag: "Bearer" as const, token: "session-token" },
};
const frame = () => new Int16Array(VOICE_AGENT_INPUT_FRAME_BYTES / 2);

function setup(grant: VoiceAgentDestination | null) {
  mocks.settings = {
    ...DEFAULT_SERVER_SETTINGS,
    voiceModeEnabled: true,
    textGenerators: { [endpointId]: generator },
  };
  mocks.voiceMode = true;
  mocks.operate = true;
  mocks.prepared = prepared;
  chooseVoiceAgentDestination(grant);
}

class TestSocket extends EventTarget {
  readonly sent: unknown[] = [];
  binaryType = "blob";
  bufferedAmount = 0;
  constructor(readonly url: string) {
    super();
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {}
  receive(event: VoiceAgentEvent) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
  }
  commands() {
    return this.sent.flatMap((data) => (typeof data === "string" ? [JSON.parse(data)] : []));
  }
}

/** What a worklet node was told, and a way to answer as its processor would. */
type TestNode = { readonly posted: unknown[]; readonly emit: (data: unknown) => void };

function stubGlobal(name: string, value: unknown): Disposable {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  return {
    [Symbol.dispose]() {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    },
  };
}

/**
 * The browser around a session: storage, audio graph, microphone, ticket endpoint and media
 * socket. The session is the app's singleton, so disposing ends it and takes the grant away.
 */
function browser() {
  const contexts: Array<{ closed: boolean }> = [];
  const nodes = new Map<string, TestNode>();
  const sockets: TestSocket[] = [];
  const ticketRequests: string[] = [];
  const stopTrack = vi.fn();
  const stream = {
    getTracks: () => [{ stop: stopTrack, addEventListener() {} }],
  } as unknown as MediaStream;
  const resources = new DisposableStack();
  const stored = new Map<string, string>();
  resources.use(
    stubGlobal(
      "window",
      Object.assign(new EventTarget(), {
        localStorage: {
          getItem: (key: string) => stored.get(key) ?? null,
          setItem: (key: string, value: string) => void stored.set(key, value),
          removeItem: (key: string) => void stored.delete(key),
        },
      }),
    ),
  );
  const getUserMedia = vi.fn<MediaDevices["getUserMedia"]>().mockResolvedValue(stream);
  resources.use(stubGlobal("navigator", { mediaDevices: { getUserMedia } }));
  resources.use(
    stubGlobal(
      "AudioContext",
      class {
        audioWorklet = { addModule: async () => {} };
        destination = {};
        state = "running";
        closed = false;
        constructor() {
          contexts.push(this);
        }
        createMediaStreamSource() {
          return { connect() {} };
        }
        resume = async () => {};
        close = async () => {
          this.closed = true;
        };
      },
    ),
  );
  resources.use(
    stubGlobal(
      "AudioWorkletNode",
      class {
        readonly port;
        constructor(_context: unknown, name: string) {
          let receive: ((event: { data: unknown }) => void) | null = null;
          const posted: unknown[] = [];
          this.port = {
            set onmessage(handler: typeof receive) {
              receive = handler;
            },
            postMessage: (message: unknown) => void posted.push(message),
            close() {},
          };
          nodes.set(name, { posted, emit: (data) => receive?.({ data }) });
        }
        connect() {}
        disconnect() {}
      },
    ),
  );
  resources.use(
    stubGlobal(
      "WebSocket",
      class extends TestSocket {
        constructor(url: string) {
          super(url);
          sockets.push(this);
        }
      },
    ),
  );
  const fetch = globalThis.fetch;
  resources.use(
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (!request.url.includes("/api/auth/websocket-ticket/")) return fetch(input, init);
      ticketRequests.push(request.url);
      return Response.json({ ticket: "voice-ticket", expiresAt: "2030-01-01T00:00:00.000Z" });
    }),
  );
  // Registered last, so it runs first: the session lets go while the fakes are still in place.
  // The grant is chosen after this, by `setup`, so it lands in the stubbed storage.
  resources.defer(() => {
    voiceAgentSession.end();
    chooseVoiceAgentDestination(null);
  });
  return {
    contexts,
    nodes,
    sockets,
    ticketRequests,
    stopTrack,
    stream,
    getUserMedia,
    /** Starts on `target` and answers as a server that accepted the session. */
    async live() {
      await voiceAgentSession.start(target, launch);
      const socket = sockets[0]!;
      socket.dispatchEvent(new Event("open"));
      socket.receive({ type: "ready", threadId });
      return {
        socket,
        microphone: nodes.get("t3-pcm-capture")!,
        player: nodes.get("t3-pcm-player")!,
      };
    },
    [Symbol.dispose]: () => resources.dispose(),
  };
}

const state = () => voiceAgentSession.getSnapshot().state;

it.each([
  ["no grant", null],
  ["a grant for another address", { ...destination, baseUrl: "https://elsewhere.example.test/v1" }],
])("opens no microphone, ticket or socket with %s", async (_name, grant) => {
  using page = browser();
  setup(grant);
  await voiceAgentSession.start(target);
  expect(voiceAgentSession.getSnapshot()).toMatchObject({
    state: { phase: "error", errorCode: "consent-required" },
    target,
  });
  expect(page.getUserMedia).not.toHaveBeenCalled();
  expect(page.ticketRequests).toEqual([]);
  expect(page.sockets).toEqual([]);
  // The output opened inside the gesture is not left running.
  expect(page.contexts).toEqual([expect.objectContaining({ closed: true })]);
});

it("starts at the consented destination and sends nothing once consent is revoked", async () => {
  using page = browser();
  setup(destination);
  const { socket, microphone } = await page.live();
  expect(socket.url).toBe("wss://voice.example.test/ws/voice-agent?wsTicket=voice-ticket");
  expect(socket.commands()).toEqual([
    { type: "start", projectId, threadId, endpointId, baseUrl, launch },
  ]);
  // The agent is audible while the microphone is open, so the browser must cancel its echo.
  expect(page.getUserMedia).toHaveBeenCalledExactlyOnceWith({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  expect(voiceAgentSession.getSnapshot()).toMatchObject({
    state: { phase: "listening", threadId },
    target,
  });
  microphone.emit(0.5);
  expect(voiceAgentSession.getLevels()).toEqual({ input: 0.5, output: 0 });
  const sent = frame();
  microphone.emit(sent);
  expect(socket.sent.at(-1)).toBe(sent);

  chooseVoiceAgentDestination(null);
  microphone.emit(frame());
  expect(state()).toMatchObject({ phase: "error", errorCode: "consent-revoked", threadId });
  expect(socket.sent.at(-1)).toBe(sent);
  expect(page.stopTrack).toHaveBeenCalledOnce();
  expect(page.contexts.map((context) => context.closed)).toEqual([true, true]);
  expect(voiceAgentSession.getLevels()).toEqual({ input: 0, output: 0 });

  voiceAgentSession.dismiss();
  expect(voiceAgentSession.getSnapshot()).toMatchObject({ state: { phase: "idle" }, target: null });
});

it("cuts playback when the user speaks and reports how much of the item was heard", async () => {
  using page = browser();
  setup(destination);
  const { socket, player } = await page.live();
  socket.receive({ type: "agent-speech-started", itemId: "item-1" });
  const audio = new Int16Array(2_400);
  socket.dispatchEvent(new MessageEvent("message", { data: audio.buffer }));
  expect(player.posted).toEqual([{ type: "enqueue", itemId: "item-1", pcm: audio }]);
  player.emit({ type: "playing", playing: true });
  expect(state().phase).toBe("agentSpeaking");

  socket.receive({ type: "user-speech-started", flushId: 7 });
  expect(state().phase).toBe("userSpeaking");
  expect(player.posted.at(-1)).toEqual({ type: "flush", id: 1 });
  // 1 200 samples at 24 kHz are 50 ms.
  player.emit({ type: "flushed", id: 1, itemId: "item-1", positionSamples: 1_200, pending: true });
  await vi.waitFor(() =>
    expect(socket.commands().at(-1)).toEqual({
      type: "playback-flushed",
      flushId: 7,
      itemId: "item-1",
      playedMs: 50,
    }),
  );
});

it("lets go of a microphone the user grants after cancelling the start", async () => {
  using page = browser();
  setup(destination);
  const prompt = Promise.withResolvers<MediaStream>();
  page.getUserMedia.mockReturnValue(prompt.promise);
  const started = voiceAgentSession.start(target);
  // Nothing was awaited: the output is opened inside the gesture that called `start`.
  expect(page.contexts).toHaveLength(1);
  expect(state().phase).toBe("connecting");
  await vi.waitFor(() => expect(page.getUserMedia).toHaveBeenCalled());

  voiceAgentSession.end();
  expect(voiceAgentSession.getSnapshot()).toMatchObject({ state: { phase: "idle" }, target: null });
  prompt.resolve(page.stream);
  await started;
  expect(page.stopTrack).toHaveBeenCalledOnce();
  expect(page.sockets).toEqual([]);
  expect(page.contexts).toEqual([expect.objectContaining({ closed: true })]);
});

it("reports a start it cannot make, and returns to idle from it", async () => {
  using page = browser();
  setup(destination);
  mocks.prepared = null;
  await voiceAgentSession.start(target);
  expect(voiceAgentSession.getSnapshot()).toMatchObject({
    state: { phase: "error", errorCode: "not-configured", errorAction: "settings" },
    target,
  });
  expect(page.contexts).toEqual([]);
  voiceAgentSession.dismiss();
  expect(voiceAgentSession.getSnapshot()).toMatchObject({ state: { phase: "idle" }, target: null });
});
