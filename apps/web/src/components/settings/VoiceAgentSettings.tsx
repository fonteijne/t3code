import { ProviderInstanceId, type TextGeneratorConfig } from "@t3tools/contracts";
import { resolveVoiceAgent, textGeneratorVoiceModel } from "@t3tools/shared/voiceAgent";
import { useNavigate } from "@tanstack/react-router";
import { useGT, useMessages } from "gt-react";

import {
  voiceEndpointHost,
  VOICE_AGENT_SETTINGS_ANCHOR,
  VOICE_MODE_LABS_ANCHOR,
} from "../../speech/voiceMode.logic";
import { chooseVoiceAgentDestination, useVoiceAgentGrant } from "../../speech/voiceConsent";
import { useEnvironments } from "../../state/environments";
import { textGeneratorDisplayName } from "../../textGenerators";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import type { ScopedSettingsTarget } from "./scopedSettings";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useUpdateScopedSettings } from "./useScopedSettings";

const AUTOMATIC = "auto";

/**
 * Which endpoint voice mode talks to, for the environment or the project in scope, and this
 * device's permission to send it microphone audio.
 */
export function VoiceAgentSection() {
  const setting = useSearchableSetting();
  const gt = useGT();
  const navigate = useNavigate();
  const context = useOptionalSettingsScope();
  const grant = useVoiceAgentGrant();
  // An older server would silently drop the keys.
  const offered =
    context?.connectedEnvironments.some(
      (environment) => environment.serverConfig?.environment.capabilities.voiceMode === true,
    ) === true;
  const targets = context?.targets ?? [];
  const [target] = targets;
  const setup = !offered ? null : targets.length !== 1 || target === undefined ? (
    // The endpoint names a text generator of one environment, so one id cannot go to several.
    <SettingsRow
      title={gt("Endpoint", { $context: "the service voice mode connects to" })}
      description={gt("Choose one environment to set up its voice agent.")}
    />
  ) : !target.settings.voiceModeEnabled ? (
    <SettingsRow
      title={gt("Voice mode is off")}
      description={gt("Voice mode is a Labs feature, so turn it on there to choose its endpoint.")}
      control={
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            void navigate({
              to: "/settings/labs",
              search: { machine: target.environmentId },
              hash: VOICE_MODE_LABS_ANCHOR,
            })
          }
        >
          {gt("Open Labs")}
        </Button>
      }
    />
  ) : (
    <>
      <VoiceAgentEndpointRow target={target} />
      {grant === null ? <VoiceAgentConsentRow /> : null}
    </>
  );
  // A stored permission to send microphone audio stays visible and revocable whatever the scope,
  // the capability or the Labs switch say.
  if (setup === null && grant === null) return null;
  return (
    <SettingsSection id={setting(VOICE_AGENT_SETTINGS_ANCHOR).id} title={gt("Voice agent")}>
      {setup}
      {grant === null ? null : <VoiceAgentConsentRow />}
    </SettingsSection>
  );
}

function VoiceAgentEndpointRow({ target }: { readonly target: ScopedSettingsTarget }) {
  const gt = useGT();
  const messages = useMessages();
  const navigate = useNavigate();
  const { scope } = useSettingsScope();
  const updateSettings = useUpdateScopedSettings();
  const { settings } = target;
  // The scope's resolved settings still carry the project overrides, so this is what the server
  // resolves for that project.
  const resolution = resolveVoiceAgent(settings, target.projectId);
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const choices = (
    Object.entries(settings.textGenerators) as Array<[ProviderInstanceId, TextGeneratorConfig]>
  ).filter(([, config]) => config.kind === "openaiCompatible");
  const chosen = settings.voiceAgentEndpoint;
  const chosenConfig = choices.find(([id]) => id === chosen)?.[1];
  const nameOf = (id: ProviderInstanceId | undefined) => {
    const config = choices.find(([candidate]) => candidate === id)?.[1];
    return config ? textGeneratorDisplayName(config, messages) : gt("Removed text generator");
  };
  const automatic = gt("Automatic", {
    $context: "voice agent endpoint, uses the only one that has a voice model",
  });

  const description = resolution.available
    ? gt("Voice mode talks to {endpoint} with the voice model {model}.", {
        endpoint: textGeneratorDisplayName(resolution.endpoint, messages),
        model: resolution.model,
      })
    : resolution.reason === "no-endpoint"
      ? gt("No text generator has a voice model yet, so add one in Providers.")
      : resolution.reason === "choose-endpoint"
        ? gt("Several text generators have a voice model, so choose the one voice mode talks to.")
        : resolution.reason === "endpoint-missing"
          ? gt("The chosen text generator no longer exists, so choose another one.")
          : resolution.reason === "endpoint-disabled"
            ? gt("{endpoint} is turned off, so turn it on in Providers or choose another one.", {
                endpoint: nameOf(resolution.endpointId),
              })
            : resolution.reason === "no-voice-model"
              ? gt(
                  "{endpoint} has no voice model, so add one in Providers or choose another one.",
                  { endpoint: nameOf(resolution.endpointId) },
                )
              : gt("Voice mode is a Labs feature, so turn it on there to choose its endpoint.");

  return (
    <SettingsRow
      serverScoped
      settingKeys={["voiceAgentEndpoint"]}
      title={gt("Endpoint", { $context: "the service voice mode connects to" })}
      description={description}
      control={
        choices.length === 0 ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              void navigate({
                to: "/settings/providers",
                search: { machine: target.environmentId },
                hash: "text-generators",
              })
            }
          >
            {gt("Open text generators")}
          </Button>
        ) : (
          <Select
            value={chosen ?? AUTOMATIC}
            onValueChange={(value) => {
              if (value)
                updateSettings({
                  voiceAgentEndpoint: value === AUTOMATIC ? null : ProviderInstanceId.make(value),
                });
            }}
          >
            <SelectTrigger size="sm" aria-label={gt("Voice agent endpoint")}>
              <SelectValue>{chosen === null ? automatic : nameOf(chosen)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {/* A project inherits by resetting the row, which removes its override. */}
              {isProjectScope ? null : <SelectItem value={AUTOMATIC}>{automatic}</SelectItem>}
              {choices.map(([id, config]) => (
                <SelectItem key={id} value={id}>
                  <span className="flex flex-col">
                    {textGeneratorDisplayName(config, messages)}
                    <span className="text-xs text-muted-foreground">
                      {config.enabled
                        ? (textGeneratorVoiceModel(config) ?? gt("No voice model"))
                        : gt("Off", { $context: "this text generator is turned off" })}
                    </span>
                  </span>
                </SelectItem>
              ))}
              {chosen !== null && chosenConfig === undefined ? (
                <SelectItem value={chosen}>{gt("Removed text generator")}</SelectItem>
              ) : null}
            </SelectPopup>
          </Select>
        )
      }
    />
  );
}

/** This device's grant. It needs no environment, so it is not a server-scoped row. */
function VoiceAgentConsentRow() {
  const gt = useGT();
  const messages = useMessages();
  const grant = useVoiceAgentGrant();
  const { environments } = useEnvironments();
  const title = gt("Microphone audio on this device");
  if (grant === null) {
    return (
      <SettingsRow
        title={title}
        description={gt("Voice mode asks before it sends microphone audio from this device.")}
      />
    );
  }
  // Both names degrade without the environment: the stored address and the environment's id.
  const { destination } = grant;
  const environment = environments.find(
    (candidate) => candidate.environmentId === destination.environmentId,
  );
  const textGenerators = environment?.serverConfig?.settings.textGenerators;
  const config =
    textGenerators && Object.hasOwn(textGenerators, destination.endpointId)
      ? textGenerators[destination.endpointId]
      : undefined;
  return (
    <SettingsRow
      title={title}
      description={gt("Voice mode may send microphone audio to {endpoint} through {environment}.", {
        endpoint: config
          ? textGeneratorDisplayName(config, messages)
          : voiceEndpointHost(destination.baseUrl),
        environment: environment?.label ?? destination.environmentId,
      })}
      control={
        <Button size="xs" variant="outline" onClick={() => chooseVoiceAgentDestination(null)}>
          {gt("Revoke", { $context: "verb, withdraws permission to send microphone audio" })}
        </Button>
      }
    />
  );
}
