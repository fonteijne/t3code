import type {
  ProjectId,
  ProviderInstanceId,
  ServerSettings,
  TextGeneratorConfig,
} from "@t3tools/contracts";

export type VoiceAgentUnavailableReason =
  /** The Labs flag is off. Hide the entry points. */
  | "not-enabled"
  /** No enabled OpenAI-compatible text generator has a voice model. */
  | "no-endpoint"
  /** Several have one and neither the project nor the environment chose. */
  | "choose-endpoint"
  /** The chosen text generator was removed or is not OpenAI-compatible. */
  | "endpoint-missing"
  /** The chosen text generator is switched off. */
  | "endpoint-disabled"
  /** The chosen text generator has no voice model. */
  | "no-voice-model";

export type VoiceAgentResolution =
  | {
      readonly available: true;
      readonly endpointId: ProviderInstanceId;
      readonly endpoint: TextGeneratorConfig;
      readonly model: string;
      /** Which setting picked the endpoint. */
      readonly source: "project" | "environment" | "only-endpoint";
    }
  | {
      readonly available: false;
      readonly reason: VoiceAgentUnavailableReason;
      /** The chosen endpoint, for the three reasons that are about one. */
      readonly endpointId?: ProviderInstanceId;
    };

type VoiceAgentSettings = Pick<
  ServerSettings,
  "voiceModeEnabled" | "voiceAgentEndpoint" | "textGenerators" | "projectSettingsOverrides"
>;

/** The voice model of a text generator that can run voice mode, if it has one. */
export const textGeneratorVoiceModel = (config: TextGeneratorConfig): string | undefined =>
  config.kind === "openaiCompatible" && config.voiceModel ? config.voiceModel : undefined;

/**
 * Where voice mode for a project connects. A chosen endpoint that cannot run it is reported, never
 * replaced by another one: microphone audio only goes where someone chose to send it.
 */
export function resolveVoiceAgent(
  settings: VoiceAgentSettings,
  projectId: ProjectId | null,
): VoiceAgentResolution {
  if (!settings.voiceModeEnabled) return { available: false, reason: "not-enabled" };

  const override =
    projectId === null
      ? undefined
      : settings.projectSettingsOverrides[projectId]?.voiceAgentEndpoint;
  const chosen = override ?? settings.voiceAgentEndpoint;

  if (chosen !== null) {
    const endpoint = Object.hasOwn(settings.textGenerators, chosen)
      ? settings.textGenerators[chosen]
      : undefined;
    if (endpoint === undefined || endpoint.kind !== "openaiCompatible") {
      return { available: false, reason: "endpoint-missing", endpointId: chosen };
    }
    if (!endpoint.enabled) {
      return { available: false, reason: "endpoint-disabled", endpointId: chosen };
    }
    const model = textGeneratorVoiceModel(endpoint);
    if (model === undefined) {
      return { available: false, reason: "no-voice-model", endpointId: chosen };
    }
    return {
      available: true,
      endpointId: chosen,
      endpoint,
      model,
      source: override !== undefined ? "project" : "environment",
    };
  }

  const candidates = (
    Object.entries(settings.textGenerators) as Array<[ProviderInstanceId, TextGeneratorConfig]>
  ).flatMap(([endpointId, endpoint]) => {
    const model = endpoint.enabled ? textGeneratorVoiceModel(endpoint) : undefined;
    return model === undefined ? [] : [{ endpointId, endpoint, model }];
  });
  const [only] = candidates;
  if (only === undefined) return { available: false, reason: "no-endpoint" };
  if (candidates.length > 1) return { available: false, reason: "choose-endpoint" };
  return { available: true, ...only, source: "only-endpoint" };
}
