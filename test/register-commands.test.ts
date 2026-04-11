import type { Command, Plugin } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

import {
  CANCEL_DICTATION_COMMAND_ID,
  PRESS_AND_HOLD_GATE_COMMAND_ID,
  registerCommands,
  START_DICTATION_COMMAND_ID,
  STOP_DICTATION_COMMAND_ID,
} from '../src/commands/register-commands';

describe('registerCommands', () => {
  it('registers the press-and-hold gate as a hotkey-only command target', () => {
    const commands = registerAllCommands();

    const command = commands.find(({ id }) => id === PRESS_AND_HOLD_GATE_COMMAND_ID);

    expect(command).toBeDefined();
    expect(command?.checkCallback?.(true)).toBe(false);
    expect(command?.checkCallback?.(false)).toBe(false);
  });

  it('keeps the runnable dictation commands wired to their handlers', async () => {
    const startDictation = vi.fn(async () => {});
    const stopDictation = vi.fn(async () => {});
    const cancelDictation = vi.fn(async () => {});
    const commands = registerAllCommands({
      cancelDictation,
      startDictation,
      stopDictation,
    });

    await commands.find(({ id }) => id === START_DICTATION_COMMAND_ID)?.callback?.();
    await commands.find(({ id }) => id === STOP_DICTATION_COMMAND_ID)?.callback?.();
    await commands.find(({ id }) => id === CANCEL_DICTATION_COMMAND_ID)?.callback?.();

    expect(startDictation).toHaveBeenCalledTimes(1);
    expect(stopDictation).toHaveBeenCalledTimes(1);
    expect(cancelDictation).toHaveBeenCalledTimes(1);
  });
});

function registerAllCommands(
  overrides: Partial<Parameters<typeof registerCommands>[0]> = {},
): Command[] {
  const commands: Command[] = [];

  registerCommands({
    cancelDictation: async () => {},
    checkSidecarHealth: async () => {},
    plugin: {
      addCommand(command: Command): Command {
        commands.push(command);
        return command;
      },
    } as unknown as Plugin,
    restartSidecar: async () => {},
    startDictation: async () => {},
    stopDictation: async () => {},
    ...overrides,
  });

  return commands;
}
