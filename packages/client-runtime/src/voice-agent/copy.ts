import {
  VOICE_AGENT_IDLE_TIMEOUT_MS,
  VOICE_AGENT_MAX_SESSION_MS,
  type VoiceAgentActivityKind,
} from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

const ACTIVITY_LABELS: Record<VoiceAgentActivityKind | "other", string> = {
  "send-request": msg("Sending your request to the agent"),
  "read-reply": msg("Checking on the agent"),
  "stop-agent": msg("Stopping the agent"),
  "read-question": msg("Reading the agent's question"),
  "answer-question": msg("Sending your answer"),
  "start-thread": msg("Starting a new thread"),
  "list-threads": msg("Looking through your threads"),
  "switch-thread": msg("Switching threads"),
  other: msg("Working", { $context: "status while the voice agent runs a tool" }),
};

export function voiceAgentActivityLabel(
  kind: VoiceAgentActivityKind | "other",
  resolve: MFunctionType = mFallback,
): string {
  return resolve(ACTIVITY_LABELS[kind]);
}

/** Copy for failures only this device can see. Server failures bring their own message. */
export const VOICE_AGENT_LOCAL_ERROR_COPY = {
  "microphone-blocked": msg(
    "Microphone access is required for voice mode. Allow access in your browser or system settings and try again.",
  ),
  "microphone-busy": msg("Finish or cancel dictation before you start voice mode."),
  "microphone-failed": msg("Microphone processing failed."),
  "microphone-disconnected": msg("The microphone disconnected."),
  "audio-unavailable": msg("This browser could not start audio playback for voice mode."),
  "consent-required": msg("Allow voice mode to send microphone audio to this endpoint first."),
  "consent-revoked": msg(
    "Voice mode stopped because it is no longer allowed to send microphone audio to this endpoint.",
  ),
  "connect-failed": msg("Could not connect voice mode to this environment."),
  "start-timeout": msg("Voice mode took too long to start. Try again."),
  "connection-lost": msg("The voice connection was lost. Start voice mode again."),
} as const;

export const VOICE_AGENT_UNKNOWN_END_COPY = msg("Voice mode ended unexpectedly.");

export function voiceAgentEndedMessage(
  reason: "idle" | "time-limit",
  resolve: MFunctionType = mFallback,
): string {
  return reason === "idle"
    ? resolve(
        msg("Voice mode ended after {minutes} minutes without activity.", {
          minutes: VOICE_AGENT_IDLE_TIMEOUT_MS / 60_000,
        }),
      )
    : resolve(
        msg("Voice mode reached its {minutes} minute limit. Start it again to continue.", {
          minutes: VOICE_AGENT_MAX_SESSION_MS / 60_000,
        }),
      );
}
