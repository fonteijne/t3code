import { useAtomValue } from "@effect/atom-react";
import { voiceAgentActivityLabel } from "@t3tools/client-runtime/voice-agent";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { msg, useGT, useMessages } from "gt-react";
import { AudioLinesIcon } from "lucide-react";
import { useSyncExternalStore } from "react";

import { m, type MessageResolver } from "../../i18n/messages";
import { shortcutLabelForCommand } from "../../keybindings";
import {
  useVoiceAgentCaptions,
  useVoiceAgentLevels,
  useVoiceAgentSnapshot,
  voiceAgentSession,
} from "../../speech/voiceAgentSession";
import {
  voiceModeErrorSettingsTarget,
  voiceModePresentation,
  type VoiceModePresentation,
} from "../../speech/voiceMode.logic";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Button } from "../ui/button";
import { ComposerBanner } from "./ComposerBanner";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { ShortcutTooltip } from "./ComposerSpeechButton";
import { VoiceWaveform } from "./VoiceInputPill";

export const VOICE_MODE_BANNER_ID = "voice-mode";

/** What this thread's composer shows for the session. A string, so the chat view re-renders only when it changes. */
export function useVoiceModePresentation(shown: ScopedThreadRef | null): VoiceModePresentation {
  const environmentId = shown?.environmentId ?? null;
  const threadId = shown?.threadId ?? null;
  return useSyncExternalStore(voiceAgentSession.subscribe, () =>
    voiceModePresentation(
      voiceAgentSession.getSnapshot(),
      environmentId === null || threadId === null ? null : { environmentId, threadId },
    ),
  );
}

const STATUS_COPY = {
  connecting: msg("Connecting voice mode…"),
  listening: msg("Listening", {
    $context: "voice mode status, waiting for the user to speak",
  }),
  userSpeaking: msg("You are speaking"),
  agentSpeaking: msg("Voice agent is speaking"),
};

/** One line for who has the floor. Changes a few times per spoken turn. */
export function VoiceModeStatusText() {
  const m = useMessages();
  const { state } = useVoiceAgentSnapshot();
  switch (state.phase) {
    case "connecting":
    case "listening":
    case "userSpeaking":
    case "agentSpeaking":
      return m(STATUS_COPY[state.phase]);
    case "working":
      return voiceAgentActivityLabel(state.activity ?? "other", m);
    default:
      return null;
  }
}

function VoiceModeDetailText() {
  // Server-authored English, shown as it arrives.
  return useVoiceAgentSnapshot().state.warning;
}

function VoiceModeMessage() {
  return useVoiceAgentSnapshot().state.message;
}

export function VoiceModeControls(props: { size?: "default" | "pill" }) {
  const gt = useGT();
  const shortcut = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "composer.voiceMode",
    { context: { terminalFocus: false } },
  );
  return (
    <ShortcutTooltip label={gt("End voice mode")} shortcut={shortcut}>
      <Button
        type="button"
        size={props.size === "pill" ? "sm-pill" : "xs"}
        variant="ghost"
        onClick={() => voiceAgentSession.end()}
        className="shrink-0"
      >
        {gt("End", { $context: "verb, ends voice mode" })}
      </Button>
    </ShortcutTooltip>
  );
}

function VoiceModeStoppedActions(props: {
  readonly environmentId: EnvironmentId;
  readonly onStartAgain: () => void;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const { state } = useVoiceAgentSnapshot();
  const settings = voiceModeErrorSettingsTarget(state.errorCode);
  const canStartAgain =
    state.phase === "ended" ||
    state.errorAction === "retry" ||
    state.errorCode === "consent-required" ||
    state.errorCode === "consent-revoked";
  return (
    <>
      {settings !== null ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() =>
            void navigate({
              to: settings.to,
              search: { machine: props.environmentId },
              hash: settings.hash,
            })
          }
        >
          {gt("Open settings")}
        </Button>
      ) : null}
      {canStartAgain ? (
        // Through the composer's toggle, so consent and the blocked reasons apply as for any start.
        <Button type="button" size="xs" variant="ghost" onClick={props.onStartAgain}>
          {gt("Start again")}
        </Button>
      ) : null}
    </>
  );
}

/** The agent's level while it speaks, else the microphone's. No animation loop of its own. */
export function VoiceModeMeter() {
  const levels = useVoiceAgentLevels();
  const { phase } = useVoiceAgentSnapshot().state;
  return <VoiceWaveform level={phase === "agentSpeaking" ? levels.output : levels.input} />;
}

function VoiceModeCaptions() {
  const gt = useGT();
  const last = useVoiceAgentCaptions().at(-1);
  return (
    // column-reverse keeps the newest words in view while the caption grows.
    <div
      aria-label={gt("Voice mode captions")}
      aria-live="off"
      className="flex h-full min-w-0 flex-1 flex-col-reverse overflow-hidden text-sm leading-5 wrap-anywhere"
    >
      <div className={last?.interrupted ? "text-muted-foreground" : undefined}>{last?.text}</div>
    </div>
  );
}

function VoiceModeLive() {
  return (
    // A fixed two lines: captions never change the banner's height, so the timeline's padding
    // against the composer does not move while people talk. Captions stay out of the title and
    // description, whose overflow is re-measured on every text change.
    <ComposerBanner.Body className="flex h-10 items-center gap-3">
      <div className="flex w-16 shrink-0">
        <VoiceModeMeter />
      </div>
      <VoiceModeCaptions />
    </ComposerBanner.Body>
  );
}

/** The voice session on the thread it is on: live with captions and End, or why it stopped. */
export function voiceModeBannerItem(
  input: {
    readonly presentation: Exclude<VoiceModePresentation, "hidden">;
    readonly environmentId: EnvironmentId;
    readonly onStartAgain: () => void;
  },
  resolve: MessageResolver = m,
): ComposerBannerStackItem {
  const base = {
    id: VOICE_MODE_BANNER_ID,
    group: "attention",
    icon: <AudioLinesIcon />,
  } as const;
  if (input.presentation === "live") {
    return {
      ...base,
      variant: "default",
      title: <VoiceModeStatusText />,
      description: <VoiceModeDetailText />,
      children: <VoiceModeLive />,
      actions: <VoiceModeControls />,
    };
  }
  return {
    ...base,
    variant: input.presentation === "error" ? "error" : "default",
    title:
      input.presentation === "error"
        ? resolve(msg("Voice mode stopped"))
        : resolve(msg("Voice mode ended")),
    description: <VoiceModeMessage />,
    actions: (
      <VoiceModeStoppedActions
        environmentId={input.environmentId}
        onStartAgain={input.onStartAgain}
      />
    ),
    dismissLabel: resolve(msg("Dismiss voice mode notice")),
    onDismiss: () => voiceAgentSession.dismiss(),
  };
}
