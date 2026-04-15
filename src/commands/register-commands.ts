import type { Plugin } from 'obsidian';

const START_DICTATION_COMMAND_ID = 'start-dictation-session';
const STOP_DICTATION_COMMAND_ID = 'stop-dictation-session';
const CANCEL_DICTATION_COMMAND_ID = 'cancel-dictation-session';

interface CommandDependencies {
  cancelDictation: () => Promise<void>;
  checkSidecarHealth: () => Promise<void>;
  plugin: Plugin;
  restartSidecar: () => Promise<void>;
  startDictation: () => Promise<void>;
  stopDictation: () => Promise<void>;
}

export function registerCommands(dependencies: CommandDependencies): void {
  dependencies.plugin.addCommand({
    id: START_DICTATION_COMMAND_ID,
    name: 'Start Dictation Session',
    callback: async () => {
      await dependencies.startDictation();
    },
  });

  dependencies.plugin.addCommand({
    id: STOP_DICTATION_COMMAND_ID,
    name: 'Stop Dictation Session',
    callback: async () => {
      await dependencies.stopDictation();
    },
  });

  dependencies.plugin.addCommand({
    id: CANCEL_DICTATION_COMMAND_ID,
    name: 'Cancel Dictation Session',
    callback: async () => {
      await dependencies.cancelDictation();
    },
  });

  dependencies.plugin.addCommand({
    id: 'check-sidecar-health',
    name: 'Check Sidecar Health',
    callback: async () => {
      await dependencies.checkSidecarHealth();
    },
  });

  dependencies.plugin.addCommand({
    id: 'restart-sidecar',
    name: 'Restart Sidecar',
    callback: async () => {
      await dependencies.restartSidecar();
    },
  });
}
