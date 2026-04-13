import { Platform } from 'obsidian';
import type { App, Hotkey, Modifier } from 'obsidian';

interface InternalAppShape extends App {
  commands?: {
    commands?: Record<string, { hotkeys?: Hotkey[] }>;
  };
  hotkeyManager?: {
    bakedHotkeys?: Record<string, Hotkey[]>;
    customKeys?: Record<string, Hotkey[]>;
    getHotkeys?: (commandId: string) => Hotkey[] | undefined;
  };
}

export function resolveCommandHotkeys(
  app: App,
  commandId: string,
  fallbackHotkeys: Hotkey[] = [],
): Hotkey[] {
  const runtime = app as InternalAppShape;
  const fromGetter = runtime.hotkeyManager?.getHotkeys?.(commandId);

  if (Array.isArray(fromGetter) && fromGetter.length > 0) {
    return fromGetter;
  }

  const fromCustomKeys = runtime.hotkeyManager?.customKeys?.[commandId];

  if (Array.isArray(fromCustomKeys) && fromCustomKeys.length > 0) {
    return fromCustomKeys;
  }

  const fromBakedHotkeys = runtime.hotkeyManager?.bakedHotkeys?.[commandId];

  if (Array.isArray(fromBakedHotkeys) && fromBakedHotkeys.length > 0) {
    return fromBakedHotkeys;
  }

  const fromCommandRegistry = runtime.commands?.commands?.[commandId]?.hotkeys;

  if (Array.isArray(fromCommandRegistry) && fromCommandRegistry.length > 0) {
    return fromCommandRegistry;
  }

  return fallbackHotkeys;
}

export function matchesAnyHotkey(event: KeyboardEvent, hotkeys: Hotkey[]): boolean {
  return hotkeys.some((hotkey) => matchesHotkey(event, hotkey));
}

export function matchesHotkey(event: KeyboardEvent, hotkey: Hotkey): boolean {
  const normalizedEventKey = normalizeKey(event.key);
  const normalizedHotkeyKey = normalizeKey(hotkey.key);

  if (normalizedEventKey !== normalizedHotkeyKey) {
    return false;
  }

  const requiredModifiers = new Set(expandModifiers(hotkey.modifiers));

  return (
    event.altKey === requiredModifiers.has('Alt') &&
    event.ctrlKey === requiredModifiers.has('Ctrl') &&
    event.metaKey === requiredModifiers.has('Meta') &&
    event.shiftKey === requiredModifiers.has('Shift')
  );
}

/** Blocks held-key shortcuts inside editable elements (including the Obsidian editor's
 * contentEditable region) so they do not interfere with normal typing. */
export function shouldIgnoreHeldKeyEvent(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined') {
    return false;
  }

  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const tagName = target.tagName.toLowerCase();

  return tagName === 'input' || tagName === 'select' || tagName === 'textarea';
}

function expandModifiers(modifiers: Modifier[]): Modifier[] {
  return modifiers.flatMap((modifier) => {
    if (modifier !== 'Mod') {
      return [modifier];
    }

    return Platform.isMacOS ? ['Meta'] : ['Ctrl'];
  });
}

function normalizeKey(key: string): string {
  if (key === ' ') {
    return 'space';
  }

  return key.toLowerCase();
}

