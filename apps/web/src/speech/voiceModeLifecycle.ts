import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { voiceAgentIsActive } from "@t3tools/client-runtime/voice-agent";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import { msg } from "gt-react";

import { isAppModalPage } from "../components/sidebar/mainAppLocation";
import { toastManager } from "../components/ui/toast";
import { composerDraftHasUserContent, useComposerDraftStore } from "../composerDraftStore";
import { m } from "../i18n/messages";
import { announce } from "../lib/announce";
import { registerCommands } from "../shortcuts/dispatcher";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import { voiceAgentSession } from "./voiceAgentSession";
import {
  voiceModeAnnouncement,
  voiceModeFollowTarget,
  voiceModeLeftDraft,
  voiceModeUnboundDraft,
} from "./voiceMode.logic";

/** The thread or draft on screen. Null under Settings or Usage and on pages without a thread. */
function readShownThreadRef(router: AnyRouter): ScopedThreadRef | null {
  if (router.state.matches.some((match) => isAppModalPage(match.pathname))) return null;
  const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  if (target === null) return null;
  if (target.kind === "server") return target.threadRef;
  const draft = useComposerDraftStore.getState().getDraftSession(target.draftId);
  return draft ? scopeThreadRef(draft.environmentId, draft.threadId) : null;
}

/** Removes a draft the voice session left that holds nothing, so no empty "New thread" stays. */
function discardEmptyDraft(draftRef: ScopedThreadRef): void {
  const store = useComposerDraftStore.getState();
  const draftId = store.getDraftIdByRef(draftRef);
  if (draftId === null) return;
  const session = store.getDraftSession(draftId);
  if (session === null || (session.promotedTo ?? null) !== null) return;
  if (composerDraftHasUserContent(store.getComposerDraft(draftId))) return;
  store.clearDraftThread(draftId);
}

/**
 * Ends a running session with `composer.voiceMode` where no chat takes the chord: Settings, pages
 * without a thread, a thread behind a modal. A shown chat handles it first, in the capture phase.
 */
export function registerVoiceModeEndCommand(): () => void {
  return registerCommands({
    "composer.voiceMode": (event) => {
      if (!voiceAgentIsActive(voiceAgentSession.getSnapshot().state)) return false;
      event.preventDefault();
      if (!event.repeat) voiceAgentSession.end();
    },
  });
}

/**
 * Follows the voice session when it moves to another thread while the user is looking at the one
 * it was on, and announces its changes. A store subscription, so it works wherever the user is.
 */
export function startVoiceModeLifecycle(router: AnyRouter): () => void {
  let previous = voiceAgentSession.getSnapshot();
  const stopDraftWatch = useComposerDraftStore.subscribe((store) => {
    const draftRef = voiceModeUnboundDraft(voiceAgentSession.getSnapshot());
    if (draftRef === null) return;
    const draftId = store.getDraftIdByRef(draftRef);
    const draft = draftId === null ? null : store.getDraftSession(draftId);
    const sent = (draft?.promotedTo ?? null) !== null;
    if (draft !== null && !sent) return;
    voiceAgentSession.end();
    if (!sent) return;
    toastManager.add({
      type: "info",
      title: m(msg("Voice mode ended")),
      description: m(
        msg(
          "You sent this thread's first message by typing. Start voice mode again to talk to it.",
        ),
      ),
    });
  });
  const stopSessionWatch = voiceAgentSession.subscribe(() => {
    const next = voiceAgentSession.getSnapshot();
    const message = voiceModeAnnouncement(previous, next);
    const follow = voiceModeFollowTarget(previous, next, readShownThreadRef(router));
    const leftDraft = voiceModeLeftDraft(previous, next);
    previous = next;
    if (message !== null) announce(message, "voice-mode");
    if (follow !== null) {
      // No `replace`: Back returns to the thread the user was on.
      void router
        .navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(follow),
        })
        // Only once the draft is off screen, so its route never sees it vanish.
        .then(() => leftDraft !== null && discardEmptyDraft(leftDraft));
    } else if (leftDraft !== null) {
      discardEmptyDraft(leftDraft);
    }
  });
  return () => {
    stopDraftWatch();
    stopSessionWatch();
  };
}
