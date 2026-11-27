import { voiceAgentIsActive } from "@t3tools/client-runtime/voice-agent";
import type {
  EnvironmentId,
  ProjectId,
  ThreadId,
  VoiceAgentLaunchSettings,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { msg, useMessages } from "gt-react";
import { useState, useSyncExternalStore } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { m } from "../i18n/messages";
import { useEnvironment } from "../state/environments";
import { textGeneratorDisplayName } from "../textGenerators";
import {
  useVoiceAgentAvailability,
  voiceAgentSession,
  type VoiceAgentTarget,
} from "./voiceAgentSession";
import { chooseVoiceAgentDestination } from "./voiceConsent";
import {
  resolveVoiceModeEntry,
  voiceEndpointHost,
  VOICE_AGENT_SETTINGS_ANCHOR,
  VOICE_MODE_BLOCK_COPY,
  type ComposerVoiceModeInput,
  type VoiceModeEntry,
} from "./voiceMode.logic";

type VoiceModeActivity = "off" | "connecting" | "on";

/** A string, so the composer re-renders when a session starts, goes live or stops, not on turn-taking. */
function useVoiceModeActivity(): VoiceModeActivity {
  return useSyncExternalStore(voiceAgentSession.subscribe, () => {
    const { state } = voiceAgentSession.getSnapshot();
    return !voiceAgentIsActive(state) ? "off" : state.phase === "connecting" ? "connecting" : "on";
  });
}

/** The one way to start voice mode for a composer: its button, the shortcut and the palette all call `toggle`. */
export function useComposerVoiceMode(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  /** The server thread, or the draft's reserved thread id. */
  readonly threadId: ThreadId | null;
  readonly composer: ComposerVoiceModeInput | null;
  /** The composer's current model and modes: a thread the voice agent creates uses them. */
  readonly launch: VoiceAgentLaunchSettings;
}): {
  readonly entry: VoiceModeEntry;
  /** `connecting` only while this app's session is starting. */
  readonly activity: VoiceModeActivity;
  /** False where there is no entry point, so a keybinding lets its key through. */
  readonly toggle: () => boolean;
  /** Non-null while the consent dialog is open. */
  readonly consent: {
    readonly environmentLabel: string;
    readonly endpointLabel: string;
    readonly host: string;
    readonly allow: () => void;
    readonly cancel: () => void;
  } | null;
} {
  const navigate = useNavigate();
  const messages = useMessages();
  const availability = useVoiceAgentAvailability(
    input.composer === null ? null : input.environmentId,
    input.projectId,
  );
  const activity = useVoiceModeActivity();
  const environmentLabel = useEnvironment(input.environmentId)?.label ?? input.environmentId;
  const [consentRequested, setConsentRequested] = useState(false);
  const entry = resolveVoiceModeEntry({
    composer: input.composer,
    active: activity !== "off",
    availability,
  });

  const target = (): VoiceAgentTarget | null => {
    const { composer, projectId, threadId } = input;
    if (composer === null || projectId === null) return null;
    return {
      environmentId: input.environmentId,
      projectId,
      threadId: composer === "thread" ? threadId : null,
      // Client only: where the banner shows until the session is bound to a thread.
      draftThreadId: composer === "draft" ? threadId : null,
    };
  };
  // Called straight from the gesture, with nothing awaited before it: browsers only start audio
  // output inside the gesture that asked for it.
  const start = () => {
    const next = target();
    if (next !== null) void voiceAgentSession.start(next, input.launch);
  };
  const toggle = () => {
    switch (entry.kind) {
      case "hidden":
        return false;
      case "active":
        voiceAgentSession.end();
        return true;
      case "ready":
        start();
        return true;
      case "consent":
        setConsentRequested(true);
        return true;
      case "blocked":
        if (entry.opensSettings) {
          void navigate({
            to: "/settings/voice",
            search: { machine: input.environmentId },
            hash: VOICE_AGENT_SETTINGS_ANCHOR,
          });
        } else {
          // The tooltip is out of reach from the keyboard, the palette and touch.
          toastManager.add(
            stackedThreadToast({
              type: "info",
              title: m(msg("Voice mode cannot start")),
              description: m(VOICE_MODE_BLOCK_COPY[entry.reason]),
            }),
          );
        }
        return true;
    }
  };

  // When the entry stops asking for consent the dialog closes by itself, and the request is
  // dropped so the dialog cannot come back later without a new gesture.
  if (consentRequested && entry.kind !== "consent") setConsentRequested(false);
  const consent =
    consentRequested && entry.kind === "consent"
      ? {
          environmentLabel,
          endpointLabel: textGeneratorDisplayName(entry.endpoint, messages),
          host: voiceEndpointHost(entry.destination.baseUrl),
          allow: () => {
            // Grant first: start reads it synchronously. Both stay inside this click.
            chooseVoiceAgentDestination(entry.destination);
            setConsentRequested(false);
            start();
          },
          cancel: () => setConsentRequested(false),
        }
      : null;

  return { entry, activity, toggle, consent };
}
