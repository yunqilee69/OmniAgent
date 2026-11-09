import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

export interface Workspace {
  id: string;
  path: string;
  name: string;
  lastUsedAt: number;
  isDefault?: boolean;
}

export class DefaultWorkspaceRemovalError extends Error {
  constructor() {
    super('The default workspace cannot be removed');
  }
}

const queues = new Map<string, Promise<void>>();

function serialize<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(filePath) ?? Promise.resolve();
  const result = previous.then(operation);
  const settled = result.then(() => undefined, () => undefined);
  queues.set(filePath, settled);
  void settled.then(() => {
    if (queues.get(filePath) === settled) queues.delete(filePath);
  });
  return result;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWorkspace(value: unknown): value is Workspace {
  if (typeof value !== 'object' || value === null) return false;
  const workspace = value as Record<string, unknown>;
  return typeof workspace.id === 'string'
    && typeof workspace.path === 'string'
    && typeof workspace.name === 'string'
    && typeof workspace.lastUsedAt === 'number'
    && Number.isFinite(workspace.lastUsedAt)
    && (workspace.isDefault === undefined || typeof workspace.isDefault === 'boolean');
}

export class WorkspaceRegistry {
  private readonly filePath: string;

  constructor(filePath: string) {
    if (!filePath) throw new Error('Workspace registry file path must not be empty');
    this.filePath = resolve(filePath);
  }

  async list(): Promise<Workspace[]> {
    return serialize(this.filePath, async () => (await this.read()).map((workspace) => ({ ...workspace })));
  }

  async get(id: string): Promise<Workspace | undefined> {
    return serialize(this.filePath, async () => {
      const workspace = (await this.read()).find((entry) => entry.id === id);
      return workspace === undefined ? undefined : { ...workspace };
    });
  }

  async add(directory: string, name?: string): Promise<Workspace> {
    return serialize(this.filePath, async () => {
      if (!directory) throw new Error('Workspace directory must not be empty');
      let canonicalPath: string;
      try {
        canonicalPath = await realpath(directory);
        if (!(await stat(canonicalPath)).isDirectory()) {
          throw new Error('path is not a directory');
        }
      } catch (error) {
        throw new Error(`Cannot add workspace directory "${directory}": ${message(error)}`, { cause: error });
      }

      const workspaces = await this.read();
      const existing = workspaces.find((workspace) => workspace.path === canonicalPath);
      if (existing !== undefined) return { ...existing };

      const workspace: Workspace = {
        id: randomUUID(),
        path: canonicalPath,
        name: name?.trim() ? name : basename(canonicalPath) || canonicalPath,
        lastUsedAt: Date.now(),
      };
      workspaces.push(workspace);
      await this.write(workspaces);
      return { ...workspace };
    });
  }

  async ensureDefault(directory: string): Promise<Workspace> {
    await mkdir(directory, { recursive: true });
    const canonicalPath = await realpath(directory);
    if (!(await stat(canonicalPath)).isDirectory()) throw new Error('Default workspace path is not a directory');
    return serialize(this.filePath, async () => {
      const workspaces = await this.read();
      let workspace = workspaces.find((entry) => entry.path === canonicalPath);
      let changed = false;
      for (const entry of workspaces) {
        if (entry !== workspace && entry.isDefault === true) {
          delete entry.isDefault;
          changed = true;
        }
      }
      if (workspace === undefined) {
        workspace = { id: randomUUID(), path: canonicalPath, name: basename(canonicalPath) || canonicalPath, lastUsedAt: Date.now(), isDefault: true };
        workspaces.push(workspace);
        changed = true;
      } else if (workspace.isDefault !== true) {
        workspace.isDefault = true;
        changed = true;
      }
      if (changed) await this.write(workspaces);
      return { ...workspace };
    });
  }

  async remove(id: string): Promise<boolean> {
    return serialize(this.filePath, async () => {
      const workspaces = await this.read();
      const index = workspaces.findIndex((workspace) => workspace.id === id);
      if (index === -1) return false;
      if (workspaces[index]!.isDefault === true) throw new DefaultWorkspaceRemovalError();
      workspaces.splice(index, 1);
      await this.write(workspaces);
      return true;
    });
  }

  async touch(id: string): Promise<Workspace | undefined> {
    return serialize(this.filePath, async () => {
      const workspaces = await this.read();
      const workspace = workspaces.find((entry) => entry.id === id);
      if (workspace === undefined) return undefined;
      workspace.lastUsedAt = Date.now();
      await this.write(workspaces);
      return { ...workspace };
    });
  }

  private async read(): Promise<Workspace[]> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return [];
      throw new Error(`Cannot read workspace registry "${this.filePath}": ${message(error)}`, { cause: error });
    }

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error(`Invalid workspace registry "${this.filePath}": ${message(error)}`, { cause: error });
    }
    if (!Array.isArray(data) || !data.every(isWorkspace)) {
      throw new Error(`Invalid workspace registry "${this.filePath}": expected an array of workspaces`);
    }
    const ids = new Set(data.map((workspace) => workspace.id));
    const paths = new Set(data.map((workspace) => workspace.path));
    if (ids.size !== data.length || paths.size !== data.length) {
      throw new Error(`Invalid workspace registry "${this.filePath}": duplicate ID or path`);
    }
    return data.map(({ id, path, name, lastUsedAt, isDefault }) => ({ id, path, name, lastUsedAt, ...(isDefault === undefined ? {} : { isDefault }) }));
  }

  private async write(workspaces: Workspace[]): Promise<void> {
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      const file = await open(temporaryPath, 'wx', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(workspaces, null, 2)}\n`, 'utf8');
        await file.close();
        await rename(temporaryPath, this.filePath);
      } finally {
        await file.close().catch(() => undefined);
        await unlink(temporaryPath).catch(() => undefined);
      }
    } catch (error) {
      throw new Error(`Cannot write workspace registry "${this.filePath}": ${message(error)}`, { cause: error });
    }
  }
}
