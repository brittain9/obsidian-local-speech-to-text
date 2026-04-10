import type { Plugin } from 'obsidian';

interface CommandDependencies {
  checkSidecarHealth: () => Promise<void>;
  insertBootstrapText: () => void;
  insertMockTranscript: () => Promise<void>;
  plugin: Plugin;
  restartSidecar: () => Promise<void>;
}

export function registerCommands(dependencies: CommandDependencies): void {
  dependencies.plugin.addCommand({
    id: 'insert-bootstrap-text',
    name: 'Local STT: Insert Bootstrap Text',
    callback: () => {
      dependencies.insertBootstrapText();
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
    id: 'insert-mock-transcript',
    name: 'Local STT: Insert Mock Transcript',
    callback: async () => {
      await dependencies.insertMockTranscript();
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
