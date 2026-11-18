/**
 * Web implementation of the Creator configuration port.
 *
 * The model-facing tools live in core; this adapter maps them onto the
 * existing settings services. Keeping the stores here means the Web settings
 * pages and the Creator share one validation and write path.
 */

import { KNOWN_TOOL_NAMES, discoverSkills } from '@omniagent/core';
import type {
  CreatorGeneralSettings,
  CreatorMcpServerList,
  CreatorMcpServerSummary,
  CreatorMcpServerWrite,
  CreatorModeOptions,
  CreatorModeService,
  CreatorModelSourceService,
  CreatorRoleService,
  CreatorServices,
} from '@omniagent/core';
import type { ModeStore } from '@omniagent/core';
import type { ArchiveConfigSettings } from './archive-settings';
import type { RoleSettings } from './catalog-settings';
import type { McpSettings } from './mcp-settings';
import type { ModelSettings } from './model-settings';
import type { PermissionSettings } from './permissions';
import type { AskUserConfigSettings } from './ask-user-settings';

export interface CreatorSettingsSources {
  modes: ModeStore;
  roles: RoleSettings;
  modelSources: ModelSettings;
  permissions: PermissionSettings;
  askUser: AskUserConfigSettings;
  archive: ArchiveConfigSettings;
  mcp: McpSettings;
  /** Live MCP tool names, so a mode can allowlist mcp__<server>__<tool>. */
  mcpToolNames?: () => readonly string[];
}

export function createCreatorServices(sources: CreatorSettingsSources): CreatorServices {
  const modes: CreatorModeService = {
    list: () => sources.modes.list(),
    save: (id, input) => sources.modes.save(id, input),
    remove: (id) => sources.modes.remove(id),
    defaultId: () => sources.modes.defaultId(),
    setDefault: (id) => sources.modes.setDefault(id),
    async options(cwd): Promise<CreatorModeOptions> {
      const skills = await discoverSkills({ workspace: cwd });
      return {
        tools: [...new Set([...KNOWN_TOOL_NAMES, ...(sources.mcpToolNames?.() ?? [])])]
          .sort((left, right) => left.localeCompare(right)),
        skills: skills.map((skill) => skill.name),
      };
    },
  };

  const roles: CreatorRoleService = {
    list: async () => (await sources.roles.list()).roles,
    save: (id, input) => sources.roles.save(id, input),
    remove: (id) => sources.roles.remove(id),
  };

  const modelSources: CreatorModelSourceService = {
    list: () => sources.modelSources.list(),
    save: (id, input) => sources.modelSources.save(id, input),
    remove: (id) => sources.modelSources.remove(id),
    discover: (input) => sources.modelSources.discover(input),
  };

  const settings = {
    async read(): Promise<CreatorGeneralSettings> {
      const [permissions, archive, askUser, defaultMode] = await Promise.all([
        sources.permissions.read(),
        sources.archive.read(),
        sources.askUser.read(),
        sources.modes.defaultId(),
      ]);
      return { permissions, archive, askUser, defaultMode };
    },
    updatePermission: (input: { defaultPreset: 'read-only' | 'workspace-write' }) =>
      sources.permissions.update({ defaultPreset: input.defaultPreset }),
    updateArchive: (input: { enabled: boolean; retentionMs: number }) =>
      sources.archive.update({ enabled: input.enabled, retentionMs: input.retentionMs }),
    updateAskUser: (input: { timeoutSec: number }) =>
      sources.askUser.update({ timeoutSec: input.timeoutSec }),
  };

  const mcp = {
    list: (): Promise<CreatorMcpServerList> => sources.mcp.list(),
    save: (id: string, input: CreatorMcpServerWrite): Promise<CreatorMcpServerSummary> =>
      sources.mcp.save(id, input),
    remove: (id: string): Promise<boolean> => sources.mcp.remove(id),
    test: (id: string) => sources.mcp.test(id),
  };

  return { modes, roles, modelSources, settings, mcp };
}
