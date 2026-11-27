// @effect-diagnostics nodeBuiltinImport:off - a raw HTTP server lets the fake refuse an upgrade with a status.
// The event shapes here come from public OpenAI Realtime and LiteLLM docs and one owner
// observation. They were never checked against a live endpoint.
// A test that passes against this fake shows that the adapter and the fake agree, and that the
// session logic is right given these shapes. It does not show that a real gateway behaves so.
import * as NodeWS from "@effect/platform-node/NodeWS";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as NodeHttp from "node:http";

type ReceivedEvent = { readonly type: string; readonly [key: string]: unknown };

export interface FakeRealtimeConnection {
  /** Request path with query, and the upgrade request's headers. */
  readonly path: string;
  readonly headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;
  /** Client events as parsed JSON, in arrival order. */
  readonly received: Queue.Dequeue<ReceivedEvent>;
  readonly send: (event: object) => void;
  readonly close: (code?: number, reason?: string) => void;
  /** Completes once the socket is closed, by either side. */
  readonly closed: Effect.Effect<void>;
}

export interface FakeRealtimeServer {
  /** `http://127.0.0.1:<port>/v1`: what a text generator's base URL would be. */
  readonly baseUrl: string;
  readonly connections: Queue.Dequeue<FakeRealtimeConnection>;
  readonly connectionCount: () => number;
}

const isReceivedEvent = (value: unknown): value is ReceivedEvent =>
  typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";

const parseReceived = (data: NodeWS.RawData): ReceivedEvent | undefined => {
  try {
    const value: unknown = JSON.parse(data.toString());
    return isReceivedEvent(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

/**
 * A local OpenAI-Realtime-shaped WebSocket endpoint. Closes with the scope.
 *
 * It does not validate what it receives and does not imitate an endpoint's reactions: tests
 * script every server event and assert on what the adapter sent.
 */
export const fakeRealtimeServer = Effect.fn("fakeRealtimeServer")(function* (
  options: {
    /** 0, the default, picks a free port. */
    readonly port?: number;
    /** A status refuses the upgrade with it, as a gateway does for a bad key or model. */
    readonly refuseUpgrade?: (request: {
      readonly path: string;
      readonly authorization: string | undefined;
    }) => number | undefined;
    /** Answered on `GET /v1/models`. */
    readonly models?: ReadonlyArray<string>;
    /** Extra HTTP routes of the dev script. Returns true when it answered the request. */
    readonly handleRequest?: (
      request: NodeHttp.IncomingMessage,
      response: NodeHttp.ServerResponse,
    ) => boolean;
  } = {},
) {
  const connections = yield* Queue.unbounded<FakeRealtimeConnection>();
  const runSync = Effect.runSyncWith(yield* Effect.context<never>());
  const models = options.models ?? ["fake-realtime"];
  let connectionCount = 0;

  const { port } = yield* Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{
          readonly http: NodeHttp.Server;
          readonly sockets: NodeWS.WebSocketServer;
          readonly port: number;
        }>((resolve) => {
          const http = NodeHttp.createServer((request, response) => {
            if (options.handleRequest?.(request, response) === true) return;
            if (request.method === "GET" && request.url === "/v1/models") {
              response.writeHead(200, { "content-type": "application/json" });
              response.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
              return;
            }
            response.writeHead(404).end();
          });
          const sockets = new NodeWS.WebSocketServer({
            server: http,
            verifyClient: (info, done) => {
              const status = options.refuseUpgrade?.({
                path: info.req.url ?? "",
                authorization: info.req.headers.authorization,
              });
              if (status === undefined) done(true);
              else done(false, status);
            },
          });
          sockets.on("connection", (socket, request) => {
            connectionCount++;
            const received = runSync(Queue.unbounded<ReceivedEvent>());
            const closed = Deferred.makeUnsafe<void>();
            socket.on("message", (data) => {
              const event = parseReceived(data);
              if (event !== undefined) Queue.offerUnsafe(received, event);
            });
            socket.once("close", () => Deferred.doneUnsafe(closed, Effect.void));
            Queue.offerUnsafe(connections, {
              path: request.url ?? "",
              headers: request.headers,
              received,
              send: (event) => socket.send(JSON.stringify(event)),
              close: (code, reason) => socket.close(code, reason),
              closed: Deferred.await(closed),
            });
          });
          http.listen(options.port ?? 0, "127.0.0.1", () => {
            const address = http.address();
            resolve({
              http,
              sockets,
              port: typeof address === "object" && address !== null ? address.port : 0,
            });
          });
        }),
    ),
    ({ http, sockets }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            for (const client of sockets.clients) client.terminate();
            sockets.close();
            http.closeAllConnections();
            http.close(() => resolve());
          }),
      ),
  );

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    connections,
    connectionCount: () => connectionCount,
  } satisfies FakeRealtimeServer;
});

const PCM_BYTES_PER_MS = 48;
const TONE_HZ = 440;
const SAMPLE_RATE = 24_000;

/** PCM16 24 kHz mono, a quiet 440 Hz sine: audible in a browser pass, valid PCM for tests. */
const tone = (milliseconds: number): string => {
  const pcm = Buffer.alloc(milliseconds * PCM_BYTES_PER_MS);
  for (let sample = 0; sample < pcm.byteLength / 2; sample++) {
    pcm.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * TONE_HZ * sample) / SAMPLE_RATE) * 6_000),
      sample * 2,
    );
  }
  return pcm.toString("base64");
};

/** Server events in the GA shape. */
export const fakeRealtime = {
  sessionCreated: (): object => ({
    type: "session.created",
    session: {
      type: "realtime",
      output_modalities: ["audio"],
      audio: {
        input: {
          format: { type: "audio/pcm", rate: SAMPLE_RATE },
          transcription: null,
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
            create_response: true,
            interrupt_response: true,
          },
        },
        output: { format: { type: "audio/pcm", rate: SAMPLE_RATE }, voice: "marin" },
      },
      tools: [],
      tool_choice: "auto",
    },
  }),
  sessionUpdated: (): object => ({ type: "session.updated", session: { type: "realtime" } }),
  speechStarted: (itemId = "item_user"): object => ({
    type: "input_audio_buffer.speech_started",
    audio_start_ms: 0,
    item_id: itemId,
  }),
  speechStopped: (itemId = "item_user"): object => ({
    type: "input_audio_buffer.speech_stopped",
    audio_end_ms: 0,
    item_id: itemId,
  }),
  responseCreated: (responseId: string): object => ({
    type: "response.created",
    response: { id: responseId, status: "in_progress", output: [] },
  }),
  responseDone: (
    responseId: string,
    status = "completed",
    output: ReadonlyArray<object> = [],
  ): object => ({ type: "response.done", response: { id: responseId, status, output } }),
  audioDelta: (itemId: string, milliseconds: number): object => ({
    type: "response.output_audio.delta",
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    delta: tone(milliseconds),
  }),
  audioDone: (itemId: string): object => ({
    type: "response.output_audio.done",
    item_id: itemId,
    output_index: 0,
    content_index: 0,
  }),
  transcriptDelta: (itemId: string, delta: string): object => ({
    type: "response.output_audio_transcript.delta",
    item_id: itemId,
    delta,
  }),
  transcriptDone: (itemId: string, transcript: string): object => ({
    type: "response.output_audio_transcript.done",
    item_id: itemId,
    transcript,
  }),
  functionCall: (callId: string, name: string, args: object, status = "completed"): object => ({
    type: "response.output_item.done",
    item: {
      id: `item_${callId}`,
      type: "function_call",
      status,
      call_id: callId,
      name,
      arguments: JSON.stringify(args),
    },
  }),
  error: (code: string, eventId?: string): object => ({
    type: "error",
    error: { type: "invalid_request_error", code, message: code, event_id: eventId ?? null },
  }),
};

/** Plays the compliant opening: `session.created`, awaits `session.update`, answers `session.updated`. */
export const acceptFakeSession = Effect.fn("acceptFakeSession")(function* (
  connection: FakeRealtimeConnection,
) {
  connection.send(fakeRealtime.sessionCreated());
  while (true) {
    const event = yield* Queue.take(connection.received);
    if (event.type !== "session.update") continue;
    connection.send(fakeRealtime.sessionUpdated());
    return event;
  }
});
