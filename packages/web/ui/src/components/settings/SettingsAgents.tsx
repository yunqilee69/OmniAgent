import { useEffect, useState, type ReactNode } from 'react';
import { Button, Checkbox, Input, Modal, Tag } from '../../../vendor/primitives/index.ts';
import { SelectMenu } from '../SelectMenu.tsx';
import { store, useApp } from '../../lib/store.ts';
import { translator, type Translate } from '../../lib/i18n.ts';
import type { AgentDefinitionDetail, AgentDefinitionWrite, AgentSummary } from '../../lib/wire.ts';
import css from '../../styles/settings.module.css';

const AGENT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function toggleSet(values: Set<string>, value: string): Set<string> {
  const next = new Set(values);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function CapabilityPicker({ label, allLabel, all, values, options, empty, onAll, onToggle }: {
  label: string;
  allLabel: string;
  all: boolean;
  values: Set<string>;
  options: { id: string; label: string }[];
  empty: string;
  onAll: (value: boolean) => void;
  onToggle: (value: string) => void;
}): ReactNode {
  return (
    <section className={css.choiceGroup}>
      <div className={css.choiceHead}>
        <span className={css.fieldLabel}>{label}</span>
        <Checkbox checked={all} label={allLabel} onChange={onAll} />
      </div>
      {!all && (
        <div className={css.choiceGrid}>
          {options.map((option) => (
            <Checkbox key={option.id} checked={values.has(option.id)} label={option.label} onChange={() => { onToggle(option.id); }} />
          ))}
          {options.length === 0 && <p className={css.hint}>{empty}</p>}
        </div>
      )}
    </section>
  );
}

function usageText(usage: AgentSummary['usage'], t: Translate): string {
  if (usage === 'primary') return t('Main agent');
  if (usage === 'subagent') return t('Subagent only');
  return t('Main and subagent');
}

function usageLabel(agent: AgentSummary, t: Translate): string {
  return usageText(agent.usage, t);
}

function roleLabel(agent: AgentSummary, app: ReturnType<typeof useApp>): string {
  const role = app.roles.find((item) => item.id === agent.role);
  if (role === undefined) return agent.role;
  return `${role.name} · ${role.provider}/${role.model}${role.reasoningEffort === undefined ? '' : ` · ${role.reasoningEffort}`}`;
}

function AgentRow({ agent, t, onEdit }: {
  agent: AgentSummary;
  t: Translate;
  onEdit?: () => void;
}): ReactNode {
  const app = useApp();
  return (
    <li className={css.agentRow}>
      <div className={css.agentRowHead}>
        <div className={css.agentIdentity}>
          <span className={css.modelName}>
            {agent.name}
            {agent.builtIn === true && <Tag tone="outline">{t('Built-in')}</Tag>}
            {!agent.valid && <Tag tone="outline">{t('Invalid')}</Tag>}
          </span>
          <code className={css.modelId}>{agent.id}</code>
          <span className={css.agentDescription}>{agent.description || t('No description.')}</span>
        </div>
        {onEdit !== undefined && (
          <Button variant="outline" size="sm" onClick={onEdit}>{t('Edit')}</Button>
        )}
      </div>
      <div className={css.agentMeta}>
        <span>{usageLabel(agent, t)}</span>
        <span className={css.presetDot} aria-hidden>·</span>
        <span>{t('Role: {role}', { role: roleLabel(agent, app) })}</span>
        <span className={css.presetDot} aria-hidden>·</span>
        <span>{agent.tools === '*' ? t('All tools') : t('{count} tools', { count: agent.tools?.length ?? 0 })}</span>
      </div>
      {!agent.valid && agent.warnings.length > 0 && (
        <span className={css.presetWarning} role="alert">{agent.warnings.join(' · ')}</span>
      )}
    </li>
  );
}

interface AgentEditorProps {
  editing: AgentSummary | null;
  onClose: () => void;
}

/**
 * Manual definition editor for `~/.omniagent/agents/<id>.md`. The id is fixed
 * after creation; role ids come from the current config catalog.
 */
function AgentEditor({ editing, onClose }: AgentEditorProps): ReactNode {
  const app = useApp();
  const t = translator(app.locale);
  const [id, setId] = useState(editing?.id ?? '');
  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [role, setRole] = useState(editing?.role ?? 'default');
  const [usage, setUsage] = useState<AgentSummary['usage']>(editing?.usage ?? 'both');
  const [allTools, setAllTools] = useState(true);
  const [tools, setTools] = useState<Set<string>>(new Set());
  const [allSkills, setAllSkills] = useState(true);
  const [skills, setSkills] = useState<Set<string>>(new Set());
  const [allMcp, setAllMcp] = useState(true);
  const [mcp, setMcp] = useState<Set<string>>(new Set());
  const [instructions, setInstructions] = useState('');
  const [loading, setLoading] = useState(editing !== null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void store.loadModeOptions();
    void store.loadMcpServers();
  }, []);

  useEffect(() => {
    let active = true;
    void store.loadAgentDefinition(editing?.id ?? null).then((loaded) => {
      if (!active) return;
      if (loaded === null) {
        setLoading(false);
        return;
      }
      if (loaded.agent !== null) {
        const agent: AgentDefinitionDetail = loaded.agent;
        setName(agent.name);
        setDescription(agent.description);
        setRole(agent.role);
        setUsage(agent.usage);
        setAllTools(agent.tools === '*');
        setTools(new Set(agent.tools === '*' ? [] : agent.tools));
        setAllSkills(agent.skills === '*');
        setSkills(new Set(agent.skills === '*' ? [] : agent.skills));
        setAllMcp(agent.mcp === '*');
        setMcp(new Set(agent.mcp === '*' ? [] : agent.mcp));
        setInstructions(agent.instructions);
      }
      setLoading(false);
    });
    return () => { active = false; };
  }, [editing]);

  const roleItems = app.roles.map((item) => ({ id: item.id, label: `${item.name} (${item.id})` }));
  if (!roleItems.some((item) => item.id === role)) roleItems.unshift({ id: role, label: role });
  const usageItems = [
    { id: 'both', label: t('Main and subagent') },
    { id: 'primary', label: t('Main agent') },
    { id: 'subagent', label: t('Subagent only') },
  ];

  const save = async (): Promise<void> => {
    setError('');
    if (!AGENT_ID.test(id.trim())) {
      setError(t('Agent id must use lowercase letters, digits, dots, dashes or underscores.'));
      return;
    }
    if (name.trim() === '') {
      setError(t('Agent name is required.'));
      return;
    }
    const input: AgentDefinitionWrite = {
      name: name.trim(),
      description: description.trim(),
      role,
      usage,
      tools: allTools ? '*' : [...tools].sort(),
      skills: allSkills ? '*' : [...skills].sort(),
      mcp: allMcp ? '*' : [...mcp].sort(),
      instructions,
      ...(editing === null ? {} : { overwrite: true }),
    };
    setSaving(true);
    const ok = await store.saveAgentDefinition(id.trim(), input);
    setSaving(false);
    if (ok) onClose();
    else setError(t('The agent could not be saved.'));
  };

  const remove = async (): Promise<void> => {
    if (editing === null || editing.builtIn === true) return;
    setSaving(true);
    const ok = await store.deleteAgentDefinition(editing.id);
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={editing === null ? t('New agent') : t('Edit agent')}
      closeLabel={t('Close')}
      className={css.editorDialog}
      footer={(
        <div className={css.editorFooter}>
          {editing !== null && editing.builtIn !== true && (
            <Button variant="outline" onClick={() => { void remove(); }} disabled={saving}>{t('Delete')}</Button>
          )}
          <span className={css.editorFooterGap} />
          <Button variant="outline" onClick={onClose} disabled={saving}>{t('Cancel')}</Button>
          <Button variant="primary" onClick={() => { void save(); }} disabled={saving || loading}>
            {saving ? t('Saving…') : t('Save')}
          </Button>
        </div>
      )}
    >
      <div className={css.editorForm}>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('Agent id')}</span>
          <Input value={id} disabled={editing !== null} placeholder="helper"
            onChange={(event) => { setId(event.target.value); }} />
          <span className={css.fieldHint}>
            {t('Used as the Markdown file name in ~/.omniagent/agents; cannot be changed later.')}
          </span>
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('Display name')}</span>
          <Input value={name} placeholder={id || t('Default')} onChange={(event) => { setName(event.target.value); }} />
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('Description')}</span>
          <Input value={description} placeholder={t('What this agent is for')}
            onChange={(event) => { setDescription(event.target.value); }} />
        </label>
        <div className={css.editorGrid}>
          <div className={css.field}>
            <span className={css.fieldLabel}>{t('Role')}</span>
            <SelectMenu
              value={role}
              items={roleItems}
              onSelect={setRole}
              ariaLabel={t('Role')}
              title={t('Role')}
              triggerClassName={css.editorSelect}
            >
              {roleItems.find((item) => item.id === role)?.label ?? role}
            </SelectMenu>
            <span className={css.fieldHint}>{t('The agent uses this role to resolve its model.')}</span>
          </div>
          <div className={css.field}>
            <span className={css.fieldLabel}>{t('Usage')}</span>
            <SelectMenu
              value={usage}
              items={usageItems}
              onSelect={(value) => { setUsage(value as AgentSummary['usage']); }}
              ariaLabel={t('Usage')}
              title={t('Usage')}
              triggerClassName={css.editorSelect}
            >
              {usageText(usage, t)}
            </SelectMenu>
            <span className={css.fieldHint}>{t('Where this agent can run: as a main agent, a subagent, or both.')}</span>
          </div>
        </div>
        <CapabilityPicker
          label={t('Tools')}
          allLabel={t('All tools')}
          all={allTools}
          values={tools}
          options={app.modeOptions.tools.map((tool) => ({ id: tool, label: tool }))}
          empty={t('Loading tool catalog…')}
          onAll={setAllTools}
          onToggle={(value) => { setTools((current) => toggleSet(current, value)); }}
        />
        <CapabilityPicker
          label={t('Skills')}
          allLabel={t('All skills')}
          all={allSkills}
          values={skills}
          options={app.modeOptions.skills.map((skill) => ({ id: skill.name, label: skill.description === '' ? skill.name : `${skill.name} · ${skill.description}` }))}
          empty={t('No skills were discovered in this workspace.')}
          onAll={setAllSkills}
          onToggle={(value) => { setSkills((current) => toggleSet(current, value)); }}
        />
        <CapabilityPicker
          label={t('MCP servers')}
          allLabel={t('All MCP servers')}
          all={allMcp}
          values={mcp}
          options={app.mcpServers.map((server) => ({ id: server.id, label: server.id }))}
          empty={t('No MCP servers are configured.')}
          onAll={setAllMcp}
          onToggle={(value) => { setMcp((current) => toggleSet(current, value)); }}
        />
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('Instructions')}</span>
          <textarea
            className={css.agentInstructions}
            value={instructions}
            rows={10}
            placeholder={t('Describe the agent identity, responsibilities, constraints and working style.')}
            onChange={(event) => { setInstructions(event.target.value); }}
          />
          <span className={css.fieldHint}>{t('Written as the Markdown body of the definition and used as the system prompt for this agent.')}</span>
        </label>
        {loading && <p className={css.hint}>{t('Loading…')}</p>}
        {error !== '' && <p className={css.formError} role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

/**
 * Agent catalog. Modes choose one of these agents; the two built-ins are
 * 通用智能体 and 创造智能体. Custom definitions can be written manually here or
 * authored through a conversation in Creator mode.
 */
export function SettingsAgents(): ReactNode {
  const app = useApp();
  const t = translator(app.locale);
  const [creatorError, setCreatorError] = useState('');
  const [editor, setEditor] = useState<{ editing: AgentSummary | null } | null>(null);
  const startCreator = async (): Promise<void> => {
    setCreatorError('');
    const failure = await store.startCreatorSession();
    if (failure !== null) setCreatorError(failure);
  };
  const builtIn = app.agents
    .filter((agent) => agent.builtIn === true)
    .sort((left, right) => {
      const order = (id: string): number => id === 'default' ? 0 : id === 'creator' ? 1 : 2;
      return order(left.id) - order(right.id) || left.id.localeCompare(right.id);
    });
  const custom = app.agents
    .filter((agent) => agent.builtIn !== true && agent.valid)
    .sort((left, right) => left.name.localeCompare(right.name));
  const broken = app.agents.filter((agent) => !agent.valid);

  return (
    <section className={css.page}>
      <header className={css.pageHead}>
        <div>
          <h2 className={css.pageTitle}>{t('Agents')}</h2>
          <p className={css.pageIntro}>
            {t('Agents define identity, instructions, tools and skills. A mode chooses one agent and its default model.')}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => { void startCreator(); }}>{t('Create agent in Creator mode')}</Button>
      </header>

      {creatorError !== '' && (
        <div className={css.error} role="alert">
          <span>{t('Could not start Creator mode: {message}', { message: creatorError })}</span>
          <Button variant="outline" size="sm" onClick={() => { void store.loadModes(); }}>{t('Retry')}</Button>
        </div>
      )}

      {app.agentsError !== '' && (
        <div className={css.error}>
          <span>{t('Could not load agents: {message}', { message: app.agentsError })}</span>
          <Button variant="outline" size="sm" onClick={() => { void store.loadCatalogs(); }}>{t('Retry')}</Button>
        </div>
      )}
      {app.agentsLoading && <p className={css.hint}>{t('Loading…')}</p>}

      <section className={css.group}>
        <h3 className={css.groupHead}>{t('Built-in agents')}</h3>
        <ul className={css.agentList}>
          {builtIn.map((agent) => <AgentRow key={agent.id} agent={agent} t={t} />)}
        </ul>
      </section>

      <section className={css.group}>
        <div className={css.groupHeadRow}>
          <h3 className={css.groupHead}>{t('Custom agents')}</h3>
          <Button variant="outline" size="sm" onClick={() => { setEditor({ editing: null }); }}>{t('New agent')}</Button>
        </div>
        {custom.length === 0 && !app.agentsLoading ? (
          <p className={css.hint}>
            {t('No custom agents yet. Create one manually or start Creator mode and describe the agent you need.')}
          </p>
        ) : (
          <ul className={css.agentList}>
            {custom.map((agent) => (
              <AgentRow key={agent.id} agent={agent} t={t} onEdit={() => { setEditor({ editing: agent }); }} />
            ))}
          </ul>
        )}
      </section>

      {broken.length > 0 && (
        <section className={css.group}>
          <h3 className={css.groupHead}>{t('Unavailable definitions')}</h3>
          <ul className={css.agentList}>
            {broken.map((agent) => <AgentRow key={agent.id} agent={agent} t={t} />)}
          </ul>
        </section>
      )}

      {editor !== null && (
        <AgentEditor
          key={editor.editing?.id ?? 'new-agent'}
          editing={editor.editing}
          onClose={() => { setEditor(null); }}
        />
      )}
    </section>
  );
}
