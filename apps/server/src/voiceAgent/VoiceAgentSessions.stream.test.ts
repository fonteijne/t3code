// Real sockets on both sides: a WebSocket client on the route, and the real adapter on a fake
// endpoint. The fake's event shapes were never checked against a live endpoint (see the testkit).
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import {
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  ProjectId,
  ProviderInstanceId,
  VOICE_AGENT_INPUT_FRAME_BYTES,
  VOICE_AGENT_STREAM_PATH,
  VoiceAgentEvent,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServer } from "effect/http";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as RealtimeUpstream from "./RealtimeUpstream.ts";
import { acceptFakeSession, fakeRealtime, fakeRealtimeServer } from "./RealtimeUpstream.testkit.ts";
import * as VoiceAgentSessions from "./VoiceAgentSessions.ts";
import * as VoiceAgentThreads from "./VoiceAgentThreads.ts";

const PROJECT = ProjectId.make("project-voice");
const ENDPOINT = ProviderInstanceId.make("gateway");
const KEY = "sk-voice-stream-key";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(VoiceAgentEvent));

const authenticated = (scopes: ReadonlyArray<AuthEnvironmentScope>) => ({
  sessionId: AuthSessionId.make("voice-test-session"),
  subject: "test",
  method: "bearer-access-token" as const,
  scopes,
});

/** The route and the session service on a real HTTP server, in front of the real adapter. */
const serveVoiceRoute = Effect.fn("serveVoiceRoute")(function* (savedBaseUrl: string) {
  const invalidated = yield* Deferred.make<void>();
  const services = yield* Layer.build(
    HttpRouter.serve(VoiceAgentSessions.routeLayer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provide(VoiceAgentSessions.layer),
      Layer.provide(
        Layer.mergeAll(
          RealtimeUpstream.layer,
          ServerSettings.layerTest({
            voiceModeEnabled: true,
            textGenerators: {
              [ENDPOINT]: {
                kind: "openaiCompatible",
                label: "Gateway",
                baseUrl: savedBaseUrl,
                apiKey: KEY,
                enabled: true,
                voiceModel: "fake-realtime",
              },
            },
          }),
          // The key is saved as text, so nothing is read from a secret provider.
          Layer.mock(SecretResolver.SecretResolver)({}),
          Layer.succeed(
            SecureRandom.SecureRandom,
            SecureRandom.make((size) => new Uint8Array(size).fill(7)),
          ),
          Layer.mock(VoiceAgentThreads.VoiceAgentThreads)({
            open: ({ projectId, threadId, sessionId }) =>
              Effect.succeed({
                binding: { projectId, threadId, sessionId, calls: 0, ceiling: null },
                context: {
                  projectTitle: "Voice project",
                  thread: null,
                  agentsFile: "",
                  claudeFile: "",
                },
              }),
            watch: () => Stream.never,
          }),
          Layer.mock(SessionStore.SessionStore)({
            cookieName: "test",
            legacyCookieName: undefined,
            awaitInvalidation: () => Deferred.await(invalidated),
          }),
          Layer.mock(EnvironmentAuth.EnvironmentAuth)({
            authenticateWebSocketUpgrade: () =>
              Effect.succeed(authenticated([AuthOrchestrationOperateScope])),
          }),
        ),
      ),
    ),
  );
  const origin = HttpServer.formatAddress(
    Context.get(services, HttpServer.HttpServer).address,
  ).replace(/^http/, "ws");
  return {
    url: `${origin}${VOICE_AGENT_STREAM_PATH}?wsTicket=test`,
    /** Revokes the client's session. */
    invalidate: Deferred.succeed(invalidated, undefined),
  };
});

/** A browser-like client of the media socket. Resolves once the socket is open. */
const openClient = Effect.fn("openClient")(function* (url: string) {
  const frames = yield* Queue.unbounded<VoiceAgentEvent | Uint8Array>();
  const opened = yield* Deferred.make<void>();
  const closed = yield* Deferred.make<number>();
  const socket = yield* Effect.acquireRelease(
    Effect.sync(() => new WebSocket(url)),
    (open) => Effect.sync(() => open.close()),
  );
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => Deferred.doneUnsafe(opened, Effect.void));
  socket.addEventListener("error", () =>
    Deferred.doneUnsafe(opened, Effect.die(new Error("The voice socket failed to open."))),
  );
  socket.addEventListener("message", ({ data }) => {
    Queue.offerUnsafe(
      frames,
      typeof data === "string" ? decodeEvent(data) : new Uint8Array(data as ArrayBuffer),
    );
  });
  socket.addEventListener("close", ({ code }) => Deferred.doneUnsafe(closed, Effect.succeed(code)));
  yield* Deferred.await(opened);
  return {
    send: (frame: object | Uint8Array) =>
      socket.send(frame instanceof Uint8Array ? frame : JSON.stringify(frame)),
    /** The next frame from the server, waiting for it. */
    next: Queue.take(frames),
    /** Frames that arrived and were not read. */
    unread: Queue.clear(frames),
    /** The close code, once the socket closed. */
    closed: Deferred.await(closed),
  };
});

const start = (baseUrl: string) => ({
  type: "start",
  projectId: PROJECT,
  endpointId: ENDPOINT,
  baseUrl,
});

it.live("carries a spoken exchange between a client socket and the endpoint's socket", () =>
  Effect.gen(function* () {
    const saved = yield* fakeRealtimeServer();
    const elsewhere = yield* fakeRealtimeServer();
    const server = yield* serveVoiceRoute(saved.baseUrl);

    // A device that consented to another address is refused, and nothing is dialed for it.
    const refused = yield* openClient(server.url);
    refused.send(start(elsewhere.baseUrl));
    expect(yield* refused.next).toMatchObject({ type: "closed", reason: "not-configured" });
    expect(yield* refused.closed).toBe(1008);
    expect([saved.connectionCount(), elsewhere.connectionCount()]).toEqual([0, 0]);

    const client = yield* openClient(server.url);
    client.send(start(saved.baseUrl));
    const endpoint = yield* Queue.take(saved.connections);
    const update = yield* acceptFakeSession(endpoint);
    // The saved key goes to the saved address, and only there.
    expect(endpoint.path).toBe("/v1/realtime?model=fake-realtime");
    expect(endpoint.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(update).toMatchObject({ session: { type: "realtime" } });
    expect(yield* client.next).toEqual({ type: "ready", threadId: null });

    const microphone = new Uint8Array(VOICE_AGENT_INPUT_FRAME_BYTES).fill(3);
    client.send(microphone);
    expect(yield* Queue.take(endpoint.received)).toEqual({
      type: "input_audio_buffer.append",
      audio: Buffer.from(microphone).toString("base64"),
    });

    endpoint.send(fakeRealtime.responseCreated("resp_1"));
    endpoint.send(fakeRealtime.audioDelta("item_a", 400));
    expect(yield* client.next).toEqual({ type: "agent-speech-started", itemId: "item_a" });
    let audioBytes = 0;
    while (audioBytes < 400 * 48) {
      const frame = yield* client.next;
      if (!(frame instanceof Uint8Array)) throw new Error("Expected agent audio.");
      audioBytes += frame.byteLength;
    }
    expect(audioBytes).toBe(400 * 48);

    // The developer talks over the reply: playback is cut, then the endpoint learns how far it got.
    endpoint.send(fakeRealtime.speechStarted());
    expect(yield* client.next).toEqual({ type: "user-speech-started", flushId: 0 });
    expect(yield* Queue.take(endpoint.received)).toMatchObject({
      type: "response.cancel",
      response_id: "resp_1",
    });
    client.send({ type: "playback-flushed", flushId: 0, itemId: "item_a", playedMs: 150 });
    expect(yield* Queue.take(endpoint.received)).toMatchObject({
      type: "conversation.item.truncate",
      item_id: "item_a",
      audio_end_ms: 150,
    });

    client.send({ type: "end" });
    expect(yield* client.next).toEqual({ type: "closed", reason: "ended" });
    expect(yield* client.closed).toBe(1000);
    yield* endpoint.closed;
    expect([saved.connectionCount(), elsewhere.connectionCount()]).toEqual([1, 0]);
  }).pipe(Effect.scoped),
);

it.live("a revoked session loses both sockets and hears no closed event", () =>
  Effect.gen(function* () {
    const saved = yield* fakeRealtimeServer();
    const server = yield* serveVoiceRoute(saved.baseUrl);
    const client = yield* openClient(server.url);
    client.send(start(saved.baseUrl));
    const endpoint = yield* Queue.take(saved.connections);
    yield* acceptFakeSession(endpoint);
    expect(yield* client.next).toEqual({ type: "ready", threadId: null });

    yield* server.invalidate;
    yield* client.closed;
    // The endpoint's socket, and with it the paid session, is released.
    yield* endpoint.closed;
    expect(yield* client.unread).toEqual([]);
  }).pipe(Effect.scoped),
);

it.each([
  {
    name: "a request without a ticket",
    authentication: Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({})),
    status: 401,
  },
  {
    name: "a ticket that is not valid",
    authentication: Effect.fail(new EnvironmentAuth.ServerAuthInvalidCredentialError({})),
    status: 401,
  },
  {
    name: "a session that may only read",
    authentication: Effect.succeed(authenticated([AuthOrchestrationReadScope])),
    status: 403,
  },
])("answers $name with $status and starts no session", async ({ authentication, status }) => {
  let served = 0;
  const { handler, dispose } = HttpRouter.toWebHandler(
    VoiceAgentSessions.routeLayer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.mock(VoiceAgentSessions.VoiceAgentSessions)({
            serve: () =>
              Effect.sync(() => {
                served++;
              }),
          }),
          Layer.mock(EnvironmentAuth.EnvironmentAuth)({
            authenticateWebSocketUpgrade: () => authentication,
          }),
          Layer.mock(SessionStore.SessionStore)({
            cookieName: "test",
            legacyCookieName: undefined,
            awaitInvalidation: () => Effect.never,
          }),
        ),
      ),
    ),
  );
  try {
    const response = await handler(
      new Request(`http://t3.test${VOICE_AGENT_STREAM_PATH}`, {
        headers: { upgrade: "websocket" },
      }),
    );
    expect(response.status).toBe(status);
    expect(served).toBe(0);
  } finally {
    await dispose();
  }
});
