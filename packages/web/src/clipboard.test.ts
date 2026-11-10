import { describe, expect, it } from 'vitest';
import { attachmentFileName, clipboardFiles } from '../ui/src/lib/clipboard';

describe('composer clipboard files', () => {
  it('returns the clipboard file list when the engine exposes it', () => {
    const screenshot = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'image.png', { type: 'image/png' });
    const copied = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    expect(clipboardFiles({ files: [screenshot, copied] })).toEqual([screenshot, copied]);
  });

  it('falls back to file items when the files list is empty', () => {
    const copied = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    const clipboard = {
      files: [] as File[],
      items: [
        { kind: 'string', getAsFile: () => null },
        { kind: 'file', getAsFile: () => null },
        { kind: 'file', getAsFile: () => copied },
      ],
    };
    expect(clipboardFiles(clipboard)).toEqual([copied]);
  });

  it('leaves text-only pastes on the textarea default path', () => {
    expect(clipboardFiles(null)).toEqual([]);
    expect(clipboardFiles({})).toEqual([]);
    expect(clipboardFiles({ files: [], items: [{ kind: 'string', getAsFile: () => null }] })).toEqual([]);
  });

  it('names unnamed clipboard files from their media type', () => {
    expect(attachmentFileName(new File(['x'], 'report.pdf', { type: 'application/pdf' }), 0)).toBe('report.pdf');
    expect(attachmentFileName(new File(['x'], '', { type: 'image/png' }), 0)).toBe('pasted-image-1.png');
    expect(attachmentFileName(new File(['x'], '   ', { type: 'image/jpeg' }), 2)).toBe('pasted-image-3.jpg');
    expect(attachmentFileName(new File(['x'], '', { type: 'application/pdf' }), 0)).toBe('pasted-file-1');
  });
});
