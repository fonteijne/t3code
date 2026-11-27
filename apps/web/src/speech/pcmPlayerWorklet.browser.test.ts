import { VOICE_AGENT_SAMPLE_RATE } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import type { PcmPlayerPosition } from "./pcmPlayerQueue";
import playerWorkletUrl from "./pcmPlayerWorklet.ts?worker&url";

type Heard = number | { readonly type: "playing"; readonly playing: boolean };
type FromPlayer = Heard | ({ readonly type: "flushed"; readonly id: number } & PcmPlayerPosition);

// An offline context renders as fast as it can, with no audio device and no autoplay rule. Its
// worklet handles port messages only while rendering is suspended, one per task, and a message
// posted right behind another can be handled after `resume()`. So the player is handed over
// suspended at frame 0 with its port idle, and a test posts one message per suspension.
async function offlinePlayer(seconds: number) {
  const context = new OfflineAudioContext(
    1,
    seconds * VOICE_AGENT_SAMPLE_RATE,
    VOICE_AGENT_SAMPLE_RATE,
  );
  await context.audioWorklet.addModule(playerWorkletUrl);
  const node = new AudioWorkletNode(context, "t3-pcm-player", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { capacitySamples: 10 * VOICE_AGENT_SAMPLE_RATE },
  });
  node.connect(context.destination);
  const heard: Heard[] = [];
  const flushes = new Map<number, (position: PcmPlayerPosition) => void>();
  node.port.onmessage = ({ data }: MessageEvent<FromPlayer>) => {
    if (typeof data === "number" || data.type === "playing") {
      heard.push(data);
      return;
    }
    const { type: _type, id, ...position } = data;
    flushes.get(id)?.(position);
  };
  /** The cut, with everything the player posted before it: the port keeps the order. */
  const flush = async () => {
    const id = flushes.size + 1;
    const { promise, resolve } = Promise.withResolvers<PcmPlayerPosition>();
    flushes.set(id, resolve);
    node.port.postMessage({ type: "flush", id }, []);
    return { position: await promise, heard: [...heard] };
  };
  // Before rendering starts: the audio thread is past this reply once it reports the suspension.
  await flush();
  const atStart = context.suspend(0);
  const rendered = context.startRendering().then((buffer) => buffer.getChannelData(0));
  await atStart;
  return {
    context,
    rendered,
    flush,
    enqueue(itemId: string, samples: Int16Array) {
      const pcm = samples.slice();
      node.port.postMessage({ type: "enqueue", itemId, pcm }, [pcm.buffer]);
    },
  };
}

const played = (pcm: Int16Array) => Array.from(pcm, (sample) => sample / 32_768);
const tone = (length: number, sign: 1 | -1) =>
  Int16Array.from({ length }, (_, index) => sign * (8_000 + index));

it("plays queued items in order, then silence, and stops metering once idle", async () => {
  const player = await offlinePlayer(3);
  const first = tone(2_400, 1);
  const second = tone(1_200, -1);
  player.enqueue("a", first);
  const appended = player.context.suspend(0.05).then(() => {
    player.enqueue("b", second);
    return player.context.resume();
  });
  const idle = player.context.suspend(2.5).then(async () => {
    const cut = await player.flush();
    await player.context.resume();
    return cut;
  });
  await player.context.resume();
  await appended;

  const { position, heard } = await idle;
  expect(position).toEqual({ itemId: "b", positionSamples: second.length, pending: false });
  const rendered = await player.rendered;
  const audible = first.length + second.length;
  expect(Array.from(rendered.subarray(0, audible))).toEqual([...played(first), ...played(second)]);
  expect(rendered.subarray(audible).every((sample) => sample === 0)).toBe(true);

  expect(heard.filter((message) => typeof message !== "number")).toEqual([
    { type: "playing", playing: true },
    { type: "playing", playing: false },
  ]);
  const levels = heard.filter((message) => typeof message === "number");
  expect(levels.at(-1)).toBe(0);
  expect(levels.slice(0, -1).every((level) => level > 0)).toBe(true);
  // A meter that kept running would have posted 20 levels a second for the 2.5 seconds.
  expect(levels.length).toBeLessThan(40);
});

it("cuts playback at once and reports how much of the item was played", async () => {
  const player = await offlinePlayer(1);
  const item = tone(12_000, 1);
  player.enqueue("a", item);
  const interrupted = player.context.suspend(0.1).then(async () => {
    const frames = Math.round(player.context.currentTime * VOICE_AGENT_SAMPLE_RATE);
    const { position } = await player.flush();
    await player.context.resume();
    return { frames, position };
  });
  await player.context.resume();

  const { frames, position } = await interrupted;
  expect(frames).toBeGreaterThan(0);
  expect(frames).toBeLessThan(item.length);
  expect(position).toEqual({ itemId: "a", positionSamples: frames, pending: true });
  const rendered = await player.rendered;
  expect(Array.from(rendered.subarray(0, frames))).toEqual(played(item.subarray(0, frames)));
  expect(rendered.subarray(frames).every((sample) => sample === 0)).toBe(true);
});
