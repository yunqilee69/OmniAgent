import { describe, expect, it } from 'vitest';
import { createWebSearchTool, formatSearchOutput } from './web-search';

const signal = new AbortController().signal;

describe('web_search', () => {
  it('formats interleaved sources and keeps the external-content notice', () => {
    const output = formatSearchOutput([
      { query: 'one', sources: [{ url: 'https://a.example', title: 'A' }, { url: 'https://shared.example' }] },
      { query: 'two', answer: 'Answer two', sources: [{ url: 'https://b.example', snippet: 'B' }, { url: 'https://shared.example' }] },
    ], 3);
    expect(output).toContain('External web content follows');
    expect(output).toContain('Answer two');
    expect(output.indexOf('https://a.example')).toBeLessThan(output.indexOf('https://b.example'));
    expect(output.match(/^- \[https:\/\/shared\.example\]/gm)).toHaveLength(1);
  });

  it('returns a configuration error without calling the provider', async () => {
    const tool = createWebSearchTool({ resolve: () => undefined });
    await expect(tool.execute({ queries: ['omniagent'] }, { cwd: process.cwd(), signal }))
      .rejects.toThrow(/not configured/);
  });

  it('searches distinct queries in parallel and caps citations', async () => {
    const seen: string[] = [];
    const tool = createWebSearchTool({
      maxResults: 1,
      provider: {
        async search(query) {
          seen.push(query);
          return { query, sources: [{ url: `https://${query}.example`, title: query }] };
        },
      },
    });
    const result = await tool.execute({ queries: [' alpha ', 'alpha', 'beta'] }, { cwd: process.cwd(), signal });
    expect(seen).toEqual(['alpha', 'beta']);
    expect(result.content).toContain('https://alpha.example');
    expect(result.content).toContain('Showing the first 1 sources');
  });
});
