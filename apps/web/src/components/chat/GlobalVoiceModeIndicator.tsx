import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { XIcon } from "lucide-react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useVoiceAgentSnapshot, voiceAgentSession } from "../../speech/voiceAgentSession";
import { threadTakesVoiceMode, voiceModeThreadRef } from "../../speech/voiceMode.logic";
import { useQuietThreadShell } from "../../state/entities";
import {
  buildDraftThreadRouteParams,
  buildThreadRouteParams,
  type ThreadRouteTarget,
} from "../../threadRoutes";
import { Button } from "../ui/button";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { GlobalVoiceCapsule } from "./GlobalVoiceInputIndicator";
import { VoiceInputPill } from "./VoiceInputPill";
import { VoiceModeControls, VoiceModeMeter, VoiceModeStatusText } from "./VoiceModeBanner";

/**
 * Shows the voice session wherever its banner is not on screen, with the way back to its thread
 * and the way to end it. The banner and this capsule are never both missing.
 */
export function GlobalVoiceModeIndicator(props: {
  /** The thread or draft the page shows. Null under Settings and Usage. */
  shownTarget: ThreadRouteTarget | null;
  /** A modal page renders its own copy, so the layout's copy stands down. */
  hidden?: boolean;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const snapshot = useVoiceAgentSnapshot();
  const ref = voiceModeThreadRef(snapshot);
  const { shownTarget } = props;
  const shownDraftId = shownTarget?.kind === "draft" ? shownTarget.draftId : null;
  const shownDraftKey = useComposerDraftStore((store) => {
    const draft = shownDraftId === null ? null : store.getDraftSession(shownDraftId);
    return draft ? scopedThreadKey(scopeThreadRef(draft.environmentId, draft.threadId)) : null;
  });
  const shownKey =
    shownTarget?.kind === "server" ? scopedThreadKey(shownTarget.threadRef) : shownDraftKey;
  const shell = useQuietThreadShell(ref);
  const { state } = snapshot;
  if (props.hidden || state.phase === "idle" || ref === null) return null;
  // The page shows the session's thread, and that view's composer carries the banner. A draft has
  // no shell and always has a composer; a side chat or subagent view has no banner.
  if (scopedThreadKey(ref) === shownKey && (shell === null || threadTakesVoiceMode(shell))) {
    return null;
  }

  const open = () => {
    const draftId = useComposerDraftStore.getState().getDraftIdByRef(ref);
    void (draftId
      ? navigate({ to: "/draft/$draftId", params: buildDraftThreadRouteParams(draftId) })
      : navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) }));
  };
  const stopped = state.phase === "ended" || state.phase === "error";
  const dismissLabel = gt("Dismiss voice mode notice");

  return (
    <GlobalVoiceCapsule label={shell?.title || gt("Untitled thread")} onOpen={open}>
      {stopped ? (
        <VoiceInputPill tone={state.phase === "error" ? "error" : "default"}>
          <span className="min-w-0 truncate px-2.5 text-sm">{state.message}</span>
          <SharedTooltipTrigger
            label={dismissLabel}
            render={
              <Button
                type="button"
                size="icon-sm-pill"
                variant="ghost"
                aria-label={dismissLabel}
                onClick={() => voiceAgentSession.dismiss()}
                className="shrink-0"
              >
                <XIcon />
              </Button>
            }
          />
        </VoiceInputPill>
      ) : (
        <VoiceInputPill>
          <div className="ms-2.5 flex w-12 shrink-0">
            <VoiceModeMeter />
          </div>
          <span className="min-w-0 truncate text-sm text-muted-foreground">
            <VoiceModeStatusText />
          </span>
          <VoiceModeControls size="pill" />
        </VoiceInputPill>
      )}
    </GlobalVoiceCapsule>
  );
}
