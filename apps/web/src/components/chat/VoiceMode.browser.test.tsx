import type { VoiceAgentState } from "@t3tools/client-runtime/voice-agent";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type TextGeneratorConfig,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../../test/render";
import { useComposerVoiceMode } from "../../speech/useComposerVoiceMode";
import type {
  VoiceAgentAvailability,
  VoiceAgentSessionSnapshot,
  VoiceAgentTarget,
} from "../../speech/voiceAgentSession";
import { chooseVoiceAgentDestination } from "../../speech/voiceConsent";
import { ToastProvider } from "../ui/toast";
import { ComposerVoiceModeButton } from "./ComposerVoiceModeButton";
import { GlobalVoiceModeIndicator } from "./GlobalVoiceModeIndicator";
import { VoiceModeConsentDialog } from "./VoiceModeConsentDialog";

type Lineage = OrchestrationV2ThreadShell["lineage"];

const fake = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  snapshot: null as unknown as VoiceAgentSessionSnapshot,
  availability: { status: "hidden" } as VoiceAgentAvailability,
  /** What `start` saw: its target, and whether the grant for the destination was already stored. */
  starts: [] as Array<{ target: VoiceAgentTarget; granted: boolean }>,
  shells: new Map<string, { title: string; lineage: Lineage }>(),
}));

// The real session opens audio devices and sockets; these tests are about what the UI does with it.
vi.mock("../../speech/voiceAgentSession", async () => {
  const { useSyncExternalStore } = await import("react");
  const { bindVoiceAgentGrant } = await import("../../speech/voiceConsent");
  const subscribe = (listener: () => void) => {
    fake.listeners.add(listener);
    return () => fake.listeners.delete(listener);
  };
  const getSnapshot = () => fake.snapshot;
  const levels = { input: 0, output: 0 };
  const captions: ReadonlyArray<never> = [];
  return {
    voiceAgentSession: {
      subscribe,
      getSnapshot,
      start: (target: VoiceAgentTarget) => {
        const { availability } = fake;
        fake.starts.push({
          target,
          granted: "destination" in availability && bindVoiceAgentGrant(availability.destination)(),
        });
        return Promise.resolve();
      },
      end: () => {},
      dismiss: () => {},
    },
    useVoiceAgentSnapshot: () => useSyncExternalStore(subscribe, getSnapshot),
    useVoiceAgentCaptions: () => captions,
    useVoiceAgentLevels: () => levels,
    useVoiceAgentActive: () => false,
    useVoiceAgentAvailability: () => fake.availability,
  };
});
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({ label: "Workstation" }),
}));
vi.mock("../../state/entities", () => ({
  useQuietThreadShell: (ref: { threadId: string } | null) =>
    ref === null ? null : (fake.shells.get(ref.threadId) ?? null),
}));

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");
const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const endpoint: TextGeneratorConfig = {
  kind: "openaiCompatible",
  label: "Gateway",
  baseUrl: "https://gateway.example.test/v1",
  apiKey: "",
  enabled: true,
  voiceModel: "realtime-voice",
};
const destination = {
  environmentId,
  endpointId: ProviderInstanceId.make("gateway"),
  baseUrl: endpoint.baseUrl,
};
const resolution = {
  available: true,
  endpointId: destination.endpointId,
  endpoint,
  model: "realtime-voice",
  source: "only-endpoint",
} as const;
const IDLE_STATE: VoiceAgentState = {
  phase: "idle",
  threadId: null,
  activity: null,
  warning: null,
  message: null,
  errorAction: null,
};
const ORDINARY: Lineage = {
  rootThreadId: threadA,
  parentThreadId: null,
  relationshipToParent: null,
};
const SUBAGENT: Lineage = {
  rootThreadId: threadB,
  parentThreadId: threadB,
  relationshipToParent: "subagent",
};

function setup(
  input: {
    readonly availability?: VoiceAgentAvailability;
    readonly snapshot?: VoiceAgentSessionSnapshot;
    readonly lineage?: Lineage;
  } = {},
): Disposable {
  fake.listeners.clear();
  fake.snapshot = input.snapshot ?? { state: IDLE_STATE, target: null };
  fake.availability = input.availability ?? { status: "hidden" };
  fake.starts = [];
  fake.shells = new Map([[threadA, { title: "Thread A", lineage: input.lineage ?? ORDINARY }]]);
  chooseVoiceAgentDestination(null);
  return { [Symbol.dispose]: () => chooseVoiceAgentDestination(null) };
}

function Composer() {
  const voiceMode = useComposerVoiceMode({
    environmentId,
    projectId,
    threadId: threadA,
    composer: "thread",
  });
  return (
    <ToastProvider>
      {voiceMode.entry.kind === "hidden" ? null : (
        <ComposerVoiceModeButton
          entry={voiceMode.entry}
          connecting={voiceMode.activity === "connecting"}
          shortcutLabel={null}
          onToggle={voiceMode.toggle}
        />
      )}
      {voiceMode.consent ? <VoiceModeConsentDialog {...voiceMode.consent} /> : null}
    </ToastProvider>
  );
}

it("asks where microphone audio goes before the first start, and starts once it is allowed", async () => {
  using _state = setup({ availability: { status: "needs-consent", destination, resolution } });
  await using screen = await render(<Composer />);

  await userEvent.click(screen.getByRole("button", { name: "Start voice mode" }));
  const dialog = page.getByRole("dialog", { name: "Send microphone audio to Gateway?" });
  // The environment, the endpoint and its address: the three things consent is given for.
  await expect
    .element(
      dialog.getByText(
        /Workstation sends what your microphone hears to Gateway at gateway\.example\.test\./,
      ),
    )
    .toBeVisible();
  expect(fake.starts).toEqual([]);

  await userEvent.click(dialog.getByRole("button", { name: "Allow and start" }));
  expect(fake.starts).toEqual([
    {
      granted: true,
      target: { environmentId, projectId, threadId: threadA, draftThreadId: null },
    },
  ]);
});

it("says why voice mode cannot start while dictation holds the microphone", async () => {
  using _state = setup({ availability: { status: "microphone-busy" } });
  await using screen = await render(<Composer />);

  const button = screen.getByRole("button", { name: "Start voice mode" });
  await expect.element(button).toHaveAttribute("aria-disabled", "true");
  // Playwright waits for an enabled control; a person can press an aria-disabled one.
  await userEvent.click(button, { force: true });

  await expect
    .element(page.getByText("Finish or cancel dictation before you start voice mode."))
    .toBeVisible();
  expect(fake.starts).toEqual([]);
});

it.each([
  { view: "the session's own thread", lineage: ORDINARY, shown: threadA, capsule: false },
  // A subagent view has no composer, so nothing else on screen would show the open microphone.
  {
    view: "the session's thread in a subagent view",
    lineage: SUBAGENT,
    shown: threadA,
    capsule: true,
  },
  { view: "another thread", lineage: ORDINARY, shown: threadB, capsule: true },
])("keeps a running session in sight on $view", async ({ lineage, shown, capsule }) => {
  using _state = setup({
    lineage,
    snapshot: {
      state: { ...IDLE_STATE, phase: "listening", threadId: threadA },
      target: { environmentId, projectId, threadId: threadA, draftThreadId: null },
    },
  });
  await using screen = await render(
    <GlobalVoiceModeIndicator
      shownTarget={{ kind: "server", threadRef: { environmentId, threadId: shown } }}
    />,
  );

  const back = screen.getByRole("button", { name: "Thread A" });
  if (!capsule) {
    await expect.element(back).not.toBeInTheDocument();
    return;
  }
  await expect.element(screen.getByRole("button", { name: "End" })).toBeVisible();
  await userEvent.click(back);
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe(`/${environmentId}/${threadA}`),
  );
});
