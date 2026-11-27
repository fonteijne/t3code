import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type ProviderInstanceId,
  type TextGeneratorConfig,
  type TextGeneratorModel,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { T, useGT, useMessages } from "gt-react";
import { useId, useRef, useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { textGeneratorDisplayName, useTextGeneratorModels } from "../../textGenerators";
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "../ui/autocomplete";
import { Label } from "../ui/label";

/**
 * The realtime speech model voice mode opens on an OpenAI-compatible text generator: one of the
 * endpoint's listed models or any typed name. Shown only where voice mode is on.
 */
export function TextGeneratorVoiceModelField(props: {
  readonly environmentId: EnvironmentId;
  readonly id: ProviderInstanceId;
}) {
  const settings = useEnvironmentSettings(props.environmentId);
  const offered =
    useEnvironment(props.environmentId)?.serverConfig?.environment.capabilities.voiceMode ===
      true && settings.voiceModeEnabled;
  const saved = settings.textGenerators[props.id];
  // A new generator's save has not come back yet; the field appears when it has.
  if (!offered || saved === undefined) return null;
  return <VoiceModelInput environmentId={props.environmentId} id={props.id} saved={saved} />;
}

function VoiceModelInput(props: {
  readonly environmentId: EnvironmentId;
  readonly id: ProviderInstanceId;
  readonly saved: TextGeneratorConfig;
}) {
  const { saved } = props;
  const gt = useGT();
  const messages = useMessages();
  const inputId = useId();
  const updateSettings = useUpdateEnvironmentSettings(props.environmentId);
  const models = useTextGeneratorModels(props.environmentId, props.id, saved);
  const canManage = useEnvironmentScope(props.environmentId, AuthProvidersManageScope);
  // Owned by the input: the wizard mounts this once per visit to its second step.
  const [draft, setDraft] = useState(saved.voiceModel ?? "");
  const highlightedRef = useRef<TextGeneratorModel | undefined>(undefined);

  const query = draft.trim().toLowerCase();
  const listed = AsyncResult.isSuccess(models) ? models.value : [];
  // No filter for realtime models: nothing in the list marks them.
  const shown = listed.filter(
    (model) =>
      query === "" ||
      model.id.toLowerCase().includes(query) ||
      model.name.toLowerCase().includes(query),
  );
  const commit = (value: string) => {
    const voiceModel = value.trim();
    if (voiceModel === (saved.voiceModel ?? "")) return;
    // The whole entry: its redacted key marker keeps the saved key, and "" removes the model.
    updateSettings({ textGenerators: { [props.id]: { ...saved, voiceModel } } });
  };

  return (
    <div className="grid gap-1.5 border-t pt-4">
      <Label htmlFor={inputId}>
        <T>Voice model (optional)</T>
      </Label>
      <Autocomplete
        items={shown}
        itemToStringValue={(model: TextGeneratorModel) => model.id}
        mode="none"
        openOnInputClick
        onItemHighlighted={(model) => {
          highlightedRef.current = model;
        }}
        value={draft}
        onValueChange={(value, details) => {
          setDraft(value);
          if (details.reason === "item-press") commit(value);
        }}
      >
        <AutocompleteInput
          id={inputId}
          aria-label={gt("Voice model")}
          placeholder={gt("Search models or type a name")}
          disabled={!canManage}
          maxLength={256}
          spellCheck={false}
          onBlur={() => commit(draft)}
          onKeyDown={(event) => {
            // Enter on a highlighted model picks it; only free text is saved from here.
            if (
              event.key === "Enter" &&
              !event.nativeEvent.isComposing &&
              highlightedRef.current === undefined
            )
              commit(draft);
          }}
        />
        <AutocompletePopup>
          {shown.length > 0 ? (
            <AutocompleteList scrollAreaClassName="max-h-64">
              {shown.map((model) => (
                <AutocompleteItem key={model.id} value={model}>
                  <span className="min-w-0 truncate">{model.id}</span>
                </AutocompleteItem>
              ))}
            </AutocompleteList>
          ) : AsyncResult.isSuccess(models) ? (
            <AutocompleteEmpty>
              <T>No listed model matches, but the name you typed is used as it is.</T>
            </AutocompleteEmpty>
          ) : null}
        </AutocompletePopup>
      </Autocomplete>
      <p className="text-xs text-muted-foreground">
        {gt("Voice mode opens this realtime speech model on {name}.", {
          name: textGeneratorDisplayName(saved, messages),
        })}
      </p>
    </div>
  );
}
