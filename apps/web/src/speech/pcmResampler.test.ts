import { expect, it } from "vite-plus/test";

import { PcmResampler } from "./pcmResampler";

it("interpolates a microphone below the target rate up to it, across capture blocks", () => {
  // A Bluetooth headset in hands-free profile opens at 16 kHz; voice mode sends 24 kHz.
  const resampler = new PcmResampler(16_000, 24_000);
  const ramp = Float32Array.from({ length: 1_600 }, (_, i) => i / 1_600);

  const output = [...resampler.push(ramp.subarray(0, 700)), ...resampler.push(ramp.subarray(700))];

  expect(output).toHaveLength(2_400);
  // Each output sample sits two thirds of an input sample after the one before, one sample late.
  output
    .slice(2)
    .forEach((value, i) => expect(value).toBeCloseTo(((i + 2) * (2 / 3) - 1) / 1_600, 6));
  expect(resampler.flush()).toEqual(new Float32Array());
});
