import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  VOICE_AGENT_INPUT_FRAME_BYTES,
  VOICE_AGENT_MAX_AUDIO_FRAME_BYTES,
  VOICE_AGENT_MAX_QUEUED_INPUT_BYTES,
  VOICE_AGENT_READY_TIMEOUT_MS,
  type VoiceAgentEvent,
} from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { openVoiceAgentSocket, type VoiceAgentSocketEnd } from "./socket.ts";

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
  receiveBytes(data: ArrayBuffer) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  receiveAudio(pcm: Int16Array<ArrayBuffer>) {
    this.receiveBytes(pcm.buffer);
  }
}

const start = {
  projectId: ProjectId.make("project-a"),
  threadId: ThreadId.make("thread-a"),
  endpointId: ProviderInstanceId.make("gateway"),
  baseUrl: "https://gateway.test/v1",
};
const frame = () => new Int16Array(VOICE_AGENT_INPUT_FRAME_BYTES / 2);
const BACKED_UP = VOICE_AGENT_MAX_QUEUED_INPUT_BYTES + 1;

function connect(canSend = () => true) {
  const socket = new TestSocket();
  const events: VoiceAgentEvent[] = [];
  const audio: Int16Array[] = [];
  const ends: VoiceAgentSocketEnd[] = [];
  const voice = openVoiceAgentSocket({
    url: "wss://environment.test/ws/voice-agent?wsTicket=ticket",
    start,
    canSend,
    onEvent: (event) => events.push(event),
    onAudio: (pcm) => audio.push(pcm),
    onEnd: (end) => ends.push(end),
    createSocket: () => socket as unknown as WebSocket,
  });
  return { socket, voice, events, audio, ends };
}

function connectReady(canSend = () => true) {
  const connection = connect(canSend);
  connection.socket.open();
  connection.socket.receive({ type: "ready", threadId: start.threadId });
  connection.socket.sent.length = 0;
  return connection;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

it("names the consented destination in start and sends microphone audio only once ready", () => {
  const { socket, voice, events, ends } = connect();
  expect(socket.binaryType).toBe("arraybuffer");
  expect(socket.sent).toEqual([]);
  socket.open();
  expect(socket.sent.map((data) => JSON.parse(data as string))).toEqual([
    { type: "start", ...start },
  ]);

  expect(voice.sendAudio(frame())).toBe(false);
  expect(socket.sent).toHaveLength(1);

  socket.receive({ type: "ready", threadId: start.threadId });
  expect(events).toEqual([{ type: "ready", threadId: start.threadId }]);
  const first = frame();
  expect(voice.sendAudio(first)).toBe(true);
  expect(socket.sent[1]).toBe(first);

  // No ping and no start timeout once ready: a quiet session sends nothing by itself.
  vi.advanceTimersByTime(10 * VOICE_AGENT_READY_TIMEOUT_MS);
  expect(socket.sent).toHaveLength(2);
  expect(ends).toEqual([]);

  voice.sendPlaybackFlushed(3, "item_A", 480);
  expect(JSON.parse(socket.sent[2] as string)).toEqual({
    type: "playback-flushed",
    flushId: 3,
    itemId: "item_A",
    playedMs: 480,
  });
});

it("skips events it cannot read and keeps the session", () => {
  const { socket, events, ends } = connectReady();
  socket.receive({ type: "agent-thinking", itemId: "item_A" });
  socket.receive({ type: "agent-speech-started", itemId: 7 });
  socket.dispatchEvent(new MessageEvent("message", { data: "not json" }));
  socket.receive({ type: "user-speech-stopped" });
  expect(events.slice(1)).toEqual([{ type: "user-speech-stopped" }]);
  expect(ends).toEqual([]);
  expect(socket.closed).toBe(false);
});

it.each([
  {
    name: "a failure reason and its message",
    closed: { type: "closed", reason: "endpoint-refused", message: "Gateway said no." },
    end: { kind: "closed", reason: "endpoint-refused", message: "Gateway said no." },
  },
  {
    name: "a normal reason",
    closed: { type: "closed", reason: "idle" },
    end: { kind: "closed", reason: "idle" },
  },
  {
    name: "a reason from a newer server",
    closed: { type: "closed", reason: "from-the-future", message: "Something new." },
    end: { kind: "closed", reason: null, message: "Something new." },
  },
])("ends once on closed with $name", ({ closed, end }) => {
  const { socket, events, ends } = connectReady();
  socket.receive(closed);
  // The server closes right after `closed`; the real socket also reports our own close.
  socket.dispatchEvent(new Event("close"));
  socket.receive({ type: "user-speech-stopped" });
  expect(ends).toEqual([end]);
  expect(events).toHaveLength(1);
  expect(socket.closed).toBe(true);
});

it.each([
  {
    name: "a close before it opened",
    run: ({ socket }: ReturnType<typeof connect>) => socket.dispatchEvent(new Event("close")),
    end: { kind: "connect-failed" },
  },
  {
    name: "an error before it opened",
    run: ({ socket }: ReturnType<typeof connect>) => socket.dispatchEvent(new Event("error")),
    end: { kind: "connect-failed" },
  },
  {
    name: "no ready in time",
    run: ({ socket }: ReturnType<typeof connect>) => {
      socket.open();
      vi.advanceTimersByTime(VOICE_AGENT_READY_TIMEOUT_MS);
    },
    end: { kind: "start-timeout" },
  },
  {
    name: "a connect that never completes",
    run: () => vi.advanceTimersByTime(VOICE_AGENT_READY_TIMEOUT_MS),
    end: { kind: "start-timeout" },
  },
  {
    name: "a close after it opened",
    run: ({ socket }: ReturnType<typeof connect>) => {
      socket.open();
      socket.receive({ type: "ready", threadId: null });
      socket.dispatchEvent(new Event("close"));
    },
    end: { kind: "lost" },
  },
])("reports $name as $end.kind", ({ run, end }) => {
  const connection = connect();
  run(connection);
  expect(connection.ends).toEqual([end]);
  expect(connection.socket.closed).toBe(true);
  expect(connection.voice.sendAudio(frame())).toBe(false);
});

it.each(["before start", "on a microphone frame"])(
  "sends nothing once consent is revoked %s",
  (when) => {
    let allowed = when !== "before start";
    const { socket, voice, ends } = connect(() => allowed);
    socket.open();
    if (when === "on a microphone frame") {
      socket.receive({ type: "ready", threadId: null });
      expect(voice.sendAudio(frame())).toBe(true);
      allowed = false;
      expect(voice.sendAudio(frame())).toBe(false);
    }
    const sent = socket.sent.length;
    expect(sent).toBe(when === "before start" ? 0 : 2);
    expect(ends).toEqual([{ kind: "consent-revoked" }]);
    expect(socket.closed).toBe(true);

    allowed = true;
    expect(voice.sendAudio(frame())).toBe(false);
    voice.sendPlaybackFlushed(0, null, 0);
    voice.end();
    expect(socket.sent).toHaveLength(sent);
  },
);

it("drops microphone audio while backed up and gives up after 15 s of it", () => {
  const recovering = connectReady();
  recovering.socket.bufferedAmount = BACKED_UP;
  for (let dropped = 0; dropped < 374; dropped += 1) {
    expect(recovering.voice.sendAudio(frame())).toBe(false);
  }
  expect(recovering.socket.sent).toEqual([]);
  recovering.socket.bufferedAmount = VOICE_AGENT_MAX_QUEUED_INPUT_BYTES;
  expect(recovering.voice.sendAudio(frame())).toBe(true);
  // The sent frame restarted the count.
  recovering.socket.bufferedAmount = BACKED_UP;
  for (let dropped = 0; dropped < 374; dropped += 1) recovering.voice.sendAudio(frame());
  expect(recovering.ends).toEqual([]);
  expect(recovering.socket.sent).toHaveLength(1);

  const dead = connectReady();
  dead.socket.bufferedAmount = BACKED_UP;
  for (let dropped = 0; dropped < 374; dropped += 1) dead.voice.sendAudio(frame());
  expect(dead.ends).toEqual([]);
  expect(dead.voice.sendAudio(frame())).toBe(false);
  expect(dead.ends).toEqual([{ kind: "lost" }]);
  expect(dead.socket.sent).toEqual([]);
  expect(dead.socket.closed).toBe(true);
});

it("delivers agent audio as samples and skips frames that are not PCM16", () => {
  const { socket, audio, ends } = connectReady();
  socket.receiveBytes(new ArrayBuffer(0));
  socket.receiveBytes(new ArrayBuffer(3));
  socket.receiveBytes(new ArrayBuffer(VOICE_AGENT_MAX_AUDIO_FRAME_BYTES + 2));
  socket.receiveAudio(new Int16Array([1, -2, 32_767]));
  socket.receiveBytes(new ArrayBuffer(VOICE_AGENT_MAX_AUDIO_FRAME_BYTES));
  expect(audio.map((pcm) => pcm.length)).toEqual([3, VOICE_AGENT_MAX_AUDIO_FRAME_BYTES / 2]);
  expect(Array.from(audio[0]!)).toEqual([1, -2, 32_767]);
  expect(ends).toEqual([]);
});

it.each(["before", "after"])("ends quietly when the user ends it %s the socket opened", (when) => {
  const { socket, voice, events, ends } = connect();
  if (when === "after") {
    socket.open();
    socket.receive({ type: "ready", threadId: null });
  }
  voice.end();
  expect(socket.sent.at(-1)).toBe(when === "after" ? '{"type":"end"}' : undefined);
  expect(socket.closed).toBe(true);

  socket.dispatchEvent(new Event("close"));
  socket.receive({ type: "closed", reason: "ended" });
  vi.advanceTimersByTime(VOICE_AGENT_READY_TIMEOUT_MS);
  expect(ends).toEqual([]);
  expect(events).toHaveLength(when === "after" ? 1 : 0);
});
