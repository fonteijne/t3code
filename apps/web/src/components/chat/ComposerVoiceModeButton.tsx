import { useGT, useMessages } from "gt-react";
import { AudioLinesIcon } from "lucide-react";

import { VOICE_MODE_BLOCK_COPY, type VoiceModeEntry } from "../../speech/voiceMode.logic";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { keepFocus, ShortcutTooltip } from "./ComposerSpeechButton";

export function ComposerVoiceModeButton(props: {
  entry: Exclude<VoiceModeEntry, { kind: "hidden" }>;
  connecting: boolean;
  shortcutLabel: string | null;
  onToggle(): void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { entry } = props;
  const active = entry.kind === "active";
  const inert = entry.kind === "blocked" && !entry.opensSettings;
  const name = active ? gt("End voice mode") : gt("Start voice mode");
  return (
    <ShortcutTooltip
      label={entry.kind === "blocked" ? m(VOICE_MODE_BLOCK_COPY[entry.reason]) : name}
      shortcut={entry.kind === "blocked" ? null : props.shortcutLabel}
    >
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={name}
        aria-pressed={active}
        // Not `disabled`: the tooltip and the click, which shows the reason, must keep working.
        aria-disabled={inert || undefined}
        data-pressed={active ? "" : undefined}
        onPointerDown={keepFocus}
        onClick={props.onToggle}
        className="shrink-0"
      >
        {props.connecting ? <Spinner aria-hidden /> : <AudioLinesIcon />}
      </Button>
    </ShortcutTooltip>
  );
}
