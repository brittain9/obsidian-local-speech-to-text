import { describe, expect, it } from 'vitest';

import { DEFAULT_PLUGIN_SETTINGS } from '../src/settings/plugin-settings';
import { normalizePersistedPluginSettings } from '../src/settings/settings-normalization';

describe('normalizePersistedPluginSettings', () => {
  it('leaves valid settings unchanged', async () => {
    const result = await normalizePersistedPluginSettings(DEFAULT_PLUGIN_SETTINGS);

    expect(result.didChange).toBe(false);
    expect(result.settings).toEqual(DEFAULT_PLUGIN_SETTINGS);
    expect(result.messages).toEqual([]);
  });
});
