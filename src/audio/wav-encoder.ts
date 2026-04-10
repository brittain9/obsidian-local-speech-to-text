export const TARGET_WAV_CHANNEL_COUNT = 1;
export const TARGET_WAV_BITS_PER_SAMPLE = 16;
export const TARGET_WAV_SAMPLE_RATE = 16_000;

export function mergeSampleChunks(chunks: readonly Float32Array[]): Float32Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(totalLength);

  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

export function normalizeAudioBufferToMono(inputBuffer: AudioBuffer): Float32Array {
  const channelCount = inputBuffer.numberOfChannels;

  if (channelCount <= 0) {
    throw new Error('Audio buffer does not contain any channels.');
  }

  const monoSamples = new Float32Array(inputBuffer.length);

  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const channelData = inputBuffer.getChannelData(channelIndex);

    for (let sampleIndex = 0; sampleIndex < channelData.length; sampleIndex += 1) {
      const currentValue = monoSamples[sampleIndex];
      const channelValue = channelData[sampleIndex];

      monoSamples[sampleIndex] = (currentValue ?? 0) + (channelValue ?? 0) / channelCount;
    }
  }

  return monoSamples;
}

export function downsampleBuffer(
  samples: Float32Array,
  sourceSampleRate: number,
  targetSampleRate: number,
): Float32Array {
  if (!Number.isInteger(sourceSampleRate) || sourceSampleRate <= 0) {
    throw new Error(`Invalid source sample rate: ${sourceSampleRate}`);
  }

  if (!Number.isInteger(targetSampleRate) || targetSampleRate <= 0) {
    throw new Error(`Invalid target sample rate: ${targetSampleRate}`);
  }

  if (sourceSampleRate === targetSampleRate) {
    return samples.slice();
  }

  if (targetSampleRate > sourceSampleRate) {
    throw new Error('Upsampling is not supported by the WAV encoder.');
  }

  const sampleRateRatio = sourceSampleRate / targetSampleRate;
  const outputLength = Math.max(1, Math.round(samples.length / sampleRateRatio));
  const output = new Float32Array(outputLength);
  let inputIndex = 0;

  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const nextInputIndex = Math.min(
      samples.length,
      Math.round((outputIndex + 1) * sampleRateRatio),
    );
    let sum = 0;
    let count = 0;

    for (let index = inputIndex; index < nextInputIndex; index += 1) {
      sum += samples[index] ?? 0;
      count += 1;
    }

    if (count === 0) {
      output[outputIndex] = samples[Math.min(inputIndex, samples.length - 1)] ?? 0;
    } else {
      output[outputIndex] = sum / count;
    }

    inputIndex = nextInputIndex;
  }

  return output;
}

export function float32ToInt16Pcm(samples: Float32Array): Int16Array {
  const pcmSamples = new Int16Array(samples.length);

  for (let index = 0; index < samples.length; index += 1) {
    const sample = clampToUnitRange(samples[index] ?? 0);
    pcmSamples[index] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
  }

  return pcmSamples;
}

export function encodePcm16WaveFile(
  pcmSamples: Int16Array,
  sampleRate: number,
  channelCount: number,
): Uint8Array {
  if (channelCount !== TARGET_WAV_CHANNEL_COUNT) {
    throw new Error(`Unsupported channel count for PCM16 WAV encoding: ${channelCount}`);
  }

  const bytesPerSample = TARGET_WAV_BITS_PER_SAMPLE / 8;
  const dataByteLength = pcmSamples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataByteLength);
  const view = new DataView(buffer);
  const output = new Uint8Array(buffer);

  writeAsciiString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataByteLength, true);
  writeAsciiString(view, 8, 'WAVE');
  writeAsciiString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, TARGET_WAV_BITS_PER_SAMPLE, true);
  writeAsciiString(view, 36, 'data');
  view.setUint32(40, dataByteLength, true);

  for (let index = 0; index < pcmSamples.length; index += 1) {
    view.setInt16(44 + index * bytesPerSample, pcmSamples[index] ?? 0, true);
  }

  return output;
}

function clampToUnitRange(sample: number): number {
  if (sample > 1) {
    return 1;
  }

  if (sample < -1) {
    return -1;
  }

  return sample;
}

function writeAsciiString(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}
