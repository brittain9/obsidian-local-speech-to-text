import { PCM_SAMPLE_RATE_HZ, PCM_SAMPLES_PER_FRAME } from '../shared/pcm-format';
import { clearChannels, mixChannelsToMono, PcmFrameProcessor } from './pcm-frame-processor';
import { PCM_RECORDER_WORKLET_NAME } from './pcm-recorder-worklet-shared';

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;

  constructor(options?: AudioWorkletNodeOptions);

  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;

declare const sampleRate: number;

class PcmRecorderProcessor extends AudioWorkletProcessor {
  private readonly frameProcessor: PcmFrameProcessor;

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    this.frameProcessor = new PcmFrameProcessor({
      samplesPerFrame: PCM_SAMPLES_PER_FRAME,
      sourceSampleRate: sampleRate,
      targetSampleRate: PCM_SAMPLE_RATE_HZ,
    });
  }

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

    for (const frame of this.frameProcessor.push(monoChunk)) {
      this.port.postMessage(frame.buffer, [frame.buffer]);
    }

    clearChannels(outputChannels);
    return true;
  }
}

registerProcessor(PCM_RECORDER_WORKLET_NAME, PcmRecorderProcessor);
