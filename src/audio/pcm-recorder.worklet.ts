import { PCM_RECORDER_WORKLET_NAME } from './pcm-recorder-worklet-shared';

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;

  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor,
): void;

class PcmRecorderProcessor extends AudioWorkletProcessor {
  override process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>,
  ): boolean {
    const inputChannels = inputs[0];
    const outputChannels = outputs[0];

    if (inputChannels === undefined || inputChannels.length === 0) {
      clearChannels(outputChannels);
      return true;
    }

    const monoChunk = mixChannelsToMono(inputChannels);
    this.port.postMessage(monoChunk, [monoChunk.buffer]);
    clearChannels(outputChannels);

    return true;
  }
}

registerProcessor(PCM_RECORDER_WORKLET_NAME, PcmRecorderProcessor);

function mixChannelsToMono(inputChannels: Float32Array[]): Float32Array {
  if (inputChannels.length === 1) {
    const firstChannel = inputChannels[0];

    if (firstChannel === undefined) {
      return new Float32Array(0);
    }

    return new Float32Array(firstChannel);
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

function clearChannels(channels: Float32Array[] | undefined): void {
  if (channels === undefined) {
    return;
  }

  for (const channel of channels) {
    channel.fill(0);
  }
}
