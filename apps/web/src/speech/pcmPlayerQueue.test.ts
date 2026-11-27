import { expect, it } from "vite-plus/test";
import { PcmPlayerQueue, type PcmPlayerPosition } from "./pcmPlayerQueue";

type Step =
  | { readonly enqueue: readonly number[]; readonly item: string }
  /** Reads as many samples as it expects; zeros are what an empty queue plays. */
  | { readonly read: readonly number[]; readonly real: number }
  | { readonly buffered: number }
  | { readonly flush: PcmPlayerPosition };

const nothing: PcmPlayerPosition = { itemId: null, positionSamples: 0, pending: false };

it.each<{ readonly name: string; readonly capacity: number; readonly steps: readonly Step[] }>([
  {
    name: "plays two items in order across the end of the ring",
    capacity: 4,
    steps: [
      { enqueue: [1, 2, 3], item: "a" },
      { read: [1, 2], real: 2 },
      { enqueue: [-4, 5, 6], item: "b" },
      { buffered: 4 },
      { read: [3, -4], real: 2 },
      { flush: { itemId: "b", positionSamples: 1, pending: true } },
    ],
  },
  {
    name: "cuts an item in the middle and drops the rest",
    capacity: 8,
    steps: [
      { enqueue: [1, 2, 3, 4, 5, 6], item: "a" },
      { read: [1, 2, 3, 4], real: 4 },
      { flush: { itemId: "a", positionSamples: 4, pending: true } },
      { buffered: 0 },
      { read: [0, 0], real: 0 },
      { flush: nothing },
    ],
  },
  {
    name: "reports the full length of a last item that already played",
    capacity: 8,
    steps: [
      { enqueue: [1, 2], item: "a" },
      { enqueue: [3, 4, 5], item: "b" },
      { read: [1, 2, 3, 4, 5, 0], real: 5 },
      { flush: { itemId: "b", positionSamples: 3, pending: false } },
    ],
  },
  { name: "reports no item when nothing was enqueued", capacity: 8, steps: [{ flush: nothing }] },
  {
    name: "plays zeros on underrun without counting them as played",
    capacity: 8,
    steps: [
      { enqueue: [1, 2], item: "a" },
      { read: [1, 2, 0, 0], real: 2 },
      { read: [0, 0], real: 0 },
      { enqueue: [3], item: "a" },
      { read: [3, 0], real: 1 },
      { flush: { itemId: "a", positionSamples: 3, pending: false } },
    ],
  },
  {
    name: "drops the oldest samples on overflow and counts them as position",
    capacity: 4,
    steps: [
      { enqueue: [1, 2, 3], item: "a" },
      { enqueue: [4, 5, 6], item: "a" },
      { buffered: 4 },
      { read: [3], real: 1 },
      { flush: { itemId: "a", positionSamples: 3, pending: true } },
    ],
  },
  {
    name: "keeps the end of a chunk larger than the ring",
    capacity: 4,
    steps: [
      { enqueue: [1], item: "a" },
      { enqueue: [2, 3, 4, 5, 6, 7], item: "b" },
      { read: [4, 5, 6, 7], real: 4 },
      { flush: { itemId: "b", positionSamples: 6, pending: false } },
    ],
  },
])("$name", ({ capacity, steps }) => {
  const queue = new PcmPlayerQueue(capacity);
  for (const step of steps) {
    if ("enqueue" in step) {
      queue.enqueue(Int16Array.from(step.enqueue), step.item);
    } else if ("read" in step) {
      const output = new Float32Array(step.read.length).fill(Number.NaN);
      expect(queue.read(output)).toBe(step.real);
      expect(Array.from(output, (sample) => sample * 32_768)).toEqual(step.read);
    } else if ("buffered" in step) {
      expect(queue.bufferedSamples).toBe(step.buffered);
    } else {
      expect(queue.flush()).toEqual(step.flush);
    }
  }
});
