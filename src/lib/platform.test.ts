import { describe, expect, it } from 'vitest';
import { defaultShortcut, normalizeShortcut, shortcutLabel, shortcutRecording } from './platform';

describe('platform-specific keyboard presentation', () => {
  it('defaults to Ctrl on Windows and Option on macOS', () => {
    expect(defaultShortcut('windows')).toBe('Control+Shift+Space');
    expect(defaultShortcut('macos')).toBe('Alt+Shift+Space');
  });

  it('uses macOS symbols only on macOS', () => {
    expect(shortcutLabel('Alt+Shift+Space', 'macos')).toBe('⌥ + ⇧ + 空格');
    expect(shortcutLabel('Super+Shift+KeyJ', 'macos')).toBe('⌘ + ⇧ + J');
  });

  it('uses readable Windows key names without Mac-only symbols', () => {
    expect(shortcutLabel('Control+Shift+Space', 'windows')).toBe('Ctrl + Shift + 空格');
    expect(shortcutLabel('Control+Shift+KeyJ', 'windows')).toBe('Ctrl + Shift + J');
    expect(shortcutLabel('Super+Alt+KeyQ', 'windows')).toBe('Win + Alt + Q');
  });

  it('captures literal Ctrl, Win and combined modifiers', () => {
    const event = { key: 'j', code: 'KeyJ', metaKey: false, ctrlKey: true, altKey: false, shiftKey: true };
    expect(shortcutRecording(event)).toBe('Control+Shift+KeyJ');
    expect(shortcutRecording({ ...event, ctrlKey: false, metaKey: true })).toBe('Super+Shift+KeyJ');
    expect(shortcutRecording({ ...event, metaKey: true, ctrlKey: true })).toBe('Super+Control+Shift+KeyJ');
  });

  it('normalizes menu-style aliases before registering a global hotkey', () => {
    expect(normalizeShortcut('CommandOrControl+Shift+KeyJ', 'windows')).toBe('Control+Shift+KeyJ');
    expect(normalizeShortcut('CommandOrControl+Shift+KeyJ', 'macos')).toBe('Super+Shift+KeyJ');
  });
});
