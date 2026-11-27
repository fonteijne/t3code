import {
  EnvironmentId,
  ProviderInstanceId,
  VoiceTranscriptionDestination,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";
import { randomUUID } from "../lib/utils";
import {
  getLocalStorageItem,
  readLocalStorageValue,
  subscribeLocalStorageKey,
  useLocalStorage,
  writeLocalStorageValue,
} from "../hooks/useLocalStorage";

// Separate keys: a stale window saving ordinary preferences must not restore any grant.
const AUDIO_KEY = "t3code:voice-audio-grant:v1";
const CLEANUP_KEY = "t3code:voice-cleanup-grant:v1";
const VOICE_AGENT_KEY = "t3code:voice-agent-grant:v1";
// "device" is Apple Speech in the macOS desktop app. Audio stays on this device, so it stays out of the shared contract.
const AudioDestination = Schema.Union([
  VoiceTranscriptionDestination,
  Schema.Struct({ kind: Schema.Literal("device") }),
]);
export type AudioDestination = typeof AudioDestination.Type;
const Grant = Schema.Struct({ id: Schema.String, destination: AudioDestination });
const AudioGrant = Schema.NullOr(Grant);
const sameGrant = Schema.toEquivalence(AudioGrant);
const SavedChoice = Schema.Union([AudioGrant, Schema.Literal("off")]);
const AudioChoice = Schema.Union([
  SavedChoice,
  Schema.Struct({ pending: Grant, previous: SavedChoice }),
]);
type AudioChoice = typeof AudioChoice.Type;
const savedKey = (id: string) => `${AUDIO_KEY}:saved:${id}`;
const pendingGrant = (choice: AudioChoice) =>
  choice && choice !== "off" && "pending" in choice ? choice.pending : null;
const CleanupGrant = Schema.NullOr(Schema.String);
const decodeChoice = Schema.decodeSync(Schema.fromJsonString(AudioChoice));
const readChoice = () => readLocalStorageValue(AUDIO_KEY, null, AudioChoice);

function readSaveMarker(id: string | undefined) {
  try {
    return id ? window.localStorage.getItem(savedKey(id)) : null;
  } catch {
    return undefined;
  }
}

function activeChoice(choice: AudioChoice, marker: string | null | undefined) {
  if (!choice || choice === "off" || !("pending" in choice)) return choice;
  // Only a confirmed missing marker means the previous grant still applies.
  if (marker === null) return choice.previous;
  return marker === "true" ? choice.pending : ("off" as const);
}

export function useAudioChoice() {
  const [choice] = useLocalStorage(AUDIO_KEY, null, AudioChoice);
  const id = pendingGrant(choice)?.id;
  const marker = useSyncExternalStore(
    (notify) => (id ? subscribeLocalStorageKey(savedKey(id), notify) : () => {}),
    () => readSaveMarker(id),
    () => undefined,
  );
  return activeChoice(choice, marker);
}

function replaceChoice(choice: AudioChoice, previous = readChoice()) {
  const old = pendingGrant(previous);
  writeLocalStorageValue(AUDIO_KEY, choice, null, AudioChoice);
  if (old && pendingGrant(getLocalStorageItem(AUDIO_KEY, AudioChoice))?.id !== old.id)
    window.localStorage.removeItem(savedKey(old.id));
}

export function chooseAudioDestination(destination: AudioDestination | null) {
  replaceChoice(destination ? { id: randomUUID(), destination } : "off");
}

export function pendingCloudAudioChoice(
  destination: Extract<VoiceTranscriptionDestination, { kind: "cloud" }>,
) {
  const choice = readChoice();
  const pending = { id: randomUUID(), destination };
  replaceChoice(
    { pending, previous: activeChoice(choice, readSaveMarker(pendingGrant(choice)?.id)) },
    choice,
  );
  // A late response can acknowledge only its own choice, never write the destination another tab picked.
  return () => {
    if (pendingGrant(readChoice())?.id === pending.id)
      writeLocalStorageValue(savedKey(pending.id), true, false, Schema.Boolean);
  };
}

// Bind this recording to this act of consent, even if the user later reselects the same destination.
export function bindAudioGrant(id: string) {
  try {
    let cachedRaw: string | null = null;
    let choice: AudioChoice = null;
    const current = () => {
      const raw = window.localStorage.getItem(AUDIO_KEY);
      if (raw !== cachedRaw) {
        choice = raw ? decodeChoice(raw) : null;
        cachedRaw = raw;
      }
      const active = activeChoice(choice, readSaveMarker(pendingGrant(choice)?.id));
      return active === "off" ? null : active;
    };
    const bound = current();
    if (bound?.id !== id) return () => false;
    return () => {
      try {
        return sameGrant(current(), bound);
      } catch {
        return false;
      }
    };
  } catch {
    return () => false;
  }
}

export function useCleanupGrant() {
  return useLocalStorage(CLEANUP_KEY, null, CleanupGrant)[0];
}
export function readCleanupGrant() {
  return readLocalStorageValue(CLEANUP_KEY, null, CleanupGrant);
}
export function chooseTranscriptCleanup(enabled: boolean) {
  writeLocalStorageValue(CLEANUP_KEY, enabled ? randomUUID() : null, null, CleanupGrant);
}

/** Where voice mode sends microphone audio: an endpoint, at an address, through an environment. */
const VoiceAgentDestination = Schema.Struct({
  environmentId: EnvironmentId,
  endpointId: ProviderInstanceId,
  /** The endpoint's address when consent was given. Editing it asks again. */
  baseUrl: Schema.String,
});
export type VoiceAgentDestination = typeof VoiceAgentDestination.Type;

const VoiceAgentGrant = Schema.NullOr(
  Schema.Struct({ id: Schema.String, destination: VoiceAgentDestination }),
);
const sameVoiceAgentDestination = Schema.toEquivalence(VoiceAgentDestination);
const decodeVoiceAgentGrant = Schema.decodeSync(Schema.fromJsonString(VoiceAgentGrant));

export function useVoiceAgentGrant() {
  return useLocalStorage(VOICE_AGENT_KEY, null, VoiceAgentGrant)[0];
}

/** Null revokes. A destination replaces the previous one: one endpoint is allowed at a time. */
export function chooseVoiceAgentDestination(destination: VoiceAgentDestination | null) {
  writeLocalStorageValue(
    VOICE_AGENT_KEY,
    destination ? { id: randomUUID(), destination } : null,
    null,
    VoiceAgentGrant,
  );
}

export function voiceAgentGrantCovers(
  grant: typeof VoiceAgentGrant.Type,
  destination: VoiceAgentDestination,
): boolean {
  return grant !== null && sameVoiceAgentDestination(grant.destination, destination);
}

// Binds a session to one act of consent: revoking, or allowing again, ends it.
export function bindVoiceAgentGrant(destination: VoiceAgentDestination): () => boolean {
  try {
    const raw = window.localStorage.getItem(VOICE_AGENT_KEY);
    if (!raw || !voiceAgentGrantCovers(decodeVoiceAgentGrant(raw), destination)) return () => false;
    return () => {
      try {
        return window.localStorage.getItem(VOICE_AGENT_KEY) === raw;
      } catch {
        return false;
      }
    };
  } catch {
    return () => false;
  }
}
