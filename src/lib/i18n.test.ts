import { beforeEach, describe, expect, it } from 'vitest';
import { durationLabel, languageOptions, translations, type TranslationKey } from './i18n';
import { previewSnapshot, useAppStore } from '../stores/appStore';

describe('interface languages', () => {
  beforeEach(() => {
    useAppStore.setState({ snapshot: structuredClone(previewSnapshot) });
  });

  it('provides every translation key in all supported languages', () => {
    const keys = Object.keys(translations['zh-CN']) as TranslationKey[];
    expect(languageOptions.map((option) => option.value)).toEqual(['zh-CN', 'zh-TW', 'en']);
    for (const language of languageOptions) {
      const dictionary = translations[language.value];
      expect(Object.keys(dictionary)).toHaveLength(keys.length);
      for (const key of keys) expect(dictionary[key], `${language.value}.${key}`).not.toBe('');
    }
  });

  it('updates the preview language without changing other preferences', () => {
    useAppStore.getState().setLanguage('zh-TW');
    expect(useAppStore.getState().snapshot.settings).toMatchObject({ language: 'zh-TW', mode: 'dictate', autoInsert: true });
    useAppStore.getState().setLanguage('en');
    expect(useAppStore.getState().snapshot.settings.language).toBe('en');
    expect(useAppStore.getState().snapshot.settings.shortcut).toBe('Alt+Shift+Space');
  });

  it('formats durations for the selected language', () => {
    expect(durationLabel(translations['zh-CN'], 61000, 'zh-CN')).toBe('1分01秒');
    expect(durationLabel(translations['zh-TW'], 61000, 'zh-TW')).toBe('1分01秒');
    expect(durationLabel(translations.en, 61000, 'en')).toBe('1m 1s');
    expect(durationLabel(translations.en, 3661000, 'en')).toBe('1h 1m');
  });
});
