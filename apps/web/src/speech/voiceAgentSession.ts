import {
  getEnvironmentVoiceAgentStreamUrl,
  VoiceAgentController,
  voiceAgentIsActive,
  type VoiceAgentCaption,
  type VoiceAgentState,
} from "@t3tools/client-runtime/voice-agent";
import { subscribeVoiceMicrophone, voiceMicrophoneHeld } from "@t3tools/client-runtime/voice-input";
import {
  AuthOrchestrationOperateScope,
  VoiceAgentError,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  resolveVoiceAgent,
  type VoiceAgentResolution,
  type VoiceAgentUnavailableReason,
} from "@t3tools/shared/voiceAgent";
import * as Option from "effect/Option";
import { useSyncExternalStore } from "react";

import { m } from "../i18n/messages";
import { readEnvironment, useEnvironment } from "../state/environments";
import {
  readPreparedConnection,
  useEnvironmentScope,
  usePreparedConnection,
} from "../state/session";
import { chooseRecordingMicrophone } from "./browserMicrophones";
import { createBrowserPcmPlayer } from "./browserPcmPlayer";
import { createBrowserVoiceAgentCapture } from "./browserVoiceAgentCapture";
import { runEnvironmentSpeech } from "./runEnvironmentSpeech";
import {
  bindVoiceAgentGrant,
  useVoiceAgentGrant,
  voiceAgentGrantCovers,
  type VoiceAgentDestination,
} from "./voiceConsent";

export type VoiceAgentTarget = {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** The thread to talk to. Null starts unbound: the first request creates a thread. */
  readonly threadId: ThreadId | null;
  /**
   * The draft's reserved thread id when the session was started on a draft. Never sent to the
   * server: it only tells the UI where to show the session until a thread is bound.
   */
  readonly draftThreadId: ThreadId | null;
};

export type VoiceAgentSessionSnapshot = {
  readonly state: VoiceAgentState;
  /** Where the session was started. Kept through `ended` and `error` so "Start again" can reuse it. */
  readonly target: VoiceAgentTarget | null;
};

export type VoiceAgentLevels = { readonly input: number; readonly output: number };

const IDLE_VOICE_AGENT_STATE: VoiceAgentState = {
  phase: "idle",
  threadId: null,
  activity: null,
  warning: null,
  message: null,
  errorAction: null,
};
const IDLE_SNAPSHOT: VoiceAgentSessionSnapshot = { state: IDLE_VOICE_AGENT_STATE, target: null };
const NO_CAPTIONS: ReadonlyArray<VoiceAgentCaption> = [];

/**
 * The app's one voice mode session. No component owns it, so it survives every route change until
 * it is ended or the page unloads, and it touches no browser API before `start`.
 */
class VoiceAgentSession {
  private readonly controller: VoiceAgentController;
  private readonly listeners = new Set<() => void>();
  private readonly captionListeners = new Set<() => void>();
  private readonly levelListeners = new Set<() => void>();
  private snapshot = IDLE_SNAPSHOT;
  private captions = NO_CAPTIONS;
  private levels: VoiceAgentLevels = { input: 0, output: 0 };
  private target: VoiceAgentTarget | null = null;

  constructor() {
    this.controller = new VoiceAgentController({
      resolve: m,
      capture: createBrowserVoiceAgentCapture({
        getMicrophoneId: chooseRecordingMicrophone,
        onLevel: (input) => this.publishLevels({ ...this.levels, input }),
      }),
      playback: createBrowserPcmPlayer({
        onLevel: (output) => this.publishLevels({ ...this.levels, output }),
      }),
      onStateChange: (state) =>
        this.publish({ state, target: state.phase === "idle" ? null : this.target }),
      onCaptionsChange: (captions) => this.publishCaptions(captions),
    });
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): VoiceAgentSessionSnapshot => this.snapshot;

  readonly subscribeCaptions = (listener: () => void): (() => void) => {
    this.captionListeners.add(listener);
    return () => this.captionListeners.delete(listener);
  };

  readonly getCaptions = (): ReadonlyArray<VoiceAgentCaption> => this.captions;

  readonly subscribeLevels = (listener: () => void): (() => void) => {
    this.levelListeners.add(listener);
    return () => this.levelListeners.delete(listener);
  };

  readonly getLevels = (): VoiceAgentLevels => this.levels;

  /**
   * Call directly in the gesture's handler, with nothing awaited first: the browser only lets
   * audio start inside the gesture, and everything up to the controller call here is synchronous.
   * Does nothing while a session is active.
   */
  start(target: VoiceAgentTarget): Promise<void> {
    if (voiceAgentIsActive(this.snapshot.state)) return Promise.resolve();
    const prepared = readPreparedConnection(target.environmentId);
    const settings = readEnvironment(target.environmentId)?.serverConfig?.settings;
    const resolution = settings ? resolveVoiceAgent(settings, target.projectId) : null;
    this.target = target;
    if (!prepared || !resolution?.available) {
      // Entry points are disabled in this case; this only keeps a stale click honest.
      this.controller.dismiss();
      this.publish({
        state: {
          ...IDLE_VOICE_AGENT_STATE,
          phase: "error",
          message: new VoiceAgentError({ reason: "not-configured" }).message,
          errorCode: "not-configured",
          errorAction: "settings",
        },
        target,
      });
      return Promise.resolve();
    }
    const destination: VoiceAgentDestination = {
      environmentId: target.environmentId,
      endpointId: resolution.endpointId,
      baseUrl: resolution.endpoint.baseUrl,
    };
    return this.controller.start({
      projectId: target.projectId,
      ...(target.threadId === null ? {} : { threadId: target.threadId }),
      // The same two values consent was bound to. The server refuses any other destination.
      endpointId: destination.endpointId,
      baseUrl: destination.baseUrl,
      // Always false without a grant for this destination, which the controller reports.
      hasConsent: bindVoiceAgentGrant(destination),
      getStreamUrl: ({ signal }) =>
        runEnvironmentSpeech(getEnvironmentVoiceAgentStreamUrl(prepared), { signal }),
    });
  }

  /** Ends the session or cancels a start. Lands in idle. */
  end(): void {
    this.controller.end();
    this.toIdle();
  }

  /** Leaves `ended` or `error` for idle and forgets the target. */
  dismiss(): void {
    const { phase } = this.snapshot.state;
    if (phase !== "ended" && phase !== "error") return;
    this.controller.dismiss();
    this.toIdle();
  }

  /** Covers a failure published here, which the controller never saw. */
  private toIdle(): void {
    this.target = null;
    if (this.snapshot !== IDLE_SNAPSHOT) this.publish(IDLE_SNAPSHOT);
  }

  private publish(snapshot: VoiceAgentSessionSnapshot): void {
    this.snapshot =
      snapshot.state.phase === "idle" && snapshot.target === null ? IDLE_SNAPSHOT : snapshot;
    for (const listener of this.listeners) listener();
  }

  private publishCaptions(captions: ReadonlyArray<VoiceAgentCaption>): void {
    this.captions = captions;
    for (const listener of this.captionListeners) listener();
  }

  private publishLevels(levels: VoiceAgentLevels): void {
    if (levels.input === this.levels.input && levels.output === this.levels.output) return;
    this.levels = levels;
    for (const listener of this.levelListeners) listener();
  }
}

export const voiceAgentSession = new VoiceAgentSession();

export function useVoiceAgentSnapshot(): VoiceAgentSessionSnapshot {
  return useSyncExternalStore(voiceAgentSession.subscribe, voiceAgentSession.getSnapshot);
}

/** Subscribe only where captions are drawn: they change many times a second. */
export function useVoiceAgentCaptions(): ReadonlyArray<VoiceAgentCaption> {
  return useSyncExternalStore(voiceAgentSession.subscribeCaptions, voiceAgentSession.getCaptions);
}

/** Subscribe only in the meter: about 20 updates a second per direction while there is sound. */
export function useVoiceAgentLevels(): VoiceAgentLevels {
  return useSyncExternalStore(voiceAgentSession.subscribeLevels, voiceAgentSession.getLevels);
}

/** A boolean, so a phase change inside an active session re-renders none of dictation's editors. */
export function useVoiceAgentActive(): boolean {
  return useSyncExternalStore(voiceAgentSession.subscribe, () =>
    voiceAgentIsActive(voiceAgentSession.getSnapshot().state),
  );
}

export type VoiceAgentAvailability =
  /** No entry point: old server, Labs flag off, no operate scope, or no project in view. */
  | { readonly status: "hidden" }
  /** Cannot start, with the reason. */
  | {
      readonly status: "unavailable";
      readonly reason:
        | Exclude<VoiceAgentUnavailableReason, "not-enabled">
        | "offline"
        | "unsupported-browser";
    }
  /** Dictation holds the microphone. Show disabled. */
  | { readonly status: "microphone-busy" }
  /** Ask first, then `chooseVoiceAgentDestination(destination)` and `start` in the same handler. */
  | {
      readonly status: "needs-consent";
      readonly destination: VoiceAgentDestination;
      readonly resolution: Extract<VoiceAgentResolution, { available: true }>;
    }
  | {
      readonly status: "ready";
      readonly destination: VoiceAgentDestination;
      readonly resolution: Extract<VoiceAgentResolution, { available: true }>;
    };

const HIDDEN: VoiceAgentAvailability = { status: "hidden" };

/**
 * Whether voice mode can start for a project, decided from the same settings `start` reads.
 * Callers without an environment in view pass null, so every hook here runs before any decision.
 */
export function useVoiceAgentAvailability(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): VoiceAgentAvailability {
  const environment = useEnvironment(environmentId);
  const operate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const prepared = usePreparedConnection(environmentId);
  const microphoneHeld = useSyncExternalStore(subscribeVoiceMicrophone, voiceMicrophoneHeld);
  const active = useVoiceAgentActive();
  const grant = useVoiceAgentGrant();

  if (environmentId === null || projectId === null) return HIDDEN;
  const config = environment?.serverConfig;
  if (config?.environment.capabilities.voiceMode !== true || !operate) return HIDDEN;
  const resolution = resolveVoiceAgent(config.settings, projectId);
  if (!resolution.available)
    return resolution.reason === "not-enabled"
      ? HIDDEN
      : { status: "unavailable", reason: resolution.reason };
  if (Option.isNone(prepared)) return { status: "unavailable", reason: "offline" };
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices?.getUserMedia ||
    typeof AudioWorkletNode === "undefined"
  )
    return { status: "unavailable", reason: "unsupported-browser" };
  if (microphoneHeld && !active) return { status: "microphone-busy" };
  const destination: VoiceAgentDestination = {
    environmentId,
    endpointId: resolution.endpointId,
    baseUrl: resolution.endpoint.baseUrl,
  };
  return {
    status: voiceAgentGrantCovers(grant, destination) ? "ready" : "needs-consent",
    destination,
    resolution,
  };
}
