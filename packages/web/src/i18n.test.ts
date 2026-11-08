import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, normalizeLocale, translate, translator } from '../ui/src/lib/i18n';

describe('web locale catalogue', () => {
  it('defaults to Chinese and translates interpolated strings', () => {
    expect(DEFAULT_LOCALE).toBe('zh');
    expect(translate('zh', 'Settings')).toBe('设置');
    expect(translate('zh', 'Could not load session: {message}', { message: 'boom' })).toBe('无法加载会话：boom');
  });

  it('keeps English source strings and falls back to the key when a translation is absent', () => {
    expect(translator('en')('Settings')).toBe('Settings');
    expect(translate('zh', 'Untranslated product label')).toBe('Untranslated product label');
  });

  it('normalizes persisted locale values', () => {
    expect(normalizeLocale('zh')).toBe('zh');
    expect(normalizeLocale('en')).toBe('en');
    expect(normalizeLocale('fr')).toBeUndefined();
    expect(normalizeLocale(null)).toBeUndefined();
  });
});
