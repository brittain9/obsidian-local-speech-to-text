import { getExistingPathKind } from '../filesystem/path-validation';
import type { PluginSettings } from './plugin-settings';

export interface NormalizedPluginSettingsResult {
  didChange: boolean;
  messages: string[];
  settings: PluginSettings;
}

export async function normalizePersistedPluginSettings(
  settings: PluginSettings,
): Promise<NormalizedPluginSettingsResult> {
  let nextSettings = settings;
  const messages: string[] = [];

  if (settings.tempAudioDirectoryOverride.length > 0) {
    const pathKind = await getExistingPathKind(settings.tempAudioDirectoryOverride);

    if (pathKind === 'file') {
      nextSettings = {
        ...nextSettings,
        tempAudioDirectoryOverride: '',
      };
      messages.push(
        'Cleared an invalid temp audio directory override because it pointed to a file.',
      );
    }
  }

  return {
    didChange: !arePluginSettingsEqual(settings, nextSettings),
    messages,
    settings: nextSettings,
  };
}

function arePluginSettingsEqual(left: PluginSettings, right: PluginSettings): boolean {
  return (
    left.insertionMode === right.insertionMode &&
    left.modelFilePath === right.modelFilePath &&
    left.sidecarPathOverride === right.sidecarPathOverride &&
    left.sidecarStartupTimeoutMs === right.sidecarStartupTimeoutMs &&
    left.sidecarRequestTimeoutMs === right.sidecarRequestTimeoutMs &&
    left.tempAudioDirectoryOverride === right.tempAudioDirectoryOverride
  );
}
