import { useGT } from "gt-react";
import type { ReactNode } from "react";
import { useVoiceTranscriptionDestination } from "../../speech/useEnvironmentSpeechInput";
import {
  useRetainedVoiceInputSession,
  useVoiceInputSessionActivity,
  useVoiceInputSessionSnapshot,
  useVoiceOwnerPresented,
} from "../../speech/voiceInputSession";
import { Button } from "../ui/button";
import { ComposerSpeechRecordingPill } from "./ComposerSpeechButton";

/** The floating capsule a voice session shows while its thread is off screen. */
export function GlobalVoiceCapsule(props: {
  label: string;
  onOpen: (() => void) | null;
  children: ReactNode;
}) {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-100 flex justify-center px-4">
      <div className="pointer-events-auto flex max-w-full items-center gap-1 rounded-full bg-popover p-0.5 shadow-lg/5 [-webkit-app-region:no-drag]">
        <Button
          type="button"
          size="sm-pill"
          variant="ghost"
          disabled={props.onOpen === null}
          onClick={() => props.onOpen?.()}
          className="min-w-0 shrink"
        >
          <span className="truncate">{props.label}</span>
        </Button>
        {props.children}
      </div>
    </div>
  );
}

/**
 * Keeps the chosen destination's dictation alive across navigation and, while the draft it
 * records into is off screen, shows it so it can be finished, cancelled, or returned to.
 */
export function GlobalVoiceInputIndicator({ hidden = false }: { hidden?: boolean }) {
  const gt = useGT();
  const session = useRetainedVoiceInputSession(useVoiceTranscriptionDestination());
  const { state, target, recordingStartedAt } = useVoiceInputSessionSnapshot(session);
  const presented = useVoiceOwnerPresented(target?.ownerKey ?? null);
  const { level } = useVoiceInputSessionActivity(
    hidden || presented ? null : session,
    target?.ownerKey ?? null,
  );
  if (hidden || !session || !target || state.phase === "idle" || presented) return null;

  return (
    <GlobalVoiceCapsule label={target.label ?? gt("Untitled thread")} onOpen={target.open ?? null}>
      <ComposerSpeechRecordingPill
        state={state}
        progress={null}
        level={level}
        recordingStartedAt={recordingStartedAt}
        onStart={() => void session.start(target)}
        onStop={() => void session.stop()}
        onCancel={() => session.cancel()}
        onSkipPostProcessing={() => session.skipPostProcessing()}
      />
    </GlobalVoiceCapsule>
  );
}
