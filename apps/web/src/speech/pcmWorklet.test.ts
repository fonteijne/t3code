import { expect, it, vi } from "vite-plus/test";

class Worklet {
  readonly port = {
    onmessage: null as ((event: { data: string }) => void) | null,
    postMessage: vi.fn<(data: unknown) => void>(),
  };
  process(_inputs: Float32Array[][]): boolean {
    return true;
  }
}
type Processor = new (options?: {
  processorOptions: {
    meterOnly?: boolean;
    pcm16?: { sampleRate: number; frameSamples: number };
  };
}) => Worklet;

async function loadWorklet() {
  using globals = new DisposableStack();
  const setGlobal = (name: string, value: unknown) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    globals.defer(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    });
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };
  let Processor!: Processor;
  setGlobal("sampleRate", 48_000);
  setGlobal("AudioWorkletProcessor", Worklet);
  setGlobal("registerProcessor", (_name: string, processor: Processor) => {
    Processor = processor;
  });
  // The module registers its processor when it is evaluated, so each test evaluates it afresh.
  vi.resetModules();
  await import("./pcmWorklet");
  const restore = globals.move();
  return { Processor, [Symbol.dispose]: () => restore.dispose() };
}

it("meters microphone-only capture like transcription without emitting PCM", async () => {
  using worklet = await loadWorklet();
  const { Processor } = worklet;
  const transcription = new Processor();
  const microphone = new Processor({ processorOptions: { meterOnly: true } });
  transcription.port.onmessage?.({ data: "start" });
  microphone.port.onmessage?.({ data: "start" });
  const feed = (samples: Float32Array) => {
    transcription.process([[samples]]);
    microphone.process([[samples]]);
  };
  const levels = (processor: Worklet) =>
    processor.port.postMessage.mock.calls
      .map(([data]) => data)
      .filter((data) => typeof data === "number");

  feed(new Float32Array(2_399).fill(0.1));
  expect(levels(microphone)).toHaveLength(0);
  feed(new Float32Array(1).fill(0.1));
  expect(levels(microphone)).toHaveLength(1);
  feed(new Float32Array(48_000).fill(0.25));
  feed(new Float32Array(2_400));

  const measured = levels(microphone);
  expect(measured).toEqual(levels(transcription));
  expect(measured).toHaveLength(22);
  expect(measured[0]).toBeGreaterThan(0);
  expect(measured[0]).toBeLessThan(0.4);
  expect(measured.at(-1)).toBeGreaterThan(0);
  expect(measured.at(-1)).toBeLessThan(measured.at(-2)!);
  expect(
    transcription.port.postMessage.mock.calls.some(([data]) => data instanceof Float32Array),
  ).toBe(true);
  expect(microphone.port.postMessage.mock.calls.every(([data]) => typeof data === "number")).toBe(
    true,
  );
  microphone.port.onmessage?.({ data: "stop" });
  expect(microphone.port.postMessage).toHaveBeenLastCalledWith("stopped");
});

it("emits 16-bit frames at the requested rate with no duration limit for voice mode", async () => {
  using worklet = await loadWorklet();
  const voice = new worklet.Processor({
    processorOptions: { pcm16: { sampleRate: 24_000, frameSamples: 960 } },
  });
  voice.port.onmessage?.({ data: "start" });
  const second = new Float32Array(48_000).fill(1);
  // Five minutes is where dictation stops: 4 800 000 samples of output.
  for (let seconds = 0; seconds < 301; seconds++) voice.process([[second]]);

  const posted = voice.port.postMessage.mock.calls.map(([data]) => data);
  const frames = posted.filter((data) => data instanceof Int16Array);
  expect(posted).not.toContain("limit");
  expect(posted.some((data) => data instanceof Float32Array)).toBe(false);
  expect(frames).toHaveLength((301 * 24_000) / 960);
  expect(frames.every((frame) => frame.length === 960)).toBe(true);
  expect(Array.from(new Set(frames.at(-1)))).toEqual([32_767]);
});
