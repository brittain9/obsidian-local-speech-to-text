import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_PLUGIN_SETTINGS } from '../src/settings/plugin-settings';
import { normalizePersistedPluginSettings } from '../src/settings/settings-normalization';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directoryPath) => rm(directoryPath, { force: true, recursive: true })),
  );
});

describe('normalizePersistedPluginSettings', () => {
  it('clears a temp audio override when it points to an existing file', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'obsidian-local-stt-settings-'));
    const tempFilePath = join(tempDirectory, 'sidecar-binary');
    tempDirectories.push(tempDirectory);
    await writeFile(tempFilePath, 'not a directory');

    const result = await normalizePersistedPluginSettings({
      ...DEFAULT_PLUGIN_SETTINGS,
      tempAudioDirectoryOverride: tempFilePath,
    });

    expect(result.didChange).toBe(true);
    expect(result.settings.tempAudioDirectoryOverride).toBe('');
    expect(result.messages).toContain(
      'Cleared an invalid temp audio directory override because it pointed to a file.',
    );
  });

  it('leaves valid settings unchanged', async () => {
    const result = await normalizePersistedPluginSettings(DEFAULT_PLUGIN_SETTINGS);

    expect(result.didChange).toBe(false);
    expect(result.settings).toEqual(DEFAULT_PLUGIN_SETTINGS);
    expect(result.messages).toEqual([]);
  });
});
