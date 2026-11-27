import { BearerConnectionTarget } from "@t3tools/client-runtime/connection";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ServerSettings,
  type TextGeneratorConfig,
} from "@t3tools/contracts";
import { createElement, useLayoutEffect } from "react";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { useVoiceAgentAvailability, type VoiceAgentAvailability } from "./voiceAgentSession";
import { chooseVoiceAgentDestination, type VoiceAgentDestination } from "./voiceConsent";

const mocks = vi.hoisted(() => ({
  settings: null as ServerSettings | null,
  voiceMode: true,
  operate: true,
  prepared: null as unknown,
}));

vi.mock("../connection/runtime", async () => {
  const [{ Atom }, { layerRemoteHttpClient }] = await Promise.all([
    import("effect/reactivity"),
    import("@t3tools/client-runtime/rpc"),
  ]);
  return {
    connectionAtomRuntime: Atom.runtime(
      layerRemoteHttpClient((input, init) => globalThis.fetch(input, init)),
    ),
  };
});
vi.mock("./browserMicrophones", () => ({ chooseRecordingMicrophone: async () => "" }));
vi.mock("../state/environments", () => {
  const environment = () =>
    mocks.settings && {
      serverConfig: {
        environment: { capabilities: { voiceMode: mocks.voiceMode } },
        settings: mocks.settings,
      },
    };
  return {
    readEnvironment: environment,
    useEnvironment: (environmentId: string | null) =>
      environmentId === null ? null : environment(),
  };
});
vi.mock("../state/session", async () => {
  const Option = await import("effect/Option");
  return {
    readPreparedConnection: () => mocks.prepared,
    usePreparedConnection: () => Option.fromNullishOr(mocks.prepared),
    useEnvironmentScope: () => mocks.operate,
  };
});

const environmentId = EnvironmentId.make("voice-environment");
const projectId = ProjectId.make("project-a");
const endpointId = ProviderInstanceId.make("gateway");
const baseUrl = "https://gateway.example.test/v1";
const destination: VoiceAgentDestination = { environmentId, endpointId, baseUrl };
const generator: TextGeneratorConfig = {
  kind: "openaiCompatible",
  baseUrl,
  apiKey: "",
  enabled: true,
  voiceModel: "realtime-voice",
};
const connection = new BearerConnectionTarget({
  environmentId,
  label: "Voice environment",
  connectionId: "voice",
});
const prepared = {
  environmentId,
  label: connection.label,
  target: connection,
  httpBaseUrl: "https://voice.example.test",
  socketUrl: "wss://voice.example.test/ws",
  httpAuthorization: { _tag: "Bearer" as const, token: "session-token" },
};

function setup(grant: VoiceAgentDestination | null) {
  mocks.settings = {
    ...DEFAULT_SERVER_SETTINGS,
    voiceModeEnabled: true,
    textGenerators: { [endpointId]: generator },
  };
  mocks.voiceMode = true;
  mocks.operate = true;
  mocks.prepared = prepared;
  chooseVoiceAgentDestination(grant);
}

function Probe(props: {
  readonly projectId: ProjectId | null;
  readonly report: (availability: VoiceAgentAvailability) => void;
}) {
  const availability = useVoiceAgentAvailability(environmentId, props.projectId);
  useLayoutEffect(() => props.report(availability));
  return null;
}

const resolution = { available: true, endpointId, model: "realtime-voice" };

it.each<{
  readonly name: string;
  readonly arrange?: () => void;
  readonly project?: null;
  readonly expected: unknown;
}>([
  { name: "no project is in view", project: null, expected: { status: "hidden" } },
  {
    name: "the server is too old for voice mode",
    arrange: () => {
      mocks.voiceMode = false;
    },
    expected: { status: "hidden" },
  },
  {
    name: "this client may not operate the environment",
    arrange: () => {
      mocks.operate = false;
    },
    expected: { status: "hidden" },
  },
  {
    name: "the Labs switch is off",
    arrange: () => {
      mocks.settings = { ...mocks.settings!, voiceModeEnabled: false };
    },
    expected: { status: "hidden" },
  },
  {
    name: "two endpoints have a voice model and none is chosen",
    arrange: () => {
      mocks.settings = {
        ...mocks.settings!,
        textGenerators: { [endpointId]: generator, [ProviderInstanceId.make("other")]: generator },
      };
    },
    expected: { status: "unavailable", reason: "choose-endpoint" },
  },
  {
    name: "the environment is not connected",
    arrange: () => {
      mocks.prepared = null;
    },
    expected: { status: "unavailable", reason: "offline" },
  },
  {
    name: "this device allowed another address for the endpoint",
    arrange: () =>
      chooseVoiceAgentDestination({ ...destination, baseUrl: "https://old.example.test/v1" }),
    expected: { status: "needs-consent", destination, resolution },
  },
  {
    name: "this device allowed the destination",
    expected: { status: "ready", destination, resolution },
  },
])("offers voice mode as far as $name", async ({ arrange, project, expected }) => {
  setup(destination);
  using _grant = { [Symbol.dispose]: () => chooseVoiceAgentDestination(null) };
  arrange?.();
  const report = vi.fn<(availability: VoiceAgentAvailability) => void>();
  await using _screen = await render(
    createElement(Probe, { projectId: project === null ? null : projectId, report }),
  );
  expect(report.mock.lastCall?.[0]).toMatchObject(expected as object);
  expect(report.mock.lastCall?.[0].status).toBe((expected as VoiceAgentAvailability).status);
});
