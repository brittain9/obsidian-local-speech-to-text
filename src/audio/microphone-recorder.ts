import { readFile, writeFile } from 'node:fs/promises';

import { PCM_RECORDER_WORKLET_NAME } from './pcm-recorder-worklet-shared';
import {
  downsampleBuffer,
  encodePcm16WaveFile,
  float32ToInt16Pcm,
  mergeSampleChunks,
  TARGET_WAV_CHANNEL_COUNT,
  TARGET_WAV_SAMPLE_RATE,
} from './wav-encoder';

type RecorderLogger = (message: string, error?: unknown) => void;

export interface RecordedAudioFile {
  audioFilePath: string;
  durationMs: number;
  sampleRate: number;
}

interface MicrophoneRecorderOptions {
  logger?: RecorderLogger;
  resolveWorkletModulePath: () => Promise<string>;
  targetSampleRate?: number;
}

export class MicrophoneRecorder {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private muteNode: GainNode | null = null;
  private recorderNode: AudioWorkletNode | null = null;
  private sampleChunks: Float32Array[] = [];
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private sourceSampleRate = 0;

  constructor(private readonly options: MicrophoneRecorderOptions) {}

  isRecording(): boolean {
    return this.mediaStream !== null;
  }

  async start(): Promise<void> {
    if (this.isRecording()) {
      throw new Error('Dictation is already recording.');
    }

    const mediaDevices = globalThis.navigator?.mediaDevices;

    if (mediaDevices?.getUserMedia === undefined) {
      throw new Error('Microphone capture is not available in this Obsidian runtime.');
    }

    const mediaStream = await mediaDevices.getUserMedia({
      audio: {
        autoGainControl: false,
        channelCount: TARGET_WAV_CHANNEL_COUNT,
        echoCancellation: false,
        noiseSuppression: false,
      },
      video: false,
    });

    let audioContext: AudioContext | null = null;

    try {
      const AudioContextConstructor = getAudioContextConstructor();
      audioContext = new AudioContextConstructor();
      await installRecorderWorklet(
        audioContext,
        await this.options.resolveWorkletModulePath(),
        this.options.logger,
      );
      await audioContext.resume();

      const sourceNode = audioContext.createMediaStreamSource(mediaStream);
      const recorderNode = new AudioWorkletNode(audioContext, PCM_RECORDER_WORKLET_NAME, {
        channelCount: TARGET_WAV_CHANNEL_COUNT,
        channelCountMode: 'explicit',
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [TARGET_WAV_CHANNEL_COUNT],
      });
      const muteNode = audioContext.createGain();
      muteNode.gain.value = 0;

      this.sampleChunks = [];
      recorderNode.port.onmessage = (event) => {
        const sampleChunk = toFloat32Array(event.data);

        if (sampleChunk.length > 0) {
          this.sampleChunks.push(sampleChunk);
        }
      };

      sourceNode.connect(recorderNode);
      recorderNode.connect(muteNode);
      muteNode.connect(audioContext.destination);

      this.audioContext = audioContext;
      this.mediaStream = mediaStream;
      this.muteNode = muteNode;
      this.recorderNode = recorderNode;
      this.sourceNode = sourceNode;
      this.sourceSampleRate = audioContext.sampleRate;
    } catch (error) {
      this.log('failed to initialize microphone recorder', error);
      await stopMediaStream(mediaStream);

      if (audioContext !== null) {
        await closeAudioContext(audioContext);
      }

      throw asError(error, 'Failed to initialize microphone recording.');
    }
  }

  async stop(outputFilePath: string): Promise<RecordedAudioFile> {
    if (!this.isRecording()) {
      throw new Error('Dictation is not currently recording.');
    }

    const sourceSampleRate = this.sourceSampleRate;
    const capturedChunks = await this.releaseCapture();
    const mergedSamples = mergeSampleChunks(capturedChunks);

    if (mergedSamples.length === 0) {
      throw new Error('No audio was captured from the microphone.');
    }

    const targetSampleRate = this.options.targetSampleRate ?? TARGET_WAV_SAMPLE_RATE;
    const outputSamples =
      sourceSampleRate === targetSampleRate
        ? mergedSamples
        : downsampleBuffer(mergedSamples, sourceSampleRate, targetSampleRate);
    const pcmSamples = float32ToInt16Pcm(outputSamples);
    const wavBytes = encodePcm16WaveFile(pcmSamples, targetSampleRate, TARGET_WAV_CHANNEL_COUNT);

    await writeFile(outputFilePath, wavBytes);

    return {
      audioFilePath: outputFilePath,
      durationMs: Math.round((outputSamples.length / targetSampleRate) * 1_000),
      sampleRate: targetSampleRate,
    };
  }

  async cancel(): Promise<void> {
    if (!this.isRecording()) {
      return;
    }

    await this.releaseCapture();
  }

  async dispose(): Promise<void> {
    await this.cancel();
  }

  private async releaseCapture(): Promise<Float32Array[]> {
    const audioContext = this.audioContext;
    const mediaStream = this.mediaStream;
    const muteNode = this.muteNode;
    const recorderNode = this.recorderNode;
    const sourceNode = this.sourceNode;
    const capturedChunks = this.sampleChunks;

    this.audioContext = null;
    this.mediaStream = null;
    this.muteNode = null;
    this.recorderNode = null;
    this.sampleChunks = [];
    this.sourceNode = null;
    this.sourceSampleRate = 0;

    try {
      recorderNode?.disconnect();
      sourceNode?.disconnect();
      muteNode?.disconnect();
    } catch (error) {
      this.log('failed to disconnect microphone recorder nodes cleanly', error);
    }

    if (recorderNode !== null) {
      recorderNode.port.onmessage = null;
    }

    if (mediaStream !== null) {
      await stopMediaStream(mediaStream);
    }

    if (audioContext !== null) {
      await closeAudioContext(audioContext);
    }

    return capturedChunks;
  }

  private log(message: string, error?: unknown): void {
    this.options.logger?.(message, error);
  }
}

function getAudioContextConstructor(): typeof AudioContext {
  const runtime = globalThis as typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };

  if (runtime.AudioContext !== undefined) {
    return runtime.AudioContext;
  }

  if (runtime.webkitAudioContext !== undefined) {
    return runtime.webkitAudioContext;
  }

  throw new Error('AudioContext is not available in this Obsidian runtime.');
}

async function stopMediaStream(mediaStream: MediaStream): Promise<void> {
  for (const track of mediaStream.getTracks()) {
    track.stop();
  }
}

async function closeAudioContext(audioContext: AudioContext): Promise<void> {
  if (audioContext.state !== 'closed') {
    await audioContext.close();
  }
}

async function installRecorderWorklet(
  audioContext: AudioContext,
  workletModulePath: string,
  logger?: RecorderLogger,
): Promise<void> {
  if (audioContext.audioWorklet === undefined) {
    throw new Error('AudioWorklet is not available in this Obsidian runtime.');
  }

  let workletModuleSource: string;

  try {
    workletModuleSource = await readFile(workletModulePath, 'utf8');
  } catch (error) {
    logger?.('failed to read recorder worklet module', error);
    throw asError(error, `Failed to read recorder worklet module: ${workletModulePath}`);
  }

  const workletModuleUrl = URL.createObjectURL(
    new Blob([workletModuleSource], { type: 'text/javascript' }),
  );

  try {
    await audioContext.audioWorklet.addModule(workletModuleUrl);
  } catch (error) {
    logger?.('failed to load recorder worklet module', error);
    throw asError(error, `Failed to load recorder worklet module: ${workletModulePath}`);
  } finally {
    URL.revokeObjectURL(workletModuleUrl);
  }
}

function toFloat32Array(value: unknown): Float32Array {
  if (value instanceof Float32Array) {
    return value;
  }

  if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) {
    return new Float32Array(value.buffer.slice(0));
  }

  throw new Error('Recorder worklet emitted an invalid audio sample payload.');
}

function asError(value: unknown, fallbackMessage: string): Error {
  return value instanceof Error ? value : new Error(fallbackMessage);
}
