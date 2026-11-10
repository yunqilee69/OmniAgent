/**
 * Minimal ZIP reader for Office Open XML previews (`.docx`, `.xlsx`).
 *
 * Only what those containers need: locate the central directory, then inflate
 * the few entries a viewer names. Decompression rides the platform
 * `DecompressionStream`, so the feature costs no dependency; a browser without
 * it reports an unsupported preview instead of a broken one.
 */

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const END_RECORD_SIZE = 22;
const MAX_COMMENT = 0xffff;

interface CentralEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

/** Whether this browser can inflate a deflated entry. */
export function supportsZipPreview(): boolean {
  return typeof DecompressionStream === 'function';
}

function findEndRecord(view: DataView): number {
  const earliest = Math.max(0, view.byteLength - END_RECORD_SIZE - MAX_COMMENT);
  for (let offset = view.byteLength - END_RECORD_SIZE; offset >= earliest; offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new Error('Not an Office Open XML file.');
}

function readCentralDirectory(view: DataView, decoder: TextDecoder): CentralEntry[] {
  const end = findEndRecord(view);
  const count = view.getUint16(end + 10, true);
  let cursor = view.getUint32(end + 16, true);
  const entries: CentralEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > view.byteLength || view.getUint32(cursor, true) !== CENTRAL_DIRECTORY_ENTRY) break;
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    entries.push({
      name: decoder.decode(new Uint8Array(view.buffer, view.byteOffset + cursor + 46, nameLength)),
      method: view.getUint16(cursor + 10, true),
      compressedSize: view.getUint32(cursor + 20, true),
      localOffset: view.getUint32(cursor + 42, true),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function inflateRaw(compressed: Uint8Array): Promise<Uint8Array> {
  // Copy into an owned buffer first: the entry is a view onto the whole
  // container, and both Blob and the inflater read the copy's own ArrayBuffer.
  const owned = new Uint8Array(compressed.byteLength);
  owned.set(compressed);
  const stream = new Blob([owned]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function entryData(view: DataView, entry: CentralEntry): Uint8Array {
  const header = entry.localOffset;
  if (header + 30 > view.byteLength || view.getUint32(header, true) !== LOCAL_FILE_HEADER) {
    throw new Error('Corrupt ZIP entry.');
  }
  const nameLength = view.getUint16(header + 26, true);
  const extraLength = view.getUint16(header + 28, true);
  const start = header + 30 + nameLength + extraLength;
  return new Uint8Array(view.buffer, view.byteOffset + start, entry.compressedSize);
}

/**
 * Read the requested entries of one ZIP container.
 * @param bytes - the whole container.
 * @param select - which entry names to materialise; unmatched entries stay unread.
 * @returns entry name to inflated bytes, in central-directory order.
 */
export async function unzipSelected(
  bytes: Uint8Array,
  select: (name: string) => boolean,
): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const wanted = readCentralDirectory(view, decoder).filter((entry) => select(entry.name));
  const result = new Map<string, Uint8Array>();
  for (const entry of wanted) {
    const raw = entryData(view, entry);
    // Method 0 is stored verbatim; 8 is deflate. Anything else is unusual enough to ignore.
    if (entry.method === 0) result.set(entry.name, raw.slice());
    else if (entry.method === 8) result.set(entry.name, await inflateRaw(raw));
  }
  return result;
}

/** Decode one XML entry into a document, or undefined when it is absent. */
export function parseXml(entries: Map<string, Uint8Array>, name: string): Document | undefined {
  const bytes = entries.get(name);
  if (bytes === undefined) return undefined;
  const text = new TextDecoder().decode(bytes);
  const document = new DOMParser().parseFromString(text, 'application/xml');
  return document.getElementsByTagName('parsererror').length > 0 ? undefined : document;
}

/** Direct children of one node, by their prefixed tag name (`w:p`). */
export function childrenNamed(node: Node, ...names: readonly string[]): Element[] {
  const wanted = new Set(names);
  const result: Element[] = [];
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 1 && wanted.has((child as Element).nodeName)) result.push(child as Element);
  }
  return result;
}
