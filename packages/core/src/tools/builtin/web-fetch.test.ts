import { describe, expect, it } from 'vitest';
import { createWebFetchTool, isPrivateAddress } from './web-fetch';

const signal = new AbortController().signal;

function toolWith(
  fetchImpl: typeof globalThis.fetch,
  addresses: Record<string, string[]> = { 'example.com': ['93.184.216.34'] },
  maxOutputChars?: number,
) {
  return createWebFetchTool({
    fetch: fetchImpl,
    resolve: async (host) => addresses[host] ?? [],
    ...(maxOutputChars === undefined ? {} : { maxOutputChars }),
  });
}

function htmlResponse(body: string, init: ResponseInit = {}) {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });
}

describe('web_fetch address guard', () => {
  it('classifies private, loopback and reserved addresses', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.1.1',
      '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1',
      '::ffff:7f00:1']) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ['93.184.216.34', '8.8.8.8', '2606:2800:220:1::1']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it('refuses a hostname that resolves to loopback', async () => {
    const tool = toolWith(async () => htmlResponse('<p>nope</p>'), { 'internal.test': ['127.0.0.1'] });
    await expect(tool.execute({ url: 'http://internal.test/' }, { cwd: process.cwd(), signal }))
      .rejects.toThrow(/拒绝访问内网或回环地址/);
  });

  it('refuses a literal private address without DNS', async () => {
    const tool = toolWith(async () => htmlResponse('nope'));
    await expect(tool.execute({ url: 'http://169.254.169.254/latest/meta-data/' }, { cwd: process.cwd(), signal }))
      .rejects.toThrow(/拒绝访问/);
  });

  it('rejects credentials, non-http schemes, and over-long URLs', async () => {
    const tool = toolWith(async () => htmlResponse('nope'));
    for (const url of ['file:///etc/passwd', 'https://user:pass@example.com/', `https://example.com/${'x'.repeat(2048)}`]) {
      await expect(tool.execute({ url }, { cwd: process.cwd(), signal })).rejects.toThrow(/抓取 .* 失败/);
    }
  });

  it('does not follow a cross-origin redirect automatically', async () => {
    const calls: string[] = [];
    const tool = toolWith(async (input) => {
      calls.push(String(input));
      return new Response('', { status: 302, headers: { location: 'http://localhost/admin' } });
    }, { 'example.com': ['93.184.216.34'], localhost: ['127.0.0.1'] });
    await expect(tool.execute({ url: 'https://example.com/start' }, { cwd: process.cwd(), signal }))
      .rejects.toThrow(/cross-origin redirect/);
    expect(calls).toEqual(['https://example.com/start']);
  });
});

describe('web_fetch content', () => {
  it('follows a same-origin redirect and converts HTML to Markdown', async () => {
    let hop = 0;
    const tool = toolWith(async () => {
      hop += 1;
      if (hop === 1) return new Response('', { status: 302, headers: { location: 'https://example.com/final' } });
      return htmlResponse(
        '<html><head><style>b{}</style></head><body><h1>Title</h1><p>Hello&nbsp;world</p>'
        + '<table><thead><tr><th>Name</th><th>Value</th></tr></thead>'
        + '<tbody><tr><td>A</td><td>1</td></tr></tbody></table>'
        + '<script>alert(1)</script></body></html>',
      );
    });
    const result = await tool.execute({ url: 'https://example.com/' }, { cwd: process.cwd(), signal });
    expect(result.content).toContain('Fetched https://example.com/final (HTTP 200)');
    expect(result.content).toContain('External web content follows.');
    expect(result.content).toContain('# Title');
    expect(result.content).toContain('Hello\u00a0world');
    expect(result.content).toContain('| Name');
    expect(result.content).not.toContain('<h1>');
    expect(result.content).not.toContain('b{}');
    expect(result.content).not.toContain('alert(1)');
  });

  it('returns plain text, and returns non-2xx bodies with their status', async () => {
    const plain = toolWith(async () => new Response('just text', {
      status: 200, headers: { 'content-type': 'text/plain' },
    }));
    const ok = await plain.execute({ url: 'https://example.com/a.txt' }, { cwd: process.cwd(), signal });
    expect(ok.content).toContain('just text');

    const missing = toolWith(async () => new Response('gone', {
      status: 404, headers: { 'content-type': 'text/plain' },
    }));
    const result = await missing.execute({ url: 'https://example.com/missing' }, { cwd: process.cwd(), signal });
    expect(result.content).toContain('HTTP 404');
    expect(result.content).toContain('gone');
  });

  it('rejects unsupported binary content types before reading the body', async () => {
    const tool = toolWith(async () => new Response('%PDF', {
      status: 200, headers: { 'content-type': 'application/pdf' },
    }));
    await expect(tool.execute({ url: 'https://example.com/doc.pdf' }, { cwd: process.cwd(), signal }))
      .rejects.toThrow(/unsupported content type/);
  });

  it('caps the complete output and reports truncation', async () => {
    const tool = toolWith(async () => new Response('x'.repeat(5_000), {
      status: 200, headers: { 'content-type': 'text/plain' },
    }), { 'example.com': ['93.184.216.34'] }, 500);
    const result = await tool.execute({ url: 'https://example.com/long' }, { cwd: process.cwd(), signal });
    expect(result.content.length).toBeLessThanOrEqual(500);
    expect(result.content).toContain('Content truncated');
    expect(result.truncated).toBe(true);
  });

  it('stops after too many redirects', async () => {
    const tool = toolWith(async () => new Response('', { status: 302, headers: { location: 'https://example.com/loop' } }));
    await expect(tool.execute({ url: 'https://example.com/loop' }, { cwd: process.cwd(), signal }))
      .rejects.toThrow(/maximum of 5 redirects/);
  });
});
