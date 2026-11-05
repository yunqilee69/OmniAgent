import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';

/**
 * 工作区在 ~/.omniagent 里的目录名。
 *
 * 不用原始路径当目录：里面有 `/`，同一个仓库从符号链接走进去还会变成两份。
 * 用目录基名加 realpath 的短哈希。基名只是给人看的，哈希才是身份。
 */

const SLUG_MAX = 40;
const HASH_HEX_LENGTH = 12;

export interface WorkspaceId {
  /** 绝对路径，符号链接已解开。 */
  root: string;
  /** `OmniAgent-a1b2c3d4e5f6` 这种目录名。 */
  key: string;
}

export function identifyWorkspace(cwd: string): WorkspaceId {
  const root = realpathSync(resolve(cwd));
  const slug = slugOf(basename(root));
  const hash = createHash('sha256').update(root).digest('hex').slice(0, HASH_HEX_LENGTH);
  return { root, key: `${slug}-${hash}` };
}

function slugOf(name: string): string {
  const slug = name
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, SLUG_MAX);
  return slug.length > 0 ? slug : 'workspace';
}
