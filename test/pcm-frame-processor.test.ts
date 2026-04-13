import { describe, expect, it } from 'vitest';

import { mixChannelsToMono, PcmFrameProcessor } from '../src/audio/pcm-frame-processor';
import { PCM_SAMPLES_PER_FRAME } from '../src/shared/pcm-format';

describe('PcmFrameProcessor', () => {
  it('emits fixed 20 ms PCM16 frames at 16 kHz', () => {
    const processor = new PcmFrameProcessor({
      sourceSampleRate: 48_000,
    });
    const frames = processor.push(new Float32Array(48_000 / 5).fill(0.5));

    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]?.length).toBe(PCM_SAMPLES_PER_FRAME);
  });

  it('mixes multi-channel input to mono', () => {
    const mono = mixChannelsToMono([new Float32Array([1, 0, -1]), new Float32Array([0, 1, -1])]);

    expect(Array.from(mono)).toEqual([0.5, 0.5, -1]);
  });
});
