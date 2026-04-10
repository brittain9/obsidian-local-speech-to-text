import { describe, expect, it } from 'vitest';

import {
  downsampleBuffer,
  encodePcm16WaveFile,
  float32ToInt16Pcm,
  mergeSampleChunks,
} from '../src/audio/wav-encoder';

describe('wav-encoder', () => {
  it('merges sequential float sample chunks', () => {
    const mergedSamples = Array.from(
      mergeSampleChunks([new Float32Array([0.1, 0.2]), new Float32Array([0.3, 0.4])]),
    );

    expect(mergedSamples).toHaveLength(4);
    expect(mergedSamples[0]).toBeCloseTo(0.1);
    expect(mergedSamples[1]).toBeCloseTo(0.2);
    expect(mergedSamples[2]).toBeCloseTo(0.3);
    expect(mergedSamples[3]).toBeCloseTo(0.4);
  });

  it('downsamples by averaging source windows', () => {
    const downsampled = downsampleBuffer(new Float32Array([1, 2, 3, 4, 5, 6]), 6, 3);

    expect(Array.from(downsampled)).toEqual([1.5, 3.5, 5.5]);
  });

  it('encodes a PCM16 WAV header with the expected sample rate', () => {
    const pcmSamples = float32ToInt16Pcm(new Float32Array([0, 0.5, -0.5]));
    const wavBytes = encodePcm16WaveFile(pcmSamples, 16_000, 1);
    const view = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength);

    expect(String.fromCharCode(...wavBytes.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wavBytes.slice(8, 12))).toBe('WAVE');
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(22, true)).toBe(1);
  });
});
