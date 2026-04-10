import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  downsampleBuffer,
  encodePcm16WaveFile,
  float32ToInt16Pcm,
  mergeSampleChunks,
  normalizeAudioBufferToMono,
  TARGET_WAV_CHANNEL_COUNT,
  TARGET_WAV_SAMPLE_RATE,
} from './wav-encoder';

const DEFAULT_BUFFER_SIZE = 4_096;

type RecorderLogger = (message: string, error?: unknown) => void;

export interface RecordedAudioFile {
  audioFilePath: string;
  durationMs: number;
  sampleRate: number;
}

interface MicrophoneRecorderOptions {
  bufferSize?: number;
  logger?: RecorderLogger;
  targetSampleRate?: number;
}

export class MicrophoneRecorder {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private muteNode: GainNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private sampleChunks: Float32Array[] = [];
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private sourceSampleRate = 0;

  constructor(private readonly options: MicrophoneRecorderOptions = {}) {}

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
      await audioContext.resume();

      const sourceNode = audioContext.createMediaStreamSource(mediaStream);
      const processorNode = audioContext.createScriptProcessor(
        this.options.bufferSize ?? DEFAULT_BUFFER_SIZE,
        1,
        1,
      );
      const muteNode = audioContext.createGain();
      muteNode.gain.value = 0;

      this.sampleChunks = [];
      processorNode.onaudioprocess = (event) => {
        this.sampleChunks.push(normalizeAudioBufferToMono(event.inputBuffer));
      };

      sourceNode.connect(processorNode);
      processorNode.connect(muteNode);
      muteNode.connect(audioContext.destination);

      this.audioContext = audioContext;
      this.mediaStream = mediaStream;
      this.muteNode = muteNode;
      this.processorNode = processorNode;
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
    const { mkdir } = await import('node:fs/promises');

    await mkdir(dirname(outputFilePath), { recursive: true });
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
    const processorNode = this.processorNode;
    const sourceNode = this.sourceNode;
    const capturedChunks = this.sampleChunks;

    this.audioContext = null;
    this.mediaStream = null;
    this.muteNode = null;
    this.processorNode = null;
    this.sampleChunks = [];
    this.sourceNode = null;
    this.sourceSampleRate = 0;

    try {
      processorNode?.disconnect();
      sourceNode?.disconnect();
      muteNode?.disconnect();
    } catch (error) {
      this.log('failed to disconnect microphone recorder nodes cleanly', error);
    }

    if (processorNode !== null) {
      processorNode.onaudioprocess = null;
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

function asError(value: unknown, fallbackMessage: string): Error {
  return value instanceof Error ? value : new Error(fallbackMessage);
}
