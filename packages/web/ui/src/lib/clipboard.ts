/**
 * Clipboard file extraction for the composer.
 *
 * Safari and Chromium expose pasted screenshots and copied files through the
 * clipboard `files` list; `items` is the fallback for engines that only fill
 * item entries. Text-only pastes produce no files and stay on the textarea's
 * default paste path.
 */
export interface ClipboardDataLike {
  files?: ArrayLike<File> | null;
  items?: ArrayLike<{ kind: string; getAsFile(): File | null }> | null;
}

export function clipboardFiles(data: ClipboardDataLike | null): File[] {
  if (data === null) return [];
  const files = data.files === null || data.files === undefined ? [] : Array.from(data.files);
  if (files.length > 0) return files;
  if (data.items === null || data.items === undefined) return [];
  const picked: File[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file !== null) picked.push(file);
  }
  return picked;
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** Screenshots and Finder copies sometimes arrive without a name. */
export function attachmentFileName(file: File, index = 0): string {
  if (file.name.trim() !== '') return file.name;
  const extension = IMAGE_EXTENSIONS[file.type];
  return extension === undefined ? `pasted-file-${index + 1}` : `pasted-image-${index + 1}.${extension}`;
}
