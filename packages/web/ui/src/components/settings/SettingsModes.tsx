import { useEffect, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  Button,
  Input,
  Modal,
  Tag,
  type MenuEntry,
} from '../../../vendor/primitives/index.ts';
import { store, useApp } from '../../lib/store.ts';
import { translator, type Translate } from '../../lib/i18n.ts';
import type { ModeMember, ModeSummary } from '../../lib/wire.ts';
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
  const [kind, setKind] = useState<'single' | 'team'>(editing?.type ?? 'single');
  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [members, setMembers] = useState<ModeMember[]>(editing?.members ?? []);
  const [maxActive, setMaxActive] = useState(String(editing?.policy.maxActive ?? 3));
  const [agent, setAgent] = useState(editing?.agent ?? app.agents.find((item) => item.id === 'default' && item.valid)?.id ?? app.agents[0]?.id ?? '');
  const [binding, setBinding] = useState<ModeSummary['model']>(editing?.model ?? { version: 2, kind: 'agent' });

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const agents = app.agents.filter((item) => item.valid && item.usage !== 'subagent');
  const agentItems: MenuEntry[] = agents.map((item) => ({ id: item.id, label: `${item.name} · ${item.role}` }));

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
    if (kind === 'team' && members.length === 0) {
      setError(t('A team mode needs at least one member.'));
      return;
    }
    setSaving(true);
    const failure = await store.saveMode(id, {
      type: kind,
      name: name.trim(),
      description: description.trim(),
      agent,
      model: binding,
      tools: '*',
      skills: '*',
      ...(kind === 'team' ? {
        members,
        policy: {
          maxActive: Math.min(8, Math.max(1, Math.floor(Number(maxActive)) || 3)),
          maxSteps: editing?.policy.maxSteps ?? 100,
          failure: editing?.policy.failure ?? 'continue',
          allowPlan: editing?.policy.allowPlan ?? false,
          allowGoal: editing?.policy.allowGoal ?? false,
        },
      } : {}),
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
          <span className={css.fieldLabel}>{t('Mode type')}</span>
          <SelectMenu
            value={kind}
            items={[{ id: 'single', label: t('Single agent') }, { id: 'team', label: t('Team') }]}
            onSelect={(value) => { if (value === 'single' || value === 'team') setKind(value); }}
            ariaLabel={t('Mode type')}
            title={t('Mode type')}
            triggerClassName={css.editorSelect}
          >
            {kind === 'team' ? t('Team') : t('Single agent')}
          </SelectMenu>
        </div>
        <div className={css.field}>
          <span className={css.fieldLabel}>{kind === 'team' ? t('Coordinator') : t('Agent')}</span>
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

        {kind === 'team' && (
          <section className={css.choiceGroup}>
            <div className={css.choiceHead}>
              <span className={css.fieldLabel}>{t('Team members')}</span>
              <Button variant="outline" size="sm" onClick={() => {
                const memberAgent = app.agents.find((item) => item.valid && item.usage !== 'primary')?.id ?? agent;
                setMembers((current) => [...current, {
                  id: `member-${current.length + 1}`,
                  name: t('Member {count}', { count: current.length + 1 }),
                  agent: memberAgent,
                  model: { version: 2, kind: 'agent' },
                  prompt: '',
                  tools: '*',
                  skills: '*',
                }]);
              }}>{t('Add member')}</Button>
            </div>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('Max parallel members')}</span>
              <Input value={maxActive} onChange={(event) => { setMaxActive(event.target.value); }} />
            </label>
            {members.map((member, index) => (
              <article key={`${member.id}-${index}`} className={css.memberEditor}>
                <div className={css.memberHead}>
                  <strong>{member.name.trim() || t('Member {count}', { count: index + 1 })}</strong>
                  <Button variant="outline" size="sm" onClick={() => { setMembers((current) => current.filter((_, itemIndex) => itemIndex !== index)); }}>{t('Remove')}</Button>
                </div>
                <div className={css.editorGrid}>
                  <label className={css.field}>
                    <span className={css.fieldLabel}>{t('Member id')}</span>
                    <Input value={member.id} aria-label={t('Member id')} onChange={(event) => {
                    const value = event.target.value;
                    setMembers((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, id: value } : item));
                  }} />
                  </label>
                  <label className={css.field}>
                    <span className={css.fieldLabel}>{t('Member name')}</span>
                    <Input value={member.name} aria-label={t('Member name')} onChange={(event) => {
                    const value = event.target.value;
                    setMembers((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, name: value } : item));
                  }} />
                  </label>
                  <label className={css.field}>
                    <span className={css.fieldLabel}>{t('Member agent')}</span>
                      <SelectMenu
                      value={member.agent}
                      items={app.agents.filter((item) => item.valid && item.usage !== 'primary').map((item) => ({ id: item.id, label: item.name }))}
                      onSelect={(value) => { setMembers((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, agent: value } : item)); }}
                      ariaLabel={t('Member agent')}
                      title={t('Member agent')}
                      triggerClassName={css.editorSelect}
                    >
                      {agentName(member.agent, app)}
                    </SelectMenu>
                  </label>
                  <label className={css.field}>
                    <span className={css.fieldLabel}>{t('Member model')}</span>
                    <ModelPicker
                      binding={member.model}
                      models={app.models}
                      roles={app.roles}
                      onSelect={(value) => { setMembers((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, model: value } : item)); }}
                      ariaLabel={t('Member model')}
                      title={t('Member model')}
                      triggerClassName={css.editorSelect}
                    />
                  </label>
                </div>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('Member instructions')}</span>
                  <textarea
                    className={css.memberPrompt}
                    rows={3}
                    value={member.prompt}
                    aria-label={t('Member instructions')}
                    placeholder={t('Optional instructions prepended to every task delegated to this member.')}
                    onChange={(event) => {
                      const value = event.target.value;
                      setMembers((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, prompt: value } : item));
                    }}
                  />
                </label>
              </article>
            ))}
            <p className={css.fieldHint}>{t('Each member uses its agent’s tools and skills. Its model can follow the agent role or override it for this team.')}</p>
          </section>
        )}


        {kind === 'single' && <p className={css.fieldHint}>{t('Tools and skills come from the selected agent. A mode chooses the agent and model; it does not grant extra capabilities.')}</p>}
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
            {mode.type === 'team' && <Tag tone="outline">{t('Team')}</Tag>}
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
          <span>{mode.type === 'team' ? t('{count} members', { count: mode.members.length }) : t('Uses agent capabilities')}</span>
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
            {t('A mode chooses the agent and default model for a new session. Tools and skills come from that agent. The mode cannot be changed afterwards.')}
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
            <p className={css.hint}>{t('No custom modes yet. Create one to choose an agent and its default model.')}</p>
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
