import { expect, it } from "vite-plus/test";
import { type AgentCaption, makePacedOutput, type PacedChunk } from "./outputPacing.ts";

const LEAD_MS = 5_000;
const pcm = (milliseconds: number) => new Uint8Array(milliseconds * 48);
const make = (maxQueuedBytes = 10_000_000) => makePacedOutput({ leadMs: LEAD_MS, maxQueuedBytes });

const delta = (itemId: string, text: string): AgentCaption => ({
  type: "caption-delta",
  itemId,
  delta: text,
});
const done = (itemId: string, text: string): AgentCaption => ({
  type: "caption-done",
  itemId,
  text,
});

/** Chunks as short strings: `start a`, `audio 9600`, `caption-delta a hi`, `done a`. */
const describeChunks = (chunks: ReadonlyArray<PacedChunk>) =>
  chunks.map((chunk) => {
    switch (chunk.type) {
      case "audio":
        return `audio ${chunk.bytes.byteLength}`;
      case "caption":
        return chunk.event.type === "caption-delta"
          ? `caption-delta ${chunk.event.itemId} ${chunk.event.delta}`
          : `caption-done ${chunk.event.itemId} ${chunk.event.text}`;
      default:
        return `${chunk.type} ${chunk.itemId}`;
    }
  });

const audioMs = (chunks: ReadonlyArray<PacedChunk>) =>
  chunks.reduce(
    (total, chunk) => total + (chunk.type === "audio" ? chunk.bytes.byteLength : 0),
    0,
  ) / 48;

it("sends the lead at once and the rest as the clock advances", () => {
  const output = make();
  expect(output.push("a", pcm(7_000))).toBe("queued");
  output.end("a");

  const first = output.take(1_000, true);
  expect(first.chunks[0]).toEqual({ type: "start", itemId: "a" });
  expect(audioMs(first.chunks)).toBe(LEAD_MS);
  for (const chunk of first.chunks) {
    if (chunk.type !== "audio") continue;
    expect(chunk.bytes.byteLength % 2).toBe(0);
    expect(chunk.bytes.byteLength).toBeLessThanOrEqual(9_600);
  }
  expect(first.chunks.some((chunk) => chunk.type === "done")).toBe(false);
  expect(first.nextAtMs).toBe(1_100);

  // Nothing more while the client still holds the whole lead.
  expect(output.take(1_000, true).chunks).toEqual([]);

  const held = output.take(2_000, false);
  expect(held.chunks).toEqual([]);
  expect(held.nextAtMs).toBe(2_250);

  const second = output.take(2_000, true);
  expect(audioMs(second.chunks)).toBe(1_000);

  const last = output.take(3_000, true);
  expect(audioMs(last.chunks)).toBe(1_000);
  expect(last.chunks.at(-1)).toEqual({ type: "done", itemId: "a" });
  expect(last.nextAtMs).toBeUndefined();
});

it("flush drops what was not sent, closes the items and estimates the position", () => {
  const output = make();
  output.push("a", pcm(1_000));
  output.end("a");
  output.push("b", pcm(8_000));
  output.push("c", pcm(400));
  // a plays 0..1000, b starts at 1000 and has 4000 of its 8000 ms sent.
  expect(audioMs(output.take(0, true).chunks)).toBe(LEAD_MS);

  expect(output.flush(2_500)).toEqual({
    sent: [
      { itemId: "a", sentMs: 1_000 },
      { itemId: "b", sentMs: 4_000 },
    ],
    unsent: ["c"],
    estimate: { itemId: "b", playedMs: 1_500 },
  });
  expect(output.push("b", pcm(200))).toBe("closed");
  expect(output.push("c", pcm(200))).toBe("closed");
  expect(output.take(2_500, true)).toEqual({ chunks: [], nextAtMs: undefined });

  // The clock restarts at the flush: a new item is sent at once.
  output.push("d", pcm(400));
  output.end("d");
  expect(describeChunks(output.take(2_500, true).chunks)).toEqual([
    "start d",
    "audio 9600",
    "audio 9600",
    "done d",
  ]);
  expect(output.flush(10_000)).toEqual({
    sent: [],
    unsent: [],
    estimate: { itemId: null, playedMs: 0 },
  });
  // Sent in full and played by the clock, but inside the lead's slack: listed, nothing playing.
  output.push("e", pcm(400));
  output.end("e");
  output.take(10_000, true);
  expect(output.flush(11_000)).toEqual({
    sent: [{ itemId: "e", sentMs: 400 }],
    unsent: [],
    estimate: { itemId: null, playedMs: 0 },
  });
});

it("refuses audio beyond the limit once and keeps what it holds", () => {
  const output = make(pcm(1_000).byteLength);
  expect(output.push("a", pcm(600))).toBe("queued");
  expect(output.push("a", pcm(600))).toBe("overflow");
  expect(output.push("a", pcm(200))).toBe("closed");

  // The held audio plays out and the bracket closes without an `end`.
  expect(describeChunks(output.take(0, true).chunks)).toEqual([
    "start a",
    "audio 9600",
    "audio 9600",
    "audio 9600",
    "done a",
  ]);
});

it("keeps items in order and delivers captions where the client can place them", () => {
  const output = make();
  output.push("a", pcm(200));
  // An odd delta: the half sample waits for the next one.
  output.push("b", new Uint8Array(9_601));
  output.caption("b", delta("b", "early"));
  expect(describeChunks(output.take(0, true).chunks)).toEqual([
    "start a",
    "audio 9600",
    // b has audio waiting, so a's bracket closes although a never ended.
    "done a",
    "start b",
    "caption-delta b early",
    "audio 9600",
  ]);
  output.push("b", new Uint8Array(9_599));
  output.caption("b", delta("b", "open"));
  output.end("b");
  expect(describeChunks(output.take(0, true).chunks)).toEqual([
    "caption-delta b open",
    "audio 9600",
    "done b",
  ]);
  // The endpoint's own order: the audio ends, then the final caption arrives.
  output.caption("b", done("b", "all of it"));
  expect(describeChunks(output.take(0, true).chunks)).toEqual(["caption-done b all of it"]);

  output.flush(0);
  output.caption("b", done("b", "after the cut"));
  expect(output.take(0, true).chunks).toEqual([]);

  // Caption-only items: the ninth drops the first.
  for (let index = 1; index <= 9; index++) {
    output.caption(`only-${index}`, delta(`only-${index}`, `text ${index}`));
  }
  output.push("only-1", pcm(200));
  output.push("only-2", pcm(200));
  output.end("only-1");
  expect(describeChunks(output.take(0, true).chunks)).toEqual([
    "start only-1",
    "audio 9600",
    "done only-1",
    "start only-2",
    "caption-delta only-2 text 2",
    "audio 9600",
  ]);

  // The response ends: a waiting item with audio survives, the caption-only ones go.
  output.push("waiting", pcm(200));
  output.caption("waiting", delta("waiting", "kept"));
  output.endAll();
  output.push("only-3", pcm(200));
  output.end("only-3");
  expect(describeChunks(output.take(0, true).chunks)).toEqual([
    "done only-2",
    "start waiting",
    "caption-delta waiting kept",
    "audio 9600",
    "done waiting",
    "start only-3",
    "audio 9600",
    "done only-3",
  ]);
});
