import type { VoiceAgentState } from "@t3tools/client-runtime/voice-agent";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type TextGeneratorConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { VoiceAgentAvailability, VoiceAgentSessionSnapshot } from "./voiceAgentSession";
import {
  resolveVoiceModeEntry,
  voiceModeAnnouncement,
  voiceModeFollowTarget,
  voiceModePresentation,
  voiceModeThreadRef,
} from "./voiceMode.logic";

const environmentId = EnvironmentId.make("environment-1");
const otherEnvironmentId = EnvironmentId.make("environment-2");
const projectId = ProjectId.make("project-1");
const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const draftThread = ThreadId.make("draft-thread");

const IDLE: VoiceAgentSessionSnapshot = {
  state: {
    phase: "idle",
    threadId: null,
    activity: null,
    warning: null,
    message: null,
    errorAction: null,
  },
  target: null,
};

function snapshot(
  state: Partial<VoiceAgentState>,
  startedOn: { readonly threadId?: ThreadId; readonly draftThreadId?: ThreadId } = {
    threadId: threadA,
  },
): VoiceAgentSessionSnapshot {
  return {
    state: { ...IDLE.state, ...state },
    target: {
      environmentId,
      projectId,
      threadId: startedOn.threadId ?? null,
      draftThreadId: startedOn.draftThreadId ?? null,
    },
  };
}

const onDraft = { draftThreadId: draftThread };
const ref = (threadId: ThreadId, environment = environmentId) => ({
  environmentId: environment,
  threadId,
});

const endpoint: TextGeneratorConfig = {
  kind: "openaiCompatible",
  baseUrl: "https://gateway.example/v1",
  enabled: true,
  voiceModel: "realtime-model",
} as TextGeneratorConfig;
const destination = {
  environmentId,
  endpointId: ProviderInstanceId.make("gateway"),
  baseUrl: endpoint.baseUrl,
};
const resolution = {
  available: true,
  endpointId: destination.endpointId,
  endpoint,
  model: "realtime-model",
  source: "only-endpoint",
} as const;
const READY: VoiceAgentAvailability = { status: "ready", destination, resolution };
const unavailable = (
  reason: Extract<VoiceAgentAvailability, { status: "unavailable" }>["reason"],
): VoiceAgentAvailability => ({ status: "unavailable", reason });

describe("resolveVoiceModeEntry", () => {
  it.each([
    ["no composer", null, false, READY, { kind: "hidden" }],
    ["no composer, session running", null, true, READY, { kind: "hidden" }],
    ["running session, entry point gone", "thread", true, { status: "hidden" }, { kind: "active" }],
    ["hidden availability", "thread", false, { status: "hidden" }, { kind: "hidden" }],
    ["ready thread", "thread", false, READY, { kind: "ready" }],
    ["ready draft", "draft", false, READY, { kind: "ready" }],
    [
      "first use",
      "draft",
      false,
      { status: "needs-consent", destination, resolution },
      { kind: "consent", destination, endpoint },
    ],
    [
      "dictation holds the microphone",
      "thread",
      false,
      { status: "microphone-busy" },
      { kind: "blocked", reason: "microphone-busy", opensSettings: false },
    ],
    ...(
      [
        ["no-endpoint", true],
        ["choose-endpoint", true],
        ["endpoint-missing", true],
        ["endpoint-disabled", true],
        ["no-voice-model", true],
        ["offline", false],
        ["unsupported-browser", false],
      ] as const
    ).map(
      ([reason, opensSettings]) =>
        [
          reason,
          "thread",
          false,
          unavailable(reason),
          { kind: "blocked", reason, opensSettings },
        ] as const,
    ),
  ] as const)("%s", (_name, composer, active, availability, expected) => {
    expect(resolveVoiceModeEntry({ composer, active, availability })).toEqual(expected);
  });
});

describe("where a session shows", () => {
  it.each([
    ["no session", IDLE, ref(threadA), null, "hidden"],
    [
      "bound thread",
      snapshot({ phase: "listening", threadId: threadA }),
      ref(threadA),
      threadA,
      "live",
    ],
    [
      "still connecting on its thread",
      snapshot({ phase: "connecting" }),
      ref(threadA),
      threadA,
      "live",
    ],
    [
      "started on a draft",
      snapshot({ phase: "listening" }, onDraft),
      ref(draftThread),
      draftThread,
      "live",
    ],
    [
      "draft session after its first request",
      snapshot({ phase: "working", threadId: threadB }, onDraft),
      ref(draftThread),
      threadB,
      "hidden",
    ],
    [
      "another thread",
      snapshot({ phase: "listening", threadId: threadA }),
      ref(threadB),
      threadA,
      "hidden",
    ],
    [
      "same thread id on another environment",
      snapshot({ phase: "listening", threadId: threadA }),
      ref(threadA, otherEnvironmentId),
      threadA,
      "hidden",
    ],
    [
      "no thread on screen",
      snapshot({ phase: "listening", threadId: threadA }),
      null,
      threadA,
      "hidden",
    ],
    ["ended", snapshot({ phase: "ended", threadId: threadA }), ref(threadA), threadA, "ended"],
    [
      "failed after a switch, on the thread it was last on",
      snapshot({ phase: "error", threadId: threadB }),
      ref(threadB),
      threadB,
      "error",
    ],
    [
      "failed after a switch, on the thread it started on",
      snapshot({ phase: "error", threadId: threadB }),
      ref(threadA),
      threadB,
      "hidden",
    ],
  ] as const)("%s", (_name, session, shown, sessionThread, presentation) => {
    expect(voiceModeThreadRef(session)).toEqual(sessionThread && ref(sessionThread));
    expect(voiceModePresentation(session, shown)).toBe(presentation);
  });
});

describe("voiceModeFollowTarget", () => {
  const onA = snapshot({ phase: "listening", threadId: threadA });
  const onB = snapshot({ phase: "working", threadId: threadB });

  it.each([
    ["ready on the thread it started on", snapshot({ phase: "connecting" }), onA, threadA, null],
    [
      "first request from a draft",
      snapshot({ phase: "working" }, onDraft),
      snapshot({ phase: "working", threadId: threadB }, onDraft),
      draftThread,
      threadB,
    ],
    ["switch while looking at the thread", onA, onB, threadA, threadB],
    ["switch while looking at another thread", onA, onB, draftThread, null],
    ["switch while no thread is on screen", onA, onB, null, null],
    ["failure after a switch", onB, snapshot({ phase: "error", threadId: threadB }), threadB, null],
    [
      "stays put once it stopped",
      onA,
      snapshot({ phase: "ended", threadId: threadB }),
      threadA,
      null,
    ],
    [
      "a new start after a failure elsewhere",
      snapshot({ phase: "error", threadId: threadB }),
      snapshot({ phase: "connecting" }),
      threadB,
      null,
    ],
  ] as const)("%s", (_name, previous, next, shown, expected) => {
    expect(voiceModeFollowTarget(previous, next, shown && ref(shown))).toEqual(
      expected && ref(expected),
    );
  });
});

describe("voiceModeAnnouncement", () => {
  const connecting = snapshot({ phase: "connecting" });
  const listening = snapshot({ phase: "listening", threadId: threadA });

  it.each([
    ["start", IDLE, connecting, "Starting voice mode"],
    [
      "start again after a failure",
      snapshot({ phase: "error", message: "Lost." }),
      connecting,
      "Starting voice mode",
    ],
    ["live", connecting, listening, "Voice mode is on"],
    ["ended by the user", listening, IDLE, "Voice mode ended"],
    ["start cancelled", connecting, IDLE, "Voice mode ended"],
    [
      "ended by the server",
      listening,
      snapshot({ phase: "ended", threadId: threadA, message: "Voice mode ended after 5 minutes." }),
      "Voice mode ended after 5 minutes.",
    ],
    [
      "failed",
      connecting,
      snapshot({ phase: "error", message: "Could not connect." }),
      "Could not connect.",
    ],
    ["stopped without a message", listening, snapshot({ phase: "ended" }), "Voice mode ended"],
    [
      "moved",
      listening,
      snapshot({ phase: "working", threadId: threadB }),
      "Voice mode moved to another thread",
    ],
    [
      "a reply failed",
      listening,
      snapshot({ phase: "listening", threadId: threadA, warning: "No reply." }),
      "No reply.",
    ],
    [
      "the same warning again",
      snapshot({ phase: "listening", threadId: threadA, warning: "No reply." }),
      snapshot({ phase: "agentSpeaking", threadId: threadA, warning: "No reply." }),
      null,
    ],
    ["notice dismissed", snapshot({ phase: "error", message: "Lost." }), IDLE, null],
  ] as const)("%s", (_name, previous, next, expected) => {
    expect(voiceModeAnnouncement(previous, next)).toBe(expected);
  });

  it("stays silent while people and agents take turns", () => {
    const turns = (
      ["listening", "userSpeaking", "agentSpeaking", "working", "listening"] as const
    ).map((phase) =>
      snapshot({
        phase,
        threadId: threadA,
        activity: phase === "working" ? "send-request" : null,
      }),
    );
    expect(turns.slice(1).map((next, index) => voiceModeAnnouncement(turns[index]!, next))).toEqual(
      [null, null, null, null],
    );
  });
});
