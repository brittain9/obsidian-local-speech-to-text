// @ts-expect-error esbuild provides this virtual module at bundle time.
import { PCM_RECORDER_WORKLET_SOURCE as bundledRecorderWorkletSource } from 'virtual:pcm-recorder-worklet-source';

export const PCM_RECORDER_WORKLET_SOURCE: string = bundledRecorderWorkletSource;
