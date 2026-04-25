import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_PLUGIN_SETTINGS, type PluginSettings } from '../src/settings/plugin-settings';
import { openFirstRunSetupIfNeeded } from '../src/setup/first-run-gate';

function makeSettings(overrides: Partial<PluginSettings> = {}): PluginSettings {
  return { ...DEFAULT_PLUGIN_SETTINGS, ...overrides };
}

describe('openFirstRunSetupIfNeeded', () => {
  it('is a no-op when firstRunCompleted is already true', async () => {
    const updateSettings = vi.fn(async () => {});
    const openFirstRunSetup = vi.fn(async () => {});

    await openFirstRunSetupIfNeeded({
      openFirstRunSetup,
      settings: makeSettings({ firstRunCompleted: true }),
      updateSettings,
    });

    expect(updateSettings).not.toHaveBeenCalled();
    expect(openFirstRunSetup).not.toHaveBeenCalled();
  });

  it('marks firstRunCompleted true and opens the setup when the gate is open', async () => {
    const updateSettings = vi.fn(async () => {});
    const openFirstRunSetup = vi.fn(async () => {});
    const settings = makeSettings({ firstRunCompleted: false });

    await openFirstRunSetupIfNeeded({
      openFirstRunSetup,
      settings,
      updateSettings,
    });

    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith({ ...settings, firstRunCompleted: true });
    expect(openFirstRunSetup).toHaveBeenCalledTimes(1);
  });

  it('persists firstRunCompleted before opening the modal so a dismissed prompt does not re-fire', async () => {
    const order: string[] = [];
    const updateSettings = vi.fn(async () => {
      order.push('update');
    });
    const openFirstRunSetup = vi.fn(async () => {
      order.push('open');
    });

    await openFirstRunSetupIfNeeded({
      openFirstRunSetup,
      settings: makeSettings({ firstRunCompleted: false }),
      updateSettings,
    });

    expect(order).toEqual(['update', 'open']);
  });
});
