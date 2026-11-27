import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  type ServerSettings,
  type TextGeneratorConfig,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { resolveVoiceAgent } from "./voiceAgent.ts";

const projectId = ProjectId.make("project-a");
const a = ProviderInstanceId.make("gateway-a");
const b = ProviderInstanceId.make("gateway-b");

const generator = (overrides: Partial<TextGeneratorConfig> = {}): TextGeneratorConfig => ({
  kind: "openaiCompatible",
  baseUrl: "https://gateway.test/v1",
  apiKey: "",
  enabled: true,
  voiceModel: "realtime",
  ...overrides,
});

const settings = (overrides: Partial<ServerSettings> = {}): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  voiceModeEnabled: true,
  ...overrides,
});

const two = { [a]: generator(), [b]: generator({ voiceModel: "realtime-b" }) };

it.each([
  {
    name: "the Labs flag is off",
    settings: settings({ voiceModeEnabled: false, textGenerators: { [a]: generator() } }),
    expected: { available: false, reason: "not-enabled" },
  },
  {
    name: "there is no text generator",
    settings: settings(),
    expected: { available: false, reason: "no-endpoint" },
  },
  {
    name: "one endpoint has a voice model and nobody chose",
    settings: settings({ textGenerators: { [a]: generator() } }),
    expected: { available: true, endpointId: a, model: "realtime", source: "only-endpoint" },
  },
  {
    name: "the only endpoint with a voice model is switched off",
    settings: settings({ textGenerators: { [a]: generator({ enabled: false }) } }),
    expected: { available: false, reason: "no-endpoint" },
  },
  {
    name: "the voice model sits on an endpoint that is not OpenAI-compatible",
    settings: settings({ textGenerators: { [a]: generator({ kind: "anthropic" }) } }),
    expected: { available: false, reason: "no-endpoint" },
  },
  {
    name: "two endpoints have a voice model and nobody chose",
    settings: settings({ textGenerators: two }),
    expected: { available: false, reason: "choose-endpoint" },
  },
  {
    name: "the environment chose one of two",
    settings: settings({ textGenerators: two, voiceAgentEndpoint: b }),
    expected: { available: true, endpointId: b, model: "realtime-b", source: "environment" },
  },
  {
    name: "the project chose the other one",
    settings: settings({
      textGenerators: two,
      voiceAgentEndpoint: a,
      projectSettingsOverrides: { [projectId]: { voiceAgentEndpoint: b } },
    }),
    expected: { available: true, endpointId: b, model: "realtime-b", source: "project" },
    withoutProject: { available: true, endpointId: a, model: "realtime", source: "environment" },
  },
  {
    name: "the project's choice was removed, even though the environment's works",
    settings: settings({
      textGenerators: { [a]: generator() },
      voiceAgentEndpoint: a,
      projectSettingsOverrides: { [projectId]: { voiceAgentEndpoint: b } },
    }),
    expected: { available: false, reason: "endpoint-missing", endpointId: b },
  },
  {
    name: "the chosen endpoint is switched off",
    settings: settings({
      textGenerators: { [a]: generator({ enabled: false }), [b]: generator() },
      voiceAgentEndpoint: a,
    }),
    expected: { available: false, reason: "endpoint-disabled", endpointId: a },
  },
  {
    name: "the chosen endpoint has no voice model while another has one",
    settings: settings({
      textGenerators: { [a]: generator({ voiceModel: "" }), [b]: generator() },
      voiceAgentEndpoint: a,
    }),
    expected: { available: false, reason: "no-voice-model", endpointId: a },
  },
])("resolves the voice agent when $name", ({ settings, expected, withoutProject }) => {
  expect(resolveVoiceAgent(settings, projectId)).toMatchObject(expected);
  if (withoutProject) expect(resolveVoiceAgent(settings, null)).toMatchObject(withoutProject);
});
