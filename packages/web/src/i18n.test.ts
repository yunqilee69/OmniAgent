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

  it('names the automation nav entry apart from the automation tasks page', () => {
    expect(translate('zh', 'Automations')).toBe('自动化');
    expect(translate('zh', 'Automation tasks')).toBe('自动化任务');
  });

  it('translates the queued message controls', () => {
    expect(translate('zh', 'Messages waiting to send')).toBe('待发送消息');
    expect(translate('zh', 'Queue paused')).toBe('队列已暂停');
    expect(translate('zh', 'Continue queued messages')).toBe('继续发送排队消息');
    expect(translator('en')('Continue')).toBe('Continue');
  });

  it('translates the draft attachment notices', () => {
    expect(translate('zh', 'Restoring attachments…')).toBe('正在恢复附件…');
    expect(translate('zh', 'Kept for this session only; a refresh may lose these attachments.'))
      .toBe('本次会话内保留，刷新可能丢失。');
    expect(translate('zh', 'Wait for the draft attachments to finish restoring.'))
      .toBe('请等待附件恢复完成再发送。');
  });

  it('normalizes persisted locale values', () => {
    expect(normalizeLocale('zh')).toBe('zh');
    expect(normalizeLocale('en')).toBe('en');
    expect(normalizeLocale('fr')).toBeUndefined();
    expect(normalizeLocale(null)).toBeUndefined();
  });
});
