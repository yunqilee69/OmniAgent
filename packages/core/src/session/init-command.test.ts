import { describe, expect, it } from 'vitest';
import { expandInitCommand, isInitCommand } from './init-command';

describe('/init command', () => {
  it('matches the complete command and optional notes', () => {
    for (const value of ['/init', ' /INIT  ', '/init focus on tests', '/init\nmore details']) {
      expect(isInitCommand(value)).toBe(true);
    }
    for (const value of ['/initialize', '/init-file', 'please /init', '/init: notes']) {
      expect(isInitCommand(value)).toBe(false);
    }
  });

  it('instructs the agent to inspect before creating or updating instructions', () => {
    const result = expandInitCommand([{ type: 'text', text: '/init focus on testing' }]);
    expect(result).toHaveLength(1);
    expect(result?.[0]).toMatchObject({ type: 'text', text: expect.stringContaining('focus on testing') });
    const text = result?.[0]?.type === 'text' ? result[0].text : '';
    expect(text).toContain('workspace root');
    expect(text).toContain('read it before making changes');
    expect(text).toContain('Preserve useful existing instructions');
    expect(text).toContain('tool permissions');
    expect(text).toContain('Do not modify global instruction files');
  });

  it('leaves ordinary messages and attachments unchanged', () => {
    expect(expandInitCommand([{ type: 'text', text: '/initialize' }])).toBeUndefined();
    expect(expandInitCommand([{ type: 'text', text: '/init' }, { type: 'image', mediaType: 'image/png', data: 'x' }])).toBeUndefined();
  });
});
