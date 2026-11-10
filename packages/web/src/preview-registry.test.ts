import { describe, expect, it } from 'vitest';
import {
  directoryOf, extensionOf, filenameOf, formatBytes, previewKindFor, resolveRelativePath, sourceForPath,
} from '../ui/src/components/preview/path.ts';
import { parseDelimited, detectDelimiter } from '../ui/src/components/preview/office/csv.ts';
import { columnName } from '../ui/src/components/preview/office/columns.ts';

describe('preview classification', () => {
  it('routes each extension family to its own viewer', () => {
    const cases: Array<[string, string]> = [
      ['README.md', 'markdown'],
      ['docs/guide.markdown', 'markdown'],
      ['docs/guide.mdx', 'markdown'],
      ['src/app.ts', 'code'],
      ['src/app.tsx', 'code'],
      ['main.py', 'code'],
      ['config.yaml', 'code'],
      ['patch.diff', 'code'],
      ['package.json', 'json'],
      ['network.ipynb', 'json'],
      ['data.csv', 'sheet'],
      ['data.tsv', 'sheet'],
      ['report.xlsx', 'sheet'],
      ['legacy.xls', 'sheet'],
      ['cover.png', 'image'],
      ['photo.JPEG', 'image'],
      ['icon.svg', 'svg'],
      ['paper.pdf', 'pdf'],
      ['contract.docx', 'docx'],
      ['index.html', 'html'],
      ['clip.mp4', 'video'],
      ['sound.mp3', 'audio'],
      ['notes.txt', 'text'],
      ['notes', 'text'],
      ['archive.zip', 'unsupported'],
      ['font.woff2', 'unsupported'],
    ];
    for (const [path, kind] of cases) expect([path, previewKindFor(path)]).toEqual([path, kind]);
  });

  it('keeps specific viewers ahead of the generic code viewer', () => {
    // SVG and CSV are also in the highlighter's extension table; they must not fall through to it.
    expect(previewKindFor('logo.svg')).toBe('svg');
    expect(previewKindFor('table.csv')).toBe('sheet');
    expect(previewKindFor('book.ipynb')).toBe('json');
  });

  it('picks the body source per path', () => {
    expect(sourceForPath('a.md')).toBe('text');
    expect(sourceForPath('a.csv')).toBe('text');
    expect(sourceForPath('a.html')).toBe('text');
    expect(sourceForPath('a.pdf')).toBe('url');
    expect(sourceForPath('a.png')).toBe('url');
    expect(sourceForPath('a.mp4')).toBe('url');
    expect(sourceForPath('a.docx')).toBe('bytes');
    expect(sourceForPath('a.xlsx')).toBe('bytes');
    expect(sourceForPath('a.zip')).toBe('none');
  });

  it('splits a path into name, extension, and directory', () => {
    expect(filenameOf('src/lib/util.ts')).toBe('util.ts');
    expect(directoryOf('src/lib/util.ts')).toBe('src/lib');
    expect(directoryOf('README.md')).toBe('');
    expect(extensionOf('src/lib/util.ts')).toBe('ts');
    expect(extensionOf('/repo/.env')).toBe('env');
    expect(extensionOf('Makefile')).toBe('');
  });
});

describe('preview path resolution', () => {
  it('joins references onto the document directory', () => {
    expect(resolveRelativePath('docs', 'img/x.png')).toBe('docs/img/x.png');
    expect(resolveRelativePath('a/b', './c.png')).toBe('a/b/c.png');
    expect(resolveRelativePath('docs/guide', '../assets/x.png')).toBe('docs/assets/x.png');
    expect(resolveRelativePath('docs', '/root.png')).toBe('root.png');
    expect(resolveRelativePath('', 'x.png')).toBe('x.png');
    expect(resolveRelativePath('docs', 'with%20space.png')).toBe('docs/with space.png');
  });

  it('refuses URLs and paths that escape the workspace', () => {
    expect(resolveRelativePath('docs', 'https://example.com/x.png')).toBeUndefined();
    expect(resolveRelativePath('docs', '//cdn/x.png')).toBeUndefined();
    expect(resolveRelativePath('', '../outside.png')).toBeUndefined();
    expect(resolveRelativePath('docs', '../../outside.png')).toBeUndefined();
    expect(resolveRelativePath('docs', 'a%00b.png')).toBeUndefined();
    expect(resolveRelativePath('docs', '%E0%A4%A')).toBeUndefined();
  });
});

describe('formatBytes', () => {
  it('formats each magnitude', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024 * 3.5)).toBe('3.5 MB');
    expect(formatBytes(1024 * 1024 * 200)).toBe('200 MB');
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });
});

describe('delimited text parsing', () => {
  it('detects the delimiter from the first non-empty line', () => {
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(detectDelimiter('a;b;c')).toBe(';');
    expect(detectDelimiter('\n\na,b,c')).toBe(',');
    expect(detectDelimiter('single')).toBe(',');
  });

  it('parses quotes, doubled quotes, embedded newlines, and CRLF', () => {
    const table = parseDelimited('name,note\r\n"Smith, J","say ""hi""\nsecond line"\r\n');
    expect(table.rows).toEqual([
      ['name', 'note'],
      ['Smith, J', 'say "hi"\nsecond line'],
    ]);
    expect(table.delimiter).toBe(',');
    expect(table.truncated).toBe(false);
  });

  it('drops a BOM and caps rows and columns', () => {
    expect(parseDelimited('\ufeffa,b').rows).toEqual([['a', 'b']]);
    const wide = parseDelimited('1,2,3,4', { maxColumns: 2 });
    expect(wide.rows).toEqual([['1', '2']]);
    expect(wide.truncated).toBe(true);
    const tall = parseDelimited('a\nb\nc', { maxRows: 2 });
    expect(tall.rows).toEqual([['a'], ['b']]);
    expect(tall.truncated).toBe(true);
  });

  it('honours a forced delimiter', () => {
    expect(parseDelimited('a|b', { delimiter: '|' }).rows).toEqual([['a', 'b']]);
  });
});

describe('spreadsheet column names', () => {
  it('maps indexes to A1 labels', () => {
    expect(columnName(0)).toBe('A');
    expect(columnName(25)).toBe('Z');
    expect(columnName(26)).toBe('AA');
    expect(columnName(701)).toBe('ZZ');
    expect(columnName(702)).toBe('AAA');
  });
});
