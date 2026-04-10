import type { Plugin } from 'obsidian';

interface CommandDependencies {
  checkSidecarHealth: () => Promise<void>;
  cancelDictation: () => Promise<void>;
  plugin: Plugin;
  restartSidecar: () => Promise<void>;
  startDictation: () => Promise<void>;
  stopAndTranscribe: () => Promise<void>;
}

export function registerCommands(dependencies: CommandDependencies): void {
  dependencies.plugin.addCommand({
    id: 'start-dictation',
    name: 'Local STT: Start Dictation',
    callback: async () => {
      await dependencies.startDictation();
    },
  });

  dependencies.plugin.addCommand({
    id: 'stop-and-transcribe',
    name: 'Local STT: Stop And Transcribe',
    callback: async () => {
      await dependencies.stopAndTranscribe();
    },
  });

  dependencies.plugin.addCommand({
    id: 'cancel-dictation',
    name: 'Local STT: Cancel Dictation',
    callback: async () => {
      await dependencies.cancelDictation();
    },
  });

  dependencies.plugin.addCommand({
    id: 'check-sidecar-health',
    name: 'Local STT: Check Sidecar Health',
    callback: async () => {
      await dependencies.checkSidecarHealth();
    },
  });

  dependencies.plugin.addCommand({
    id: 'restart-sidecar',
    name: 'Local STT: Restart Sidecar',
    callback: async () => {
      await dependencies.restartSidecar();
    },
  });
}
