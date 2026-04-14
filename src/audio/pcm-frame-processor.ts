import { PCM_FRAME_DURATION_MS, PCM_SAMPLE_RATE_HZ } from '../shared/pcm-format';

export interface PcmFrameProcessorOptions {
  samplesPerFrame?: number;
  sourceSampleRate: number;
  targetSampleRate?: number;
}

export class PcmFrameProcessor {
  private frameOffset = 0;
  private inputSampleIndex = 0;
  private nextOutputPosition = 0;
  private previousSample: number | null = null;
  private previousSamplePosition = 0;

  private readonly frameBuffer: Int16Array;
  private readonly sourceSamplesPerOutput: number;

  constructor(options: PcmFrameProcessorOptions) {
    const targetSampleRate = options.targetSampleRate ?? PCM_SAMPLE_RATE_HZ;
    const samplesPerFrame =
      options.samplesPerFrame ?? (targetSampleRate / 1_000) * PCM_FRAME_DURATION_MS;

    if (
      !Number.isFinite(options.sourceSampleRate) ||
      options.sourceSampleRate <= 0 ||
      !Number.isFinite(targetSampleRate) ||
      targetSampleRate <= 0
    ) {
      throw new Error('PCM frame processor sample rates must be positive numbers.');
    }

    if (!Number.isInteger(samplesPerFrame) || samplesPerFrame <= 0) {
      throw new Error('PCM frame processor samplesPerFrame must be a positive integer.');
    }

    this.frameBuffer = new Int16Array(samplesPerFrame);
    this.sourceSamplesPerOutput = options.sourceSampleRate / targetSampleRate;
  }

  push(inputSamples: Float32Array): Int16Array[] {
    const completedFrames: Int16Array[] = [];

    for (const currentSample of inputSamples) {
      const currentPosition = this.inputSampleIndex;

      if (this.previousSample === null) {
        this.previousSample = currentSample;
        this.previousSamplePosition = currentPosition;
        this.inputSampleIndex += 1;
        continue;
      }

      while (this.nextOutputPosition <= currentPosition) {
        const sampleOffset =
          (this.nextOutputPosition - this.previousSamplePosition) /
          (currentPosition - this.previousSamplePosition);
        const interpolatedSample =
          this.previousSample + (currentSample - this.previousSample) * sampleOffset;

        this.frameBuffer[this.frameOffset] = floatToPcm16(interpolatedSample);
        this.frameOffset += 1;

        if (this.frameOffset === this.frameBuffer.length) {
          completedFrames.push(this.frameBuffer.slice());
          this.frameOffset = 0;
        }

        this.nextOutputPosition += this.sourceSamplesPerOutput;
      }

      this.previousSample = currentSample;
      this.previousSamplePosition = currentPosition;
      this.inputSampleIndex += 1;
    }

    return completedFrames;
  }

  reset(): void {
    this.frameBuffer.fill(0);
    this.frameOffset = 0;
    this.inputSampleIndex = 0;
    this.nextOutputPosition = 0;
    this.previousSample = null;
    this.previousSamplePosition = 0;
  }
}

export function mixChannelsToMono(inputChannels: Float32Array[]): Float32Array {
  if (inputChannels.length === 0) {
    return new Float32Array(0);
  }

  if (inputChannels.length === 1) {
    const firstChannel = inputChannels[0];

    return firstChannel === undefined ? new Float32Array(0) : new Float32Array(firstChannel);
  }

  const sampleCount = inputChannels[0]?.length ?? 0;
  const output = new Float32Array(sampleCount);

  for (const channel of inputChannels) {
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      output[sampleIndex] = (output[sampleIndex] ?? 0) + (channel[sampleIndex] ?? 0);
    }
  }

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    output[sampleIndex] = (output[sampleIndex] ?? 0) / inputChannels.length;
  }

  return output;
}

export function clearChannels(channels: Float32Array[] | undefined): void {
  if (channels === undefined) {
    return;
  }

  for (const channel of channels) {
    channel.fill(0);
  }
}

function floatToPcm16(sample: number): number {
  const clampedSample = Math.max(-1, Math.min(1, sample));

  return clampedSample < 0
    ? Math.round(clampedSample * 0x8000)
    : Math.round(clampedSample * 0x7fff);
}
