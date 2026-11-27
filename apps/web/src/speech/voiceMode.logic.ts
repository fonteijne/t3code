import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { sideThreadKindOf } from "@t3tools/client-runtime/side-thread";
import {
  voiceAgentIsActive,
  type VoiceAgentFailureCode,
} from "@t3tools/client-runtime/voice-agent";
import type { ScopedThreadRef, TextGeneratorConfig } from "@t3tools/contracts";
import type { VoiceAgentUnavailableReason } from "@t3tools/shared/voiceAgent";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../i18n/messages";
import type { VoiceAgentDestination } from "./voiceConsent";
import type { VoiceAgentAvailability, VoiceAgentSessionSnapshot } from "./voiceAgentSession";

/** The Voice agent section of Settings > Voice: its anchor and its search item id. */
export const VOICE_AGENT_SETTINGS_ANCHOR = "voice-agent";
/** The Labs row that turns voice mode on: its anchor and its search item id. */
export const VOICE_MODE_LABS_ANCHOR = "voice-mode-beta";

/** What the composer the entry point belongs to shows: a started thread or a draft. */
export type ComposerVoiceModeInput = "thread" | "draft";

export type VoiceModeBlockReason =
  | Exclude<VoiceAgentUnavailableReason, "not-enabled">
  | "offline"
  | "unsupported-browser"
  | "microphone-busy";

export type VoiceModeEntry =
  | { readonly kind: "hidden" }
  /** A session is running, here or on another thread. The control ends it. */
  | { readonly kind: "active" }
  | { readonly kind: "ready" }
  | {
      readonly kind: "consent";
      readonly destination: VoiceAgentDestination;
      readonly endpoint: TextGeneratorConfig;
    }
  | {
      readonly kind: "blocked";
      readonly reason: VoiceModeBlockReason;
      /** The fix is in Settings, so the control opens it instead of doing nothing. */
      readonly opensSettings: boolean;
    };

export const VOICE_MODE_BLOCK_COPY: Readonly<Record<VoiceModeBlockReason, string>> = {
  "no-endpoint": msg("Add a voice model in Settings to use voice mode."),
  "no-voice-model": msg(
    "The endpoint chosen for voice mode has no voice model, so add one in Settings.",
  ),
  "choose-endpoint": msg("Choose in Settings which endpoint voice mode talks to."),
  "endpoint-missing": msg(
    "The endpoint chosen for voice mode no longer exists, so choose another one in Settings.",
  ),
  "endpoint-disabled": msg(
    "The endpoint chosen for voice mode is turned off, so turn it on or choose another one in Settings.",
  ),
  offline: msg("Voice mode needs a connection to this environment."),
  "unsupported-browser": msg(
    "Voice mode needs microphone access, which this browser only allows over HTTPS or in the desktop app.",
  ),
  "microphone-busy": msg("Finish or cancel dictation before you start voice mode."),
};

export function resolveVoiceModeEntry(input: {
  readonly composer: ComposerVoiceModeInput | null;
  readonly active: boolean;
  readonly availability: VoiceAgentAvailability;
}): VoiceModeEntry {
  const { availability } = input;
  if (input.composer === null) return { kind: "hidden" };
  // Before availability: a running session keeps its way out even if the Labs flag or the
  // capability changed underneath it.
  if (input.active) return { kind: "active" };
  switch (availability.status) {
    case "hidden":
      return { kind: "hidden" };
    case "unavailable":
      return {
        kind: "blocked",
        reason: availability.reason,
        opensSettings:
          availability.reason !== "offline" && availability.reason !== "unsupported-browser",
      };
    case "microphone-busy":
      return { kind: "blocked", reason: "microphone-busy", opensSettings: false };
    case "needs-consent":
      return {
        kind: "consent",
        destination: availability.destination,
        endpoint: availability.resolution.endpoint,
      };
    case "ready":
      return { kind: "ready" };
  }
}

/** The thread a session is on: the bound one, else the thread or draft it was started from. */
export function voiceModeThreadRef(snapshot: VoiceAgentSessionSnapshot): ScopedThreadRef | null {
  const { state, target } = snapshot;
  if (target === null) return null;
  const threadId = state.threadId ?? target.threadId ?? target.draftThreadId;
  return threadId === null ? null : scopeThreadRef(target.environmentId, threadId);
}

/**
 * Whether voice mode can be on this thread: an ordinary thread, not a side chat or a subagent.
 * The server binds a session only to such threads, so the global indicator stands down only where
 * the banner really is.
 */
export function threadTakesVoiceMode(thread: Parameters<typeof sideThreadKindOf>[0]): boolean {
  return sideThreadKindOf(thread) === null;
}

export type VoiceModePresentation = "hidden" | "live" | "ended" | "error";

function sameThreadRef(left: ScopedThreadRef | null, right: ScopedThreadRef | null): boolean {
  return (
    left !== null &&
    right !== null &&
    left.environmentId === right.environmentId &&
    left.threadId === right.threadId
  );
}

/** What the composer of `shown` renders for the session. */
export function voiceModePresentation(
  snapshot: VoiceAgentSessionSnapshot,
  shown: ScopedThreadRef | null,
): VoiceModePresentation {
  if (!sameThreadRef(voiceModeThreadRef(snapshot), shown)) return "hidden";
  switch (snapshot.state.phase) {
    case "idle":
      return "hidden";
    case "ended":
      return "ended";
    case "error":
      return "error";
    default:
      return "live";
  }
}

/** Where to take the route when the session moved to another thread, or null to stay. */
export function voiceModeFollowTarget(
  previous: VoiceAgentSessionSnapshot,
  next: VoiceAgentSessionSnapshot,
  /** The thread or draft on screen. Null under Settings or Usage and on pages without a thread. */
  shown: ScopedThreadRef | null,
): ScopedThreadRef | null {
  if (!voiceAgentIsActive(next.state) || next.state.threadId === null) return null;
  const from = voiceModeThreadRef(previous);
  const to = voiceModeThreadRef(next);
  if (from === null || to === null || sameThreadRef(from, to)) return null;
  return sameThreadRef(shown, from) ? to : null;
}

/** The draft a session just left for the thread its first request created, or null. */
export function voiceModeLeftDraft(
  previous: VoiceAgentSessionSnapshot,
  next: VoiceAgentSessionSnapshot,
): ScopedThreadRef | null {
  const draftThreadId = previous.target?.draftThreadId ?? null;
  if (draftThreadId === null || previous.target !== next.target) return null;
  if (previous.state.threadId !== null || next.state.threadId === null) return null;
  return scopeThreadRef(previous.target!.environmentId, draftThreadId);
}

/**
 * The draft an active session still sits on unbound, or null. The server binds a thread only at
 * `start` and through the voice agent's own tools, so once that draft is sent by typing or
 * removed, the session is attached to nothing the user can see.
 */
export function voiceModeUnboundDraft(snapshot: VoiceAgentSessionSnapshot): ScopedThreadRef | null {
  const { state, target } = snapshot;
  if (target === null || target.draftThreadId === null) return null;
  if (!voiceAgentIsActive(state) || state.threadId !== null) return null;
  return scopeThreadRef(target.environmentId, target.draftThreadId);
}

/**
 * What a screen reader hears for a change, or null. Never a turn-taking change: the voice agent is
 * already audible, and a screen reader speaking over it would reach the open microphone.
 */
export function voiceModeAnnouncement(
  previous: VoiceAgentSessionSnapshot,
  next: VoiceAgentSessionSnapshot,
  resolve: MessageResolver = m,
): string | null {
  const before = previous.state;
  const after = next.state;
  const wasActive = voiceAgentIsActive(before);
  const isActive = voiceAgentIsActive(after);
  if ((after.phase === "error" || after.phase === "ended") && after.phase !== before.phase) {
    return after.message ?? resolve(msg("Voice mode ended"));
  }
  if (!wasActive && after.phase === "connecting") return resolve(msg("Starting voice mode"));
  if (before.phase === "connecting" && isActive && after.phase !== "connecting") {
    return resolve(msg("Voice mode is on"));
  }
  if (wasActive && after.phase === "idle") return resolve(msg("Voice mode ended"));
  if (
    wasActive &&
    isActive &&
    !sameThreadRef(voiceModeThreadRef(previous), voiceModeThreadRef(next))
  ) {
    return resolve(msg("Voice mode moved to another thread"));
  }
  if (after.warning !== null && after.warning !== before.warning) return after.warning;
  return null;
}

/** The Settings page that fixes an error, or null when Settings cannot. */
export function voiceModeErrorSettingsTarget(
  code: VoiceAgentFailureCode | undefined,
):
  | { readonly to: "/settings/labs"; readonly hash: typeof VOICE_MODE_LABS_ANCHOR }
  | { readonly to: "/settings/voice"; readonly hash: typeof VOICE_AGENT_SETTINGS_ANCHOR }
  | { readonly to: "/settings/providers"; readonly hash: "text-generators" }
  | null {
  switch (code) {
    case "not-enabled":
      return { to: "/settings/labs", hash: VOICE_MODE_LABS_ANCHOR };
    case "not-configured":
      return { to: "/settings/voice", hash: VOICE_AGENT_SETTINGS_ANCHOR };
    case "endpoint-refused":
    case "endpoint-unreadable-key":
      return { to: "/settings/providers", hash: "text-generators" };
    default:
      return null;
  }
}

/** The address shown to the user for an endpoint: the host of its base URL. */
export function voiceEndpointHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
