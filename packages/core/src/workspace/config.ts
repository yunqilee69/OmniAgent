import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { PERMISSION_MODES } from '../protocol/permission';

/**
 * 工作区配置：登记根目录，可选覆盖全局权限模式。
 * 文件不存在时创建，已有内容原样保留。
 */

export const WorkspaceConfigSchema = z
  .object({
    /** 工作区根目录，符号链接已解开。 */
    path: z.string().min(1),
    /** 不填时沿用全局配置。 */
    mode: z.enum(PERMISSION_MODES).optional(),
  })
  .passthrough();

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

export async function ensureWorkspaceConfig(
  configPath: string,
  path: string,
): Promise<WorkspaceConfig> {
  const existing = await readWorkspaceConfig(configPath);
  if (existing) {
    return existing;
  }

  const created: WorkspaceConfig = { path };
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(created, null, 2)}\n`, 'utf8');
  return created;
}

export async function readWorkspaceConfig(
  configPath: string,
): Promise<WorkspaceConfig | undefined> {
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
  return WorkspaceConfigSchema.parse(JSON.parse(raw));
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}
