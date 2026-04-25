import type { PluginSettings } from '../settings/plugin-settings';

export interface FirstRunGateDeps {
  settings: PluginSettings;
  updateSettings: (next: PluginSettings) => Promise<void>;
  openFirstRunSetup: () => Promise<void>;
}

// Gate is flipped before the modal opens so a user who dismisses the modal
// without installing is not re-prompted on the next launch.
export async function openFirstRunSetupIfNeeded(deps: FirstRunGateDeps): Promise<void> {
  if (deps.settings.firstRunCompleted) return;
  await deps.updateSettings({ ...deps.settings, firstRunCompleted: true });
  await deps.openFirstRunSetup();
}
