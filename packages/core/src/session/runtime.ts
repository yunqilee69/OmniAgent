import { createHash } from 'node:crypto';
import type { AgentProfileDefinition, ModelCapabilities, ModelDescriptor } from '../config/models';
import type { ConfigStore } from '../config/store';
import type { AgentDefinition, AgentCatalog } from '../agents';
import { renderAgentCatalog } from '../agents/prompt';
import type { ReasoningEffort } from '../protocol/reasoning';
import { createCatalogModel } from '../providers/create';
import type { ModelClient } from '../providers/types';
import { discoverSkills, filterSkills, renderSkillCatalog } from '../skills/filesystem';
import type { SkillSummary } from '../skills/filesystem';
import { DEFAULT_SYSTEM_PROMPT } from '../prompts';
import { isMcpToolName } from '../mcp/config';
import { KNOWN_TOOL_NAMES, expandToolSelector } from '../tools/names';
import type { AgentUsage } from './agent-selection';
import { usageAllowsRoot, usageAllowsSubagent } from './agent-selection';
import type { ModelBinding } from './model-binding';
import { defaultModelBinding, resolveModelBinding } from './model-binding';

export interface SessionAgent {
  id: string;
  name: string;
  role: string;
  usage: AgentUsage;
  tools: '*' | ReadonlySet<string>;
  skills: '*' | ReadonlySet<string>;
}

export interface ResolvedSessionRuntime {
  agent: AgentDefinition;
  sessionAgent: SessionAgent;
  /** Skills discovered, filtered by the agent profile or mode override. */
  skills: SkillSummary[];
  model?: ModelClient;
  modelId?: string;
  modelBinding: ModelBinding;
  modelDescriptor?: ModelDescriptor;
  reasoningEffort?: ReasoningEffort;
  capabilities: ModelCapabilities;
  /** Whether todo_write may keep several items in_progress at once. */
  todoAllowParallelInProgress: boolean;
  system: string;
  contextWindowTokens?: number;
  warnings: string[];
  revision: string;
}

export interface SessionModeOverride {
  id: string;
  tools: '*' | readonly string[];
  skills: '*' | readonly string[];
}

export interface ResolveSessionInput {
  cwd: string;
  agentId: string;
  binding?: ModelBinding;
  isRoot: boolean;
  /** Immutable mode composition copied from the session's `mode/selected` event. */
  mode?: SessionModeOverride;
}

export interface RuntimeResolverOptions {
  configStore: ConfigStore;
  agents: AgentCatalog;
}

function revisionOf(parts: readonly (string | undefined)[]): string {
  return createHash('sha256').update(parts.filter((part) => part !== undefined).join('\0')).digest('hex');
}

function toolsForSelector(
  selector: '*' | readonly string[],
  label: string,
): '*' | string[] {
  const expanded = expandToolSelector(selector);
  if (expanded === '*') return '*';
  const unknown = expanded.filter((name) => !KNOWN_TOOL_NAMES.has(name) && !isMcpToolName(name));
  if (unknown.length > 0) throw new Error(`${label} contains unknown tool(s): ${unknown.join(', ')}`);
  return expanded;
}

function skillsForSelector(selector: '*' | readonly string[]): '*' | Set<string> {
  return selector === '*' ? '*' : new Set(selector);
}

export class RuntimeResolver {
  constructor(private readonly options: RuntimeResolverOptions) {}

  get agentCatalog(): AgentCatalog {
    return this.options.agents;
  }

  async resolve(input: ResolveSessionInput): Promise<ResolvedSessionRuntime> {
    const configSnapshot = await this.options.configStore.refresh();
    const catalog = configSnapshot.catalog;
    const agentSnapshot = await this.options.agents.refresh(catalog);
    const agent = this.options.agents.get(input.agentId);
    if (!agent) {
      const error = agentSnapshot.errors.find((entry) => entry.id === input.agentId);
      throw new Error(error?.error ?? `Unknown agent "${input.agentId}"`);
    }
    if (input.isRoot && !usageAllowsRoot(agent.usage)) {
      throw new Error(`Agent "${agent.id}" is not available as a main agent`);
    }
    if (!input.isRoot && !usageAllowsSubagent(agent.usage)) {
      throw new Error(`Agent "${agent.id}" is not available as a subagent`);
    }

    const profile = catalog.profiles.get(agent.profile);
    if (!profile) throw new Error(`Agent "${agent.id}" references unknown profile "${agent.profile}"`);
    const tools = input.mode === undefined
      ? toolsForSelector(profile.tools, `Agent profile "${profile.id}"`)
      : toolsForSelector(input.mode.tools, `Mode "${input.mode.id}"`);
    const skills = skillsForSelector(input.mode?.skills ?? profile.skills);

    const warnings = [...configSnapshot.catalog.warnings];
    let availableSkills: SkillSummary[] = [];
    try {
      const discovered = await discoverSkills({ workspace: input.cwd });
      availableSkills = filterSkills(discovered, skills);
      if (skills !== '*') {
        const discoveredNames = new Set(discovered.map((skill) => skill.name));
        for (const name of skills) {
          if (!discoveredNames.has(name)) warnings.push(`Skill "${name}" is not present in this workspace`);
        }
      }
    } catch {
      warnings.push('Skill discovery failed; no skills are available in this session');
      availableSkills = [];
    }

    const binding = input.binding ?? defaultModelBinding();
    let resolvedModel;
    try {
      resolvedModel = resolveModelBinding(catalog, agent.role, binding);
    } catch (error) {
      const demoDefault = binding.kind === 'agent' && agent.role === 'default' &&
        !catalog.roles.has('default') && !catalog.roleErrors.has('default');
      if (!demoDefault) throw error;
      resolvedModel = { binding };
    }

    let model: ModelClient | undefined;
    if (resolvedModel.model) {
      model = createCatalogModel(configSnapshot.config, resolvedModel.model, resolvedModel.reasoningEffort);
    }

    const hasSkillTool = tools === '*' || tools.includes('skill');
    const hasSubagentTool = tools === '*' || tools.includes('subagent');
    const skillCatalog = hasSkillTool ? renderSkillCatalog(availableSkills) : '';
    const agentCatalog = hasSubagentTool ? renderAgentCatalog(agentSnapshot.agents) : '';
    const baseSystem = [configSnapshot.config.system, agent.body].filter(Boolean).join('\n\n')
      || DEFAULT_SYSTEM_PROMPT;
    const system = [baseSystem, skillCatalog, agentCatalog].filter(Boolean).join('\n\n');

    const contextWindowTokens = configSnapshot.config.contextWindowTokens ?? resolvedModel.model?.contextWindow;
    const todoAllowParallelInProgress = configSnapshot.config.todo?.allowParallelInProgress ?? false;
    const revision = revisionOf([
      configSnapshot.revision,
      agentSnapshot.revision,
      agent.id,
      agent.role,
      agent.profile,
      input.mode?.id,
      JSON.stringify(binding),
      resolvedModel.reasoningEffort,
      tools === '*' ? '*' : [...tools].sort().join(','),
      skills === '*' ? '*' : [...skills].sort().join(','),
      availableSkills.map((skill) => skill.name).sort().join(','),
      String(todoAllowParallelInProgress),
    ]);

    return {
      agent,
      sessionAgent: {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        usage: agent.usage,
        tools: tools === '*' ? '*' : new Set(tools),
        skills,
      },
      skills: availableSkills.map((skill) => ({ ...skill })),
      ...(model === undefined ? {} : { model }),
      ...(resolvedModel.model === undefined ? {} : { modelId: resolvedModel.model.id }),
      modelBinding: binding,
      ...(resolvedModel.model === undefined ? {} : { modelDescriptor: resolvedModel.model }),
      ...(resolvedModel.reasoningEffort === undefined ? {} : { reasoningEffort: resolvedModel.reasoningEffort }),
      capabilities: resolvedModel.model?.capabilities ?? { imageInput: false },
      todoAllowParallelInProgress,
      system,
      ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
      warnings,
      revision,
    };
  }
}
