import { useEffect, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  Button,
  Checkbox,
  Input,
  Modal,
  Tag,
  type MenuEntry,
} from '../../../vendor/primitives/index.ts';
import { store, useApp } from '../../lib/store.ts';
import { translator, type Translate } from '../../lib/i18n.ts';
import type { ModeSummary } from '../../lib/wire.ts';
import { SelectMenu } from '../SelectMenu.tsx';
import { ModelPicker } from '../ModelPicker.tsx';
import css from '../../styles/settings.module.css';

function agentName(id: string, app: ReturnType<typeof useApp>): string {
  return app.agents.find((agent) => agent.id === id)?.name ?? id;
}

function bindingLabel(binding: ModeSummary['model'], app: ReturnType<typeof useApp>, t: Translate): string {
  if (binding.kind === 'agent') return t('Follow agent role');
  if (binding.kind === 'role') {
    const roleId = binding.role;
    const role = app.roles.find((item) => item.id === roleId);
    return role === undefined ? `Role · ${roleId}` : `${role.name} · ${role.provider}/${role.model}`;
  }
  const provider = binding.provider;
  const modelId = binding.model;
  const model = app.models.find((item) => item.provider === provider && item.model === modelId);
  return model === undefined ? `${provider}/${modelId}` : `${model.name} · ${provider}`;
}

interface ModeEditorProps {
  editing: ModeSummary | null;
  onClose: () => void;
}

function ModeEditor({ editing, onClose }: ModeEditorProps): ReactNode {
  const app = useApp();
  const t = translator(app.locale);
  const [id, setId] = useState(editing?.id ?? '');
  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [agent, setAgent] = useState(editing?.agent ?? app.agents.find((item) => item.id === 'default' && item.valid)?.id ?? app.agents[0]?.id ?? '');
  const [binding, setBinding] = useState<ModeSummary['model']>(editing?.model ?? { version: 2, kind: 'agent' });
  const initialTools = editing?.tools ?? '*';
  const initialSkills = editing?.skills ?? '*';
  const [allTools, setAllTools] = useState(initialTools === '*');
  const [tools, setTools] = useState<Set<string>>(new Set(initialTools === '*' ? [] : initialTools));
  const [allSkills, setAllSkills] = useState(initialSkills === '*');
  const [skills, setSkills] = useState<Set<string>>(new Set(initialSkills === '*' ? [] : initialSkills));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void store.loadModeOptions();
  }, []);

  const agents = app.agents.filter((item) => item.valid && item.usage !== 'subagent');
  const agentItems: MenuEntry[] = agents.map((item) => ({ id: item.id, label: `${item.name} · ${item.role}` }));

  const toggle = (set: Set<string>, value: string): Set<string> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  const save = async (): Promise<void> => {
    setError('');
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
      setError(t('Mode id must use lowercase letters, digits, dots, dashes or underscores.'));
      return;
    }
    if (name.trim() === '') {
      setError(t('Mode name is required.'));
      return;
    }
    if (agent === '') {
      setError(t('Choose an agent for this mode.'));
      return;
    }
    setSaving(true);
    const failure = await store.saveMode(id, {
      name: name.trim(),
      description: description.trim(),
      agent,
      model: binding,
      tools: allTools ? '*' : [...tools].sort(),
      skills: allSkills ? '*' : [...skills].sort(),
    });
    setSaving(false);
    if (failure === null) onClose();
    else setError(t('Could not save mode: {message}', { message: failure }));
  };

  const remove = async (): Promise<void> => {
    if (editing === null) return;
    setSaving(true);
    const failure = await store.deleteMode(editing.id);
    setSaving(false);
    if (failure === null) onClose();
    else setError(t('Could not delete mode: {message}', { message: failure }));
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={editing === null ? t('New mode') : t('Edit mode')}
      closeLabel={t('Close')}
      className={css.editorDialog}
      footer={(
        <div className={css.editorFooter}>
          {editing !== null && editing.customized && (
            <Button variant="outline" onClick={() => { void remove(); }} disabled={saving}>
              {editing.builtIn ? t('Restore built-in') : t('Delete')}
            </Button>
          )}
          <span className={css.editorFooterGap} />
          <Button variant="outline" onClick={onClose} disabled={saving}>{t('Cancel')}</Button>
          <Button variant="primary" onClick={() => { void save(); }} disabled={saving}>{saving ? t('Saving…') : t('Save')}</Button>
        </div>
      )}
    >
      <div className={css.editorForm}>
        <div className={css.editorGrid}>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('Mode id')}</span>
            <Input value={id} disabled={editing !== null} placeholder="my-mode" onChange={(event) => { setId(event.target.value); }} />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('Display name')}</span>
            <Input value={name} placeholder={t('My mode')} onChange={(event) => { setName(event.target.value); }} />
          </label>
        </div>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('Description')}</span>
          <Input value={description} placeholder={t('What this mode is for.')} onChange={(event) => { setDescription(event.target.value); }} />
        </label>
        <div className={css.field}>
          <span className={css.fieldLabel}>{t('Agent')}</span>
          <SelectMenu
            value={agent}
            items={agentItems}
            onSelect={setAgent}
            ariaLabel={t('Agent')}
            title={t('Agent')}
            triggerClassName={css.editorSelect}
          >
            {agentName(agent, app)}
          </SelectMenu>
        </div>
        <div className={css.field}>
          <span className={css.fieldLabel}>{t('Model source')}</span>
          <ModelPicker
            binding={binding}
            models={app.models}
            roles={app.roles}
            onSelect={setBinding}
            ariaLabel={t('Model source')}
            title={t('Model source')}
            triggerClassName={css.editorSelect}
          />
          <span className={css.fieldHint}>{t('Follow the agent role, a named role, or one model directly. The effort level is chosen with the model.')}</span>
        </div>

        <section className={css.choiceGroup}>
          <div className={css.choiceHead}>
            <span className={css.fieldLabel}>{t('Tools')}</span>
            <Checkbox checked={allTools} label={t('All tools')} onChange={(next) => {
              setAllTools(next);
              if (next) setTools(new Set());
            }} />
          </div>
          {!allTools && (
            <div className={css.choiceGrid}>
              {app.modeOptions.tools.map((tool) => (
                <Checkbox
                  key={tool}
                  checked={tools.has(tool)}
                  label={tool}
                  onChange={() => { setTools((current) => toggle(current, tool)); }}
                />
              ))}
              {app.modeOptions.tools.length === 0 && <p className={css.hint}>{t('Loading tool catalog…')}</p>}
            </div>
          )}
        </section>

        <section className={css.choiceGroup}>
          <div className={css.choiceHead}>
            <span className={css.fieldLabel}>{t('Skills')}</span>
            <Checkbox checked={allSkills} label={t('All skills')} onChange={(next) => {
              setAllSkills(next);
              if (next) setSkills(new Set());
            }} />
          </div>
          {!allSkills && (
            <div className={css.choiceGrid}>
              {app.modeOptions.skills.map((skill) => (
                <Checkbox
                  key={skill.name}
                  checked={skills.has(skill.name)}
                  label={skill.description === '' ? skill.name : `${skill.name} · ${skill.description}`}
                  onChange={() => { setSkills((current) => toggle(current, skill.name)); }}
                />
              ))}
              {app.modeOptions.skills.length === 0 && <p className={css.hint}>{t('No skills were discovered in this workspace. Add .agents/skills or keep All skills.')}</p>}
            </div>
          )}
        </section>
        {error !== '' && <p className={css.formError} role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

interface ModeCardProps {
  mode: ModeSummary;
  isDefault: boolean;
  t: Translate;
  app: ReturnType<typeof useApp>;
  onEdit: () => void;
}

function ModeCard({ mode, isDefault, t, app, onEdit }: ModeCardProps): ReactNode {
  const creator = mode.id === 'creator';
  return (
    <li className={clsx(css.presetCard, isDefault && css.presetCardSelected, !mode.valid && css.presetCardBroken)}>
      <button type="button" className={css.presetMain} onClick={() => { void store.setDefaultMode(mode.id); }} disabled={!mode.valid}>
        <span className={css.presetHead}>
          <span className={css.presetName}>{mode.name}</span>
          <span className={css.badgeRow}>
            {isDefault && <Tag tone="solid">{t('Default')}</Tag>}
            {mode.builtIn && <Tag tone="outline">{t('Built-in')}</Tag>}
            {mode.customized && <Tag tone="outline">{t('Customized')}</Tag>}
          </span>
        </span>
        <span className={css.presetDesc}>{mode.description || t('No description.')}</span>
        <span className={css.presetMeta}>
          <span>{agentName(mode.agent, app)}</span>
          <span className={css.presetDot} aria-hidden>·</span>
          <span>{bindingLabel(mode.model, app, t)}</span>
        </span>
        <span className={css.presetMeta}>
          <span>{mode.tools === '*' ? t('All tools') : t('{count} tools', { count: mode.tools.length })}</span>
          <span className={css.presetDot} aria-hidden>·</span>
          <span>{mode.skills === '*' ? t('All skills') : t('{count} skills', { count: mode.skills.length })}</span>
        </span>
        {!mode.valid && <span className={css.presetWarning} role="alert">{mode.warnings.join(' · ')}</span>}
      </button>
      <div className={css.modeFoot}>
        <Button variant="outline" size="sm" onClick={onEdit}>{t('Edit')}</Button>
        {creator && mode.valid && (
          <Button variant="primary" size="sm" onClick={() => { void store.startCreatorSession(); }}>{t('Start Creator mode')}</Button>
        )}
      </div>
    </li>
  );
}

export function SettingsModes(): ReactNode {
  const app = useApp();
  const t = translator(app.locale);
  const [editor, setEditor] = useState<{ editing: ModeSummary | null } | null>(null);
  const modes = app.modes;
  const builtIn = modes.filter((mode) => mode.builtIn);
  const custom = modes.filter((mode) => !mode.builtIn);

  useEffect(() => {
    void store.loadModes();
  }, []);

  return (
    <section className={css.page}>
      <header className={css.pageHead}>
        <div>
          <h2 className={css.pageTitle}>{t('Mode presets')}</h2>
          <p className={css.pageIntro}>
            {t('A mode sets the agent, default model, tools and skills a new session starts with. Choose it when creating a session; the mode cannot be changed afterwards.')}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => { setEditor({ editing: null }); }}>{t('New mode')}</Button>
      </header>

      {app.modesError !== '' && (
        <div className={css.error}>
          <span>{t('Could not load modes: {message}', { message: app.modesError })}</span>
          <Button variant="outline" size="sm" onClick={() => { void store.loadModes(); }}>{t('Retry')}</Button>
        </div>
      )}
      {app.modesLoading && <p className={css.hint}>{t('Loading…')}</p>}

      <section className={css.group}>
        <h3 className={css.groupHead}>{t('Built-in')}</h3>
        <ul className={css.presetGrid}>
          {builtIn.map((mode) => (
            <ModeCard key={mode.id} mode={mode} isDefault={mode.id === app.defaultMode} t={t} app={app}
              onEdit={() => { setEditor({ editing: mode }); }} />
          ))}
        </ul>
      </section>

      <section className={css.group}>
        <h3 className={css.groupHead}>{t('Custom modes')}</h3>
        {custom.length === 0 && !app.modesLoading ? (
          <div className={css.emptyCustom}>
            <p className={css.hint}>{t('No custom modes yet. Create one to combine an agent with its own model, tools and skills.')}</p>
            <Button variant="outline" onClick={() => { setEditor({ editing: null }); }}>{t('Create a mode')}</Button>
          </div>
        ) : (
          <ul className={css.presetGrid}>
            {custom.map((mode) => (
              <ModeCard key={mode.id} mode={mode} isDefault={mode.id === app.defaultMode} t={t} app={app}
                onEdit={() => { setEditor({ editing: mode }); }} />
            ))}
          </ul>
        )}
      </section>

      {editor !== null && (
        <ModeEditor key={editor.editing?.id ?? 'new'} editing={editor.editing} onClose={() => { setEditor(null); }} />
      )}
    </section>
  );
}
