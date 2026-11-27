import { PcmPlayerQueue } from "./pcmPlayerQueue";

type PlayerOptions = { readonly processorOptions: { readonly capacitySamples: number } };

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(
  name: string,
  processor: new (options: PlayerOptions) => AudioWorkletProcessor,
): void;

type ToPlayer =
  | { readonly type: "enqueue"; readonly itemId: string; readonly pcm: Int16Array }
  | { readonly type: "flush"; readonly id: number };

class PcmPlayerProcessor extends AudioWorkletProcessor {
  private readonly queue: PcmPlayerQueue;
  private playing = false;
  private levelSamples = 0;
  private levelEnergy = 0;
  private level = 0;

  constructor(options: PlayerOptions) {
    super();
    this.queue = new PcmPlayerQueue(options.processorOptions.capacitySamples);
    this.port.onmessage = ({ data }: { readonly data: ToPlayer }) => {
      if (data.type === "enqueue") {
        this.queue.enqueue(data.pcm, data.itemId);
        return;
      }
      // Answered here, not in process(): the cut must not wait for the next render call.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- AudioWorklet MessagePorts do not accept a target origin
      this.port.postMessage({ type: "flushed", id: data.id, ...this.queue.flush() });
    };
  }

  // The capture worklet's meter over what is played, so both meters move alike.
  private meter(output: Float32Array, written: number) {
    if (written === 0 && this.level === 0) return;
    for (const sample of output) {
      this.levelEnergy += sample * sample;
      this.levelSamples++;
      if (this.levelSamples >= sampleRate / 20) {
        const target = Math.min(1, Math.sqrt(this.levelEnergy / this.levelSamples) * 4);
        const timeConstant = target > this.level ? 0.075 : 0.2;
        const decay = Math.exp(-this.levelSamples / sampleRate / timeConstant);
        const level = target + (this.level - target) * decay;
        // One last zero, then an idle player posts nothing.
        this.level = level < 0.001 ? 0 : level;
        this.port.postMessage(this.level, []);
        this.levelEnergy = 0;
        this.levelSamples = 0;
      }
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]?.[0];
    if (!output) return true;
    const written = this.queue.read(output);
    const playing = written > 0;
    if (playing !== this.playing) {
      this.playing = playing;
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- AudioWorklet MessagePorts do not accept a target origin
      this.port.postMessage({ type: "playing", playing });
    }
    this.meter(output, written);
    return true;
  }
}

registerProcessor("t3-pcm-player", PcmPlayerProcessor);
