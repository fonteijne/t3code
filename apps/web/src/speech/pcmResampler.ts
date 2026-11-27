const TARGET_RATE = 16_000;

/**
 * Low-pass before downsampling, preserving filter and sample phase across capture blocks. A rate
 * below the target, such as a headset's 16 kHz hands-free profile, is interpolated up instead.
 */
export class PcmResampler {
  private readonly coefficients: Float64Array;
  private readonly history: Float32Array;
  private position = 0;
  private phase = 0;
  private previous = 0;
  private readonly ratio: number;
  private readonly sampleRate: number;
  private readonly targetRate: number;

  constructor(sampleRate: number, targetRate = TARGET_RATE) {
    this.sampleRate = sampleRate;
    this.targetRate = targetRate;
    this.ratio = sampleRate / targetRate;
    this.coefficients = new Float64Array(sampleRate <= targetRate ? 1 : 63);
    this.history = new Float32Array(this.coefficients.length);
    const middle = (this.coefficients.length - 1) / 2;
    // 0.45 of the output rate: 7_200 Hz for dictation's 16 kHz.
    const cutoff = (targetRate * 9) / 20 / sampleRate;
    let sum = 0;
    for (let i = 0; i < this.coefficients.length; i++) {
      const x = i - middle;
      const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
      const window = middle === 0 ? 1 : 0.54 - 0.46 * Math.cos((Math.PI * i) / middle);
      this.coefficients[i] = sinc * window;
      sum += this.coefficients[i]!;
    }
    for (let i = 0; i < this.coefficients.length; i++) this.coefficients[i]! /= sum;
  }

  push(samples: Float32Array): Float32Array {
    const output: number[] = [];
    if (this.ratio < 1) {
      // The phase counts in integer steps of the input rate, so it never drifts.
      for (const sample of samples) {
        for (; this.phase < this.targetRate; this.phase += this.sampleRate)
          output.push(this.previous + ((sample - this.previous) * this.phase) / this.targetRate);
        this.phase -= this.targetRate;
        this.previous = sample;
      }
      return Float32Array.from(output);
    }
    for (const sample of samples) {
      this.history[this.position] = sample;
      this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        let value = 0;
        for (let tap = 0; tap < this.coefficients.length; tap++) {
          const index = (this.position - tap + this.history.length) % this.history.length;
          value += this.history[index]! * this.coefficients[tap]!;
        }
        output.push(Math.max(-1, Math.min(1, value)));
      }
      this.position = (this.position + 1) % this.history.length;
    }
    return Float32Array.from(output);
  }

  flush(): Float32Array {
    return this.coefficients.length === 1
      ? new Float32Array()
      : this.push(new Float32Array(this.history.length - 1));
  }
}

/** Float samples in [-1, 1] as 16-bit PCM. */
export function floatToPcm16(samples: Float32Array, length: number): Int16Array<ArrayBuffer> {
  const pcm = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]!));
    pcm[i] = Math.round(sample < 0 ? sample * 32_768 : sample * 32_767);
  }
  return pcm;
}
