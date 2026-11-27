/** Where playback is, in samples of one item. */
export type PcmPlayerPosition = {
  /** The earliest item with unplayed samples, else the last item that played, else null. */
  readonly itemId: string | null;
  /** Samples of that item that left the queue, played or skipped. */
  readonly positionSamples: number;
  readonly pending: boolean;
};

/** A bounded FIFO of PCM16 samples that knows which item each sample belongs to. */
export class PcmPlayerQueue {
  private readonly ring: Int16Array;
  private readIndex = 0;
  private count = 0;
  // Oldest first. The last one stays after it drains, so an item still arriving keeps its position.
  private segments: Array<{ readonly itemId: string; remaining: number; position: number }> = [];

  constructor(capacitySamples: number) {
    this.ring = new Int16Array(capacitySamples);
  }

  get bufferedSamples(): number {
    return this.count;
  }

  /** Past capacity the oldest unplayed samples are dropped and counted as position. */
  enqueue(pcm: Int16Array, itemId: string): void {
    if (pcm.length === 0) return;
    const capacity = this.ring.length;
    let segment = this.segments[this.segments.length - 1];
    if (segment?.itemId !== itemId) {
      segment = { itemId, remaining: 0, position: 0 };
      this.segments.push(segment);
    }
    const overflow = Math.max(0, this.count + pcm.length - capacity);
    const queued = Math.min(overflow, this.count);
    this.advance(queued);
    // What the ring cannot hold even when empty is the start of this chunk.
    const skipped = overflow - queued;
    segment.position += skipped;
    let write = (this.readIndex + this.count) % capacity;
    for (let i = skipped; i < pcm.length; i++) {
      this.ring[write] = pcm[i]!;
      write = write + 1 === capacity ? 0 : write + 1;
    }
    segment.remaining += pcm.length - skipped;
    this.count += pcm.length - skipped;
  }

  /** Fills `output` with the next samples as floats, zeros once empty. Returns real samples written. */
  read(output: Float32Array): number {
    const written = Math.min(output.length, this.count);
    let read = this.readIndex;
    for (let i = 0; i < written; i++) {
      output[i] = this.ring[read]! / 32_768;
      read = read + 1 === this.ring.length ? 0 : read + 1;
    }
    output.fill(0, written);
    this.advance(written);
    return written;
  }

  /** Reports the position, then drops everything. */
  flush(): PcmPlayerPosition {
    const unplayed = this.segments.find((segment) => segment.remaining > 0);
    const segment = unplayed ?? this.segments[this.segments.length - 1];
    this.segments = [];
    this.count = 0;
    this.readIndex = 0;
    return segment
      ? {
          itemId: segment.itemId,
          positionSamples: segment.position,
          pending: unplayed !== undefined,
        }
      : { itemId: null, positionSamples: 0, pending: false };
  }

  /** Moves the read side past `samples` buffered samples, played or skipped alike. */
  private advance(samples: number) {
    this.readIndex = (this.readIndex + samples) % this.ring.length;
    this.count -= samples;
    while (samples > 0) {
      const segment = this.segments[0]!;
      const taken = Math.min(samples, segment.remaining);
      segment.remaining -= taken;
      segment.position += taken;
      samples -= taken;
      if (segment.remaining === 0 && this.segments.length > 1) this.segments.shift();
    }
  }
}
