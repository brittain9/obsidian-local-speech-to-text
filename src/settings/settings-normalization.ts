import type { PluginSettings } from './plugin-settings';

export interface NormalizedPluginSettingsResult {
  didChange: boolean;
  messages: string[];
  settings: PluginSettings;
}

export async function normalizePersistedPluginSettings(
  settings: PluginSettings,
): Promise<NormalizedPluginSettingsResult> {
  return {
    didChange: false,
    messages: [],
    settings,
  };
}
