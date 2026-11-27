import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";

import { isAppModalPage } from "../components/sidebar/mainAppLocation";
import { useComposerDraftStore } from "../composerDraftStore";
import { announce } from "../lib/announce";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import { voiceAgentSession } from "./voiceAgentSession";
import { voiceModeAnnouncement, voiceModeFollowTarget } from "./voiceMode.logic";

/** The thread or draft on screen. Null under Settings or Usage and on pages without a thread. */
function readShownThreadRef(router: AnyRouter): ScopedThreadRef | null {
  if (router.state.matches.some((match) => isAppModalPage(match.pathname))) return null;
  const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  if (target === null) return null;
  if (target.kind === "server") return target.threadRef;
  const draft = useComposerDraftStore.getState().getDraftSession(target.draftId);
  return draft ? scopeThreadRef(draft.environmentId, draft.threadId) : null;
}

/**
 * Follows the voice session when it moves to another thread while the user is looking at the one
 * it was on, and announces its changes. A store subscription, so it works wherever the user is.
 */
export function startVoiceModeLifecycle(router: AnyRouter): () => void {
  let previous = voiceAgentSession.getSnapshot();
  return voiceAgentSession.subscribe(() => {
    const next = voiceAgentSession.getSnapshot();
    const message = voiceModeAnnouncement(previous, next);
    const follow = voiceModeFollowTarget(previous, next, readShownThreadRef(router));
    previous = next;
    if (message !== null) announce(message, "voice-mode");
    if (follow !== null) {
      // No `replace`: Back returns to the thread the user was on.
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(follow),
      });
    }
  });
}
