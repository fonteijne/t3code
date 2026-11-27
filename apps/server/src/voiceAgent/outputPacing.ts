import type { VoiceAgentEvent } from "@t3tools/contracts";

export type AgentCaption = Extract<
  VoiceAgentEvent,
  { readonly type: "caption-delta" | "caption-done" }
>;

export type PacedChunk =
  | { readonly type: "start"; readonly itemId: string }
  | { readonly type: "audio"; readonly bytes: Uint8Array }
  | { readonly type: "caption"; readonly event: AgentCaption }
  | { readonly type: "done"; readonly itemId: string };

export interface FlushSnapshot {
  /** Items with audio sent and possibly not heard in full, oldest first. */
  readonly sent: ReadonlyArray<{ readonly itemId: string; readonly sentMs: number }>;
  /** Items generated but never started. */
  readonly unsent: ReadonlyArray<string>;
  /** Where playback stood by the pacing clock, for a client that does not report. */
  readonly estimate: { readonly itemId: string | null; readonly playedMs: number };
}

/** 200 ms of 24 kHz 16-bit mono PCM. */
const FRAME_BYTES = 9_600;
const BYTES_PER_MS = 48;
const WAKE_AFTER_LEAD_MS = 100;
const WAKE_WHILE_HELD_MS = 250;
const MAX_EARLY_CAPTION_LENGTH = 16 * 1024;
const MAX_CAPTION_ONLY_ITEMS = 8;
const MAX_REMEMBERED_CUT_ITEMS = 64;

interface PacedItem {
  readonly itemId: string;
  /** `cut` items are not kept here; their ids are remembered apart. */
  state: "pending" | "open" | "finished";
  /** Queued for sending, in order. Always in `order` once true. */
  hasAudio: boolean;
  ended: boolean;
  /** Refuses further audio after an overflow. */
  full: boolean;
  frames: Array<Uint8Array>;
  carry: number | undefined;
  earlyCaptions: Array<AgentCaption>;
  earlyCaptionLength: number;
  sentBytes: number;
  startAtMs: number;
}

const captionLength = (event: AgentCaption) =>
  event.type === "caption-delta" ? event.delta.length : event.text.length;

/**
 * The agent audio a session holds for one client: bounded, flushable, and released on one
 * playback clock so the client never buffers more than `leadMs`.
 */
export const makePacedOutput = (limits: {
  readonly leadMs: number;
  readonly maxQueuedBytes: number;
}): {
  /** "closed": the item was cut by a flush or cancel, drop the audio. */
  readonly push: (itemId: string, pcm: Uint8Array) => "queued" | "closed" | "overflow";
  readonly caption: (itemId: string, event: AgentCaption) => void;
  readonly end: (itemId: string) => void;
  /** Every item that still expects audio is ended (its response is over). */
  readonly endAll: () => void;
  readonly take: (
    nowMs: number,
    audioAllowed: boolean,
  ) => { readonly chunks: ReadonlyArray<PacedChunk>; readonly nextAtMs: number | undefined };
  readonly flush: (nowMs: number) => FlushSnapshot;
} => {
  const items = new Map<string, PacedItem>();
  /** Items with audio that are not finished, in the order their first audio arrived. */
  let order: Array<PacedItem> = [];
  /** Captions of started items, written by the next `take`. */
  let readyCaptions: Array<AgentCaption> = [];
  const cutIds = new Set<string>();
  let queuedBytes = 0;
  let playheadMs = 0;

  const known = (itemId: string): PacedItem => {
    const existing = items.get(itemId);
    if (existing !== undefined) return existing;
    const item: PacedItem = {
      itemId,
      state: "pending",
      hasAudio: false,
      ended: false,
      full: false,
      frames: [],
      carry: undefined,
      earlyCaptions: [],
      earlyCaptionLength: 0,
      sentBytes: 0,
      startAtMs: 0,
    };
    items.set(itemId, item);
    return item;
  };

  const forgetCaptionOnly = (keep: number) => {
    let count = 0;
    for (const item of items.values()) if (!item.hasAudio && item.state === "pending") count++;
    for (const item of items.values()) {
      if (count <= keep) return;
      if (item.hasAudio || item.state !== "pending") continue;
      items.delete(item.itemId);
      count--;
    }
  };

  const cut = (itemId: string) => {
    items.delete(itemId);
    cutIds.add(itemId);
    if (cutIds.size <= MAX_REMEMBERED_CUT_ITEMS) return;
    for (const oldest of cutIds) {
      cutIds.delete(oldest);
      return;
    }
  };

  const sentMs = (item: PacedItem) => Math.floor(item.sentBytes / BYTES_PER_MS);

  /** Heard for certain, with the lead as slack for a slow client. */
  const forgetHeard = (nowMs: number) => {
    for (const item of items.values()) {
      if (item.state !== "finished") continue;
      if (item.startAtMs + sentMs(item) + limits.leadMs <= nowMs) items.delete(item.itemId);
    }
  };

  const push = (itemId: string, pcm: Uint8Array) => {
    if (cutIds.has(itemId)) return "closed";
    const item = known(itemId);
    // A finished item's bracket is closed on the client; audio for it cannot be sent any more.
    if (item.full || item.state === "finished") return "closed";
    let data = pcm;
    if (item.carry !== undefined) {
      data = new Uint8Array(pcm.byteLength + 1);
      data[0] = item.carry;
      data.set(pcm, 1);
    }
    const even = data.byteLength - (data.byteLength % 2);
    if (queuedBytes + even > limits.maxQueuedBytes) {
      item.full = true;
      item.ended = true;
      item.carry = undefined;
      return "overflow";
    }
    if (!item.hasAudio) {
      item.hasAudio = true;
      order.push(item);
    }
    for (let offset = 0; offset < even; offset += FRAME_BYTES) {
      item.frames.push(data.subarray(offset, Math.min(offset + FRAME_BYTES, even)));
    }
    item.carry = even < data.byteLength ? data[even] : undefined;
    queuedBytes += even;
    return "queued";
  };

  const caption = (itemId: string, event: AgentCaption) => {
    if (cutIds.has(itemId)) return;
    const item = known(itemId);
    if (item.state !== "pending") {
      readyCaptions.push(event);
      return;
    }
    // The final caption carries the whole text, so the deltas kept before it are not needed.
    if (event.type === "caption-done") {
      item.earlyCaptions = [];
      item.earlyCaptionLength = 0;
    }
    const length = captionLength(event);
    if (item.earlyCaptionLength + length <= MAX_EARLY_CAPTION_LENGTH) {
      item.earlyCaptions.push(event);
      item.earlyCaptionLength += length;
    }
    if (!item.hasAudio) forgetCaptionOnly(MAX_CAPTION_ONLY_ITEMS);
  };

  const end = (itemId: string) => {
    const item = items.get(itemId);
    if (item !== undefined) item.ended = true;
  };

  const endAll = () => {
    for (const item of order) item.ended = true;
    forgetCaptionOnly(0);
  };

  const take = (nowMs: number, audioAllowed: boolean) => {
    forgetHeard(nowMs);
    const chunks: Array<PacedChunk> = [];
    for (const event of readyCaptions) chunks.push({ type: "caption", event });
    readyCaptions = [];
    let nextAtMs: number | undefined;
    while (true) {
      const head = order[0];
      if (head === undefined) break;
      while (head.frames.length > 0) {
        if (!audioAllowed) {
          nextAtMs = nowMs + WAKE_WHILE_HELD_MS;
          break;
        }
        const startMs = Math.max(playheadMs, nowMs);
        if (startMs - nowMs >= limits.leadMs) {
          nextAtMs = playheadMs - limits.leadMs + WAKE_AFTER_LEAD_MS;
          break;
        }
        if (head.state === "pending") {
          head.state = "open";
          head.startAtMs = startMs;
          chunks.push({ type: "start", itemId: head.itemId });
          for (const event of head.earlyCaptions) chunks.push({ type: "caption", event });
          head.earlyCaptions = [];
          head.earlyCaptionLength = 0;
        }
        const bytes = head.frames.shift()!;
        chunks.push({ type: "audio", bytes });
        head.sentBytes += bytes.byteLength;
        queuedBytes -= bytes.byteLength;
        playheadMs = startMs + bytes.byteLength / BYTES_PER_MS;
      }
      if (head.frames.length > 0) break;
      // Close the bracket before the next item when the head only waits for audio that a later
      // item has already overtaken.
      const overtaken = order.some((item) => item !== head && item.frames.length > 0);
      if (!head.ended && !overtaken) break;
      order.shift();
      if (head.state === "open") {
        head.state = "finished";
        chunks.push({ type: "done", itemId: head.itemId });
      } else {
        // Never started: all it ever held was half a sample.
        items.delete(head.itemId);
      }
    }
    return { chunks, nextAtMs };
  };

  const flush = (nowMs: number): FlushSnapshot => {
    forgetHeard(nowMs);
    const sent: Array<{ readonly itemId: string; readonly sentMs: number }> = [];
    const unsent: Array<string> = [];
    let estimate: FlushSnapshot["estimate"] = { itemId: null, playedMs: 0 };
    const started = [...items.values()]
      .filter((item) => item.state !== "pending")
      .sort((left, right) => left.startAtMs - right.startAtMs);
    for (const item of started) {
      const itemSentMs = sentMs(item);
      sent.push({ itemId: item.itemId, sentMs: itemSentMs });
      if (estimate.itemId === null && nowMs < item.startAtMs + itemSentMs) {
        estimate = {
          itemId: item.itemId,
          playedMs: Math.min(Math.max(Math.floor(nowMs - item.startAtMs), 0), itemSentMs),
        };
      }
    }
    for (const item of items.values()) if (item.state === "pending") unsent.push(item.itemId);
    for (const itemId of items.keys()) cut(itemId);
    order = [];
    readyCaptions = [];
    queuedBytes = 0;
    playheadMs = nowMs;
    return { sent, unsent, estimate };
  };

  return { push, caption, end, endAll, take, flush };
};
