import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { editFileTool } from './edit-file';
import { readFileTool } from './read-file';
import { writeFileTool } from './write-file';

let workspace: string;

const signal = new AbortController().signal;

beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'omni-fs-tools-')));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function context() {
  return { cwd: workspace, signal };
}

describe('write_file', () => {
  it('creates and then updates a file with the DSH confirmation envelope', async () => {
    const created = await writeFileTool.execute(
      { file_path: 'nested/note.txt', content: 'one\ntwo\n' },
      context(),
    );
    expect(created.content).toBe(
      '<path>nested/note.txt</path>\n<type>file</type>\n<content>\nCreated file\n</content>',
    );
    expect(await readFile(join(workspace, 'nested/note.txt'), 'utf8')).toBe('one\ntwo\n');

    const updated = await writeFileTool.execute(
      { file_path: 'nested/note.txt', content: 'three\n' },
      context(),
    );
    expect(updated.content).toContain('Updated file');
  });

  it('rejects a target that escapes the workspace without creating it', async () => {
    await expect(writeFileTool.execute({ file_path: '../outside.txt', content: 'x' }, context()))
      .rejects.toThrow(/越出工作区/);
  });
});

describe('read_file', () => {
  it('returns numbered lines and an exact end-of-file footer', async () => {
    await writeFile(join(workspace, 'note.txt'), 'alpha\nbeta\ngamma\n');
    const result = await readFileTool.execute({ file_path: 'note.txt' }, context());
    expect(result.content).toContain('1: alpha\n2: beta\n3: gamma');
    expect(result.content).toContain('(End of file - total 3 lines)');
    expect(result.truncated).toBeUndefined();
  });

  it('honors a 1-based offset and a limit', async () => {
    await writeFile(join(workspace, 'note.txt'), 'alpha\nbeta\ngamma\n');
    const result = await readFileTool.execute({ file_path: 'note.txt', offset: 2, limit: 1 }, context());
    expect(result.content).toContain('2: beta');
    expect(result.content).not.toContain('alpha');
    expect(result.content).toContain('(Showing lines 2-2 of 3. Use offset=3 to continue.)');
    expect(result.truncated).toBe(true);
  });

  it('rejects an offset past the end of the file', async () => {
    await writeFile(join(workspace, 'note.txt'), 'one\n');
    await expect(readFileTool.execute({ file_path: 'note.txt', offset: 9 }, context()))
      .rejects.toThrow(/offset 9 is out of range/);
  });

  it('truncates a very long line and caps selected output bytes', async () => {
    await writeFile(join(workspace, 'long.txt'), `${'x'.repeat(2_100)}\n`);
    const result = await readFileTool.execute({ file_path: 'long.txt' }, context());
    expect(result.content).toContain('... (line truncated to 2000 chars)');

    await writeFile(join(workspace, 'wide.txt'), `${'y'.repeat(1_000)}\n`.repeat(60));
    const capped = await readFileTool.execute({ file_path: 'wide.txt' }, context());
    expect(capped.content).toContain('(Output capped.');
    expect(capped.truncated).toBe(true);
  });

  it('rejects binary and invalid UTF-8 files', async () => {
    await writeFile(join(workspace, 'binary.bin'), Buffer.from([0x61, 0x00, 0x62]));
    await expect(readFileTool.execute({ file_path: 'binary.bin' }, context()))
      .rejects.toThrow(/binary file/);

    await writeFile(join(workspace, 'invalid.txt'), Buffer.from([0xff, 0xfe]));
    await expect(readFileTool.execute({ file_path: 'invalid.txt' }, context()))
      .rejects.toThrow(/invalid UTF-8/);
  });
});

describe('edit_file', () => {
  it('replaces one unique literal match', async () => {
    await writeFile(join(workspace, 'note.txt'), 'one\ntwo\n');
    const result = await editFileTool.execute(
      { file_path: 'note.txt', old_string: 'two', new_string: 'TWO' },
      context(),
    );
    expect(result.content).toBe('The file note.txt has been updated successfully.');
    expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe('one\nTWO\n');
  });

  it('rejects an ambiguous match unless replace_all is true', async () => {
    await writeFile(join(workspace, 'note.txt'), 'foo\nfoo\n');
    await expect(editFileTool.execute(
      { file_path: 'note.txt', old_string: 'foo', new_string: 'bar' },
      context(),
    )).rejects.toThrow(/matched 2 times/);

    const result = await editFileTool.execute(
      { file_path: 'note.txt', old_string: 'foo', new_string: 'bar', replace_all: true },
      context(),
    );
    expect(result.content).toContain('All occurrences were successfully replaced');
    expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe('bar\nbar\n');
  });

  it('preserves CRLF line endings and rejects an empty old_string', async () => {
    await writeFile(join(workspace, 'crlf.txt'), 'one\r\ntwo\r\n');
    await editFileTool.execute(
      { file_path: 'crlf.txt', old_string: 'two', new_string: 'TWO' },
      context(),
    );
    expect(await readFile(join(workspace, 'crlf.txt'), 'utf8')).toBe('one\r\nTWO\r\n');

    await expect(editFileTool.execute(
      { file_path: 'crlf.txt', old_string: '', new_string: 'x' },
      context(),
    )).rejects.toThrow(/non-empty/);
  });

  it('preserves the existing file mode when publishing atomically', async () => {
    await writeFile(join(workspace, 'mode.txt'), 'one\n');
    await chmod(join(workspace, 'mode.txt'), 0o640);
    await editFileTool.execute(
      { file_path: 'mode.txt', old_string: 'one', new_string: 'two' },
      context(),
    );
    expect((await stat(join(workspace, 'mode.txt'))).mode & 0o777).toBe(0o640);
  });
});
