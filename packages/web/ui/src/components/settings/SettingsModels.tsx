import { useMemo, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  Button,
  Checkbox,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconChevronUpOutlineRegular,
  IconPlusOutlineRegular,
  IconTrashOutlineRegular,
  Input,
  Modal,
  Switch,
  Tag,
} from '../../../vendor/primitives/index.ts';
import { store, useApp } from '../../lib/store.ts';
import { translator, type Translate } from '../../lib/i18n.ts';
import {
  REASONING_EFFORTS,
  type DiscoveredModel,
  type ModelInputType,
  type ModelSourceModel,
  type ModelSourceSummary,
  type ModelSourceWrite,
  type ReasoningEffort,
  type RoleEntry,
} from '../../lib/wire.ts';
import { SelectMenu } from '../SelectMenu.tsx';
import { ModelPicker } from '../ModelPicker.tsx';
import css from '../../styles/settings.module.css';

const ROLE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SOURCE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MODEL_ID = /^[^\s]+$/;

const protocolLabels: Record<string, string> = {
  'deepseek-messages': 'DeepSeek Messages',
  'openai-completions': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
};

function protocolLabel(api: string | undefined, t: Translate): string {
  if (api === undefined || api === '') return t('Provider default');
  return protocolLabels[api] ?? api;
}

function parseCapacity(text: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kKmM])?\s*$/.exec(text);
  if (match === null) return undefined;
  const base = Number(match[1]);
  if (!Number.isFinite(base) || base <= 0) return undefined;
  const unit = match[2]?.toLowerCase();
  const value = Math.round(base * (unit === 'k' ? 1024 : unit === 'm' ? 1024 * 1024 : 1));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function formatCapacity(value: number | undefined): string {
  if (value === undefined) return '';
  if (value % (1024 * 1024) === 0) return `${value / (1024 * 1024)}M`;
  if (value % 1024 === 0) return `${value / 1024}K`;
  return String(value);
}

interface RoleEditorProps {
  editing: RoleEntry | null;
  prefill?: { provider: string; model: string };
  onClose: () => void;
}

function RoleEditor({ editing, prefill, onClose }: RoleEditorProps): ReactNode {
  const app = useApp();
  const t = translator(app.locale);
  const firstModel = app.models[0];
  const [id, setId] = useState(editing?.id ?? '');
  const [name, setName] = useState(editing?.name ?? '');
  const [provider, setProvider] = useState(editing?.provider ?? prefill?.provider ?? firstModel?.provider ?? '');
  const [model, setModel] = useState(editing?.model ?? prefill?.model ?? firstModel?.model ?? '');
  const [effort, setEffort] = useState(editing?.reasoningEffort ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const selected = app.models.find((item) => item.provider === provider && item.model === model);
  const effortItems = [
    { id: '', label: t('Follow model default') },
    ...(selected?.reasoningEfforts ?? []).map((value) => ({ id: value, label: value })),
  ];
  const binding = provider !== '' && model !== ''
    ? {
      version: 2 as const,
      kind: 'model' as const,
      provider,
      model,
      ...(effort === '' ? {} : { reasoningEffort: effort as ReasoningEffort }),
    }
    : null;

  const save = async (): Promise<void> => {
    setError('');
    if (!ROLE_ID.test(id)) {
      setError(t('Role id must use lowercase letters, digits, dots, dashes or underscores.'));
      return;
    }
    if (provider === '' || model === '') {
      setError(t('Choose a model source for this role.'));
      return;
    }
    setSaving(true);
    const ok = await store.saveRole(id, {
      ...(name.trim() === '' ? {} : { name: name.trim() }),
      provider,
      model,
      ...(effort === '' ? {} : { reasoningEffort: effort }),
    });
    setSaving(false);
    if (ok) onClose();
    else setError(t('The role could not be saved.'));
  };

  const remove = async (): Promise<void> => {
    if (editing === null) return;
    setSaving(true);
    const ok = await store.deleteRole(editing.id);
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={editing === null ? t('New role') : t('Edit role')}
      closeLabel={t('Close')}
      className={css.editorDialog}
      footer={(
        <div className={css.editorFooter}>
          {editing !== null && editing.valid && editing.builtIn !== true && (
            <Button variant="outline" onClick={() => { void remove(); }} disabled={saving}>{t('Delete')}</Button>
          )}
          <span className={css.editorFooterGap} />
          <Button variant="outline" onClick={onClose} disabled={saving}>{t('Cancel')}</Button>
          <Button variant="primary" onClick={() => { void save(); }} disabled={saving}>{saving ? t('Saving…') : t('Save')}</Button>
        </div>
      )}
    >
      <div className={css.editorForm}>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('Role id')}</span>
          <Input value={id} disabled={editing !== null} placeholder="default" onChange={(event) => { setId(event.target.value); }} />
          <span className={css.fieldHint}>{t('Used by modes and API bindings; cannot be changed later.')}</span>
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('Display name')}</span>
          <Input value={name} placeholder={id || t('Default')} onChange={(event) => { setName(event.target.value); }} />
        </label>
        <div className={css.field}>
          <span className={css.fieldLabel}>{t('Model source')}</span>
          <ModelPicker
            binding={binding}
            models={app.models}
            roles={[]}
            allowAgent={false}
            allowRoles={false}
            onSelect={(next) => {
              if (next.kind !== 'model') return;
              setProvider(next.provider);
              setModel(next.model);
              setEffort(next.reasoningEffort ?? '');
            }}
            ariaLabel={t('Model source')}
            title={t('Model source')}
            triggerClassName={css.editorSelect}
          />
        </div>
        <div className={css.field}>
          <span className={css.fieldLabel}>{t('Reasoning effort')}</span>
          <SelectMenu
            value={effort}
            items={effortItems}
            onSelect={setEffort}
            ariaLabel={t('Reasoning effort')}
            title={t('Reasoning effort')}
            triggerClassName={css.editorSelect}
            disabled={selected === undefined || selected.reasoningEfforts.length === 0}
          >
            {effort === '' ? t('Follow model default') : effort}
          </SelectMenu>
          <span className={css.fieldHint}>{t('Optional. Leave it on the model default unless this role needs a specific level.')}</span>
        </div>
        {error !== '' && <p className={css.formError} role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

interface DraftReasoningRow {
  level: ReasoningEffort;
  value: string;
}

interface DraftModel {
  key: number;
  id: string;
  name: string;
  contextWindow: string;
  maxTokens: string;
  input: ModelInputType[];
  reasoningEnabled: boolean;
  reasoningTouched: boolean;
  reasoning: DraftReasoningRow[];
  defaultEffort: string;
  expanded: boolean;
}

interface DraftSource {
  id: string;
  name: string;
  api: string;
  baseURL: string;
  apiKey: string;
  clearApiKey: boolean;
  apiKeyEnv: string;
  clearApiKeyEnv: boolean;
  auth: 'ambient' | false;
  models: DraftModel[];
}

let nextModelKey = 1;

function newModel(): DraftModel {
  return {
    key: nextModelKey++,
    id: '',
    name: '',
    contextWindow: '',
    maxTokens: '',
    input: ['text'],
    reasoningEnabled: false,
    reasoningTouched: false,
    reasoning: [],
    defaultEffort: '',
    expanded: true,
  };
}

function draftFrom(source: ModelSourceSummary): DraftSource {
  return {
    id: source.id,
    name: source.name,
    api: source.api ?? (source.builtIn ? '' : 'openai-completions'),
    baseURL: source.baseURL ?? '',
    apiKey: '',
    clearApiKey: false,
    apiKeyEnv: source.apiKeyEnv ?? '',
    clearApiKeyEnv: false,
    auth: source.auth ?? false,
    models: source.models.length === 0 ? [newModel()] : source.models.map((model) => ({
      key: nextModelKey++,
      id: model.id,
      name: model.name === model.id ? '' : model.name,
      contextWindow: formatCapacity(model.contextWindow),
      maxTokens: formatCapacity(model.maxTokens),
      input: model.input.length === 0 ? ['text'] : [...model.input],
      reasoningEnabled: model.reasoning !== undefined,
      reasoningTouched: false,
      reasoning: model.reasoning === undefined ? [] : REASONING_EFFORTS
        .filter((level) => model.reasoning?.efforts[level] !== undefined)
        .map((level) => ({
          level,
          value: model.reasoning?.efforts[level] === null ? '' : String(model.reasoning?.efforts[level] ?? ''),
        })),
      defaultEffort: model.reasoning?.default ?? '',
      expanded: false,
    })),
  };
}

function newDraft(): DraftSource {
  return {
    id: '',
    name: '',
    api: 'openai-completions',
    baseURL: '',
    apiKey: '',
    clearApiKey: false,
    apiKeyEnv: '',
    clearApiKeyEnv: false,
    auth: false,
    models: [newModel()],
  };
}

function draftReasoning(model: DraftModel): false | { efforts: Record<string, string | number | null>; default?: string } | undefined {
  if (!model.reasoningTouched) return undefined;
  if (!model.reasoningEnabled) return false;
  if (model.reasoning.length === 0) return undefined;
  const efforts: Record<string, string | number | null> = {};
  for (const row of model.reasoning) {
    const value = row.value.trim();
    if (row.level === 'off' && value === '') efforts.off = null;
    else if (value === '') efforts[row.level] = row.level;
    else efforts[row.level] = value;
  }
  if (!Object.keys(efforts).some((level) => level !== 'off')) return undefined;
  const defaultEffort = model.defaultEffort !== '' && Object.hasOwn(efforts, model.defaultEffort)
    ? model.defaultEffort
    : Object.keys(efforts).find((level) => level !== 'off');
  return {
    efforts,
    ...(defaultEffort === undefined ? {} : { default: defaultEffort }),
  };
}

function draftWrite(source: DraftSource): ModelSourceWrite {
  return {
    ...(source.name.trim() === '' ? {} : { name: source.name.trim() }),
    ...(source.api === '' ? {} : { api: source.api }),
    ...(source.baseURL.trim() === '' ? { clearBaseURL: true } : { baseURL: source.baseURL.trim() }),
    ...(source.apiKey.trim() === '' ? {} : { apiKey: source.apiKey.trim() }),
    ...(source.clearApiKey ? { clearApiKey: true } : {}),
    ...(source.apiKeyEnv.trim() === '' ? (source.clearApiKeyEnv ? { clearApiKeyEnv: true } : {})
      : { apiKeyEnv: source.apiKeyEnv.trim() }),
    ...(source.auth === false ? { auth: false } : { auth: source.auth }),
    models: source.models.map((model) => {
      const reasoning = draftReasoning(model);
      return {
        id: model.id.trim(),
        ...(model.name.trim() === '' ? {} : { name: model.name.trim() }),
        ...(parseCapacity(model.contextWindow) === undefined ? {} : { contextWindow: parseCapacity(model.contextWindow)! }),
        ...(parseCapacity(model.maxTokens) === undefined ? {} : { maxTokens: parseCapacity(model.maxTokens)! }),
        input: model.input,
        ...(reasoning === undefined ? {} : { reasoning }),
      };
    }),
  };
}

function validateDraft(source: DraftSource, t: Translate, knownProviders: readonly string[]): string | undefined {
  if (!SOURCE_ID.test(source.id)) return t('Model source id must use lowercase letters, digits, dots, dashes or underscores.');
  if (source.name.trim() === '') return t('Model source name is required.');
  if (source.baseURL.trim() === '' && !knownProviders.includes(source.id.trim())) {
    return t('A custom model source needs a base URL.');
  }
  if (source.api === 'deepseek-messages' && source.id.trim() !== 'deepseek-official') {
    return t('DeepSeek Messages is reserved for the deepseek-official source.');
  }
  if (source.baseURL.trim() !== '') {
    try {
      const url = new URL(source.baseURL.trim());
      if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
        return t('Endpoint must be an HTTP(S) URL without credentials.');
      }
    } catch {
      return t('Endpoint must be a valid URL.');
    }
  }  if (source.models.length === 0) return t('Add at least one model to this source.');
  const ids = new Set<string>();
  for (const model of source.models) {
    const id = model.id.trim();
    if (id === '' || !MODEL_ID.test(id)) return t('Every model needs a non-empty id without whitespace.');
    if (ids.has(id)) return t('Duplicate model id: {id}', { id });
    ids.add(id);
    if (model.contextWindow.trim() !== '' && parseCapacity(model.contextWindow) === undefined) {
      return t('Context window must be a positive number, optionally suffixed with K or M.');
    }
    if (model.maxTokens.trim() !== '' && parseCapacity(model.maxTokens) === undefined) {
      return t('Max output tokens must be a positive number, optionally suffixed with K or M.');
    }
    if (model.input.length === 0) return t('Every model needs at least one input type.');
    if (model.reasoningTouched && model.reasoningEnabled) {
      if (model.reasoning.length === 0) return t('Enable at least one reasoning level, or turn reasoning off.');
      if (!model.reasoning.some((row) => row.level !== 'off')) return t('Reasoning needs a level other than off.');
      const levels = new Set<string>();
      for (const row of model.reasoning) {
        if (levels.has(row.level)) return t('Each reasoning level can only be used once per model.');
        levels.add(row.level);
      }
    }
  }
  return undefined;
}

interface CandidatePickerProps {
  candidates: readonly DiscoveredModel[];
  models: readonly DraftModel[];
  onApply: (models: DraftModel[]) => void;
  onClose: () => void;
}

function CandidatePicker({ candidates, models, onApply, onClose }: CandidatePickerProps): ReactNode {
  const app = useApp();
  const t = translator(app.locale);
  const [query, setQuery] = useState('');
  const configured = new Set(models.map((model) => model.id.trim()).filter((id) => id !== ''));
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(() => new Set());
  const pickedByDefault = (id: string): boolean => configured.size === 0 || configured.has(id);
  const isPicked = (id: string): boolean => pickedByDefault(id) !== flipped.has(id);
  const normalized = query.trim().toLowerCase();
  const visible = normalized === ''
    ? candidates
    : candidates.filter((candidate) => candidate.id.toLowerCase().includes(normalized)
      || candidate.name?.toLowerCase().includes(normalized) === true);
  const listed = new Set(candidates.map((candidate) => candidate.id));
  const removed = new Set(models.filter((model) => listed.has(model.id.trim()) && !isPicked(model.id.trim())).map((model) => model.key));
  const kept = models.filter((model) => !removed.has(model.key) && model.id.trim() !== '');
  const keptIds = new Set(kept.map((model) => model.id.trim()));
  const added = candidates
    .filter((candidate) => isPicked(candidate.id) && !keptIds.has(candidate.id))
    .map((candidate) => ({
      ...newModel(),
      id: candidate.id,
      name: candidate.name ?? '',
      contextWindow: formatCapacity(candidate.contextWindow),
      maxTokens: formatCapacity(candidate.maxTokens),
      input: candidate.input ?? ['text'],
      expanded: false,
    }));
  const empties = kept.length === 0 && added.length === 0;
  const allVisiblePicked = visible.length > 0 && visible.every((candidate) => isPicked(candidate.id));

  const toggle = (id: string): void => {
    setFlipped((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('Models available from this endpoint')}
      closeLabel={t('Close')}
      className={css.editorDialog}
      footer={(
        <div className={css.editorFooter}>
          <span className={css.editorFooterGap} />
          <Button variant="outline" onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="outline" disabled={empties} title={empties ? t('Keep at least one model in the list.') : undefined}
            onClick={() => { onApply([...kept, ...added]); }}>
            {t('Update list')}
          </Button>
        </div>
      )}
    >
      <div className={css.candidateTools}>
        <Input type="search" value={query} placeholder={t('Search models')} aria-label={t('Search models')}
          onChange={(event) => { setQuery(event.target.value); }} />
        <Button variant="outline" size="sm" disabled={visible.length === 0}
          onClick={() => {
            const target = !allVisiblePicked;
            setFlipped((current) => {
              const next = new Set(current);
              for (const candidate of visible) {
                if (pickedByDefault(candidate.id) === target) next.delete(candidate.id);
                else next.add(candidate.id);
              }
              return next;
            });
          }}>
          {t(allVisiblePicked ? 'Deselect all' : 'Select all')}
        </Button>
      </div>
      {visible.length === 0 ? (
        <p className={css.hint}>{t('No matching models.')}</p>
      ) : (
        <ul className={css.candidateList}>
          {visible.map((candidate) => (
            <li key={candidate.id}>
              <label className={css.candidateRow}>
                <input type="checkbox" checked={isPicked(candidate.id)} onChange={() => { toggle(candidate.id); }} />
                <span className={css.candidateCopy}>
                  <span className={css.candidateId}>{candidate.id}</span>
                  {candidate.name !== undefined && candidate.name !== candidate.id && (
                    <span className={css.candidateName}>{candidate.name}</span>
                  )}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

interface ModelRowEditorProps {
  model: DraftModel;
  index: number;
  total: number;
  t: Translate;
  onChange: (next: DraftModel) => void;
  onRemove: () => void;
  onMove: (offset: -1 | 1) => void;
}

function ModelRowEditor({ model, index, total, t, onChange, onRemove, onMove }: ModelRowEditorProps): ReactNode {
  const patch = (next: Partial<DraftModel>): void => { onChange({ ...model, ...next }); };
  const used = new Set(model.reasoning.map((row) => row.level));
  const choices = REASONING_EFFORTS.filter((level) => !used.has(level));
  return (
    <li className={css.sourceModelRow}>
      <div className={css.sourceModelHead}>
        <button type="button" className={css.iconButton} aria-label={t('Move model up')} disabled={index === 0}
          onClick={() => { onMove(-1); }}>
          <IconChevronUpOutlineRegular size={14} />
        </button>
        <button type="button" className={css.iconButton} aria-label={t('Move model down')} disabled={index === total - 1}
          onClick={() => { onMove(1); }}>
          <IconChevronDownOutlineRegular size={14} />
        </button>
        <Input value={model.id} placeholder={t('Model ID')} aria-label={`${t('Model ID')} ${String(index + 1)}`}
          onChange={(event) => { patch({ id: event.target.value }); }} />
        <button type="button" className={css.iconButton} aria-label={t('Model options')} title={t('Model options')}
          aria-expanded={model.expanded} onClick={() => { patch({ expanded: !model.expanded }); }}>
          {model.expanded ? <IconChevronDownOutlineRegular /> : <IconChevronRightOutlineRegular />}
        </button>
        <button type="button" className={clsx(css.iconButton, css.iconButtonDanger)} aria-label={t('Remove model')}
          title={t('Remove model')} onClick={onRemove}>
          <IconTrashOutlineRegular size={14} />
        </button>
      </div>
      {model.expanded && (
        <div className={css.sourceModelBody}>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('Display name')}</span>
            <Input value={model.name} placeholder={model.id || t('Model ID')}
              onChange={(event) => { patch({ name: event.target.value }); }} />
          </label>
          <div className={css.editorGrid}>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('Context window')}</span>
              <Input value={model.contextWindow} placeholder="1M" inputMode="numeric"
                onChange={(event) => { patch({ contextWindow: event.target.value }); }} />
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('Max output tokens')}</span>
              <Input value={model.maxTokens} placeholder="128K" inputMode="numeric"
                onChange={(event) => { patch({ maxTokens: event.target.value }); }} />
            </label>
          </div>
          <fieldset className={css.choiceGroup}>
            <legend className={css.fieldLabel}>{t('Input types')}</legend>
            <div className={css.choiceRow}>
              {(['text', 'image'] as const).map((type) => (
                <Checkbox key={type} label={type === 'text' ? t('Text') : t('Image')}
                  checked={model.input.includes(type)}
                  disabled={model.input.length === 1 && model.input.includes(type)}
                  onChange={(checked) => {
                    const input = (['text', 'image'] as const).filter((value) =>
                      value === type ? checked : model.input.includes(value));
                    patch({ input: [...input] });
                  }} />
              ))}
            </div>
          </fieldset>
          <div className={css.choiceHead}>
            <span className={css.fieldLabel}>{t('Reasoning levels')}</span>
            <Switch checked={model.reasoningEnabled} label={t('Reasoning levels')}
              onChange={(enabled) => {
                patch({
                  reasoningEnabled: enabled,
                  reasoningTouched: true,
                  reasoning: enabled
                    ? REASONING_EFFORTS.filter((level) => ['off', 'low', 'medium', 'high'].includes(level))
                      .map((level) => ({ level, value: level === 'off' ? '' : level }))
                    : [],
                  defaultEffort: enabled ? 'high' : '',
                });
              }} />
          </div>
          {model.reasoningEnabled && (
            <div className={css.reasoningEditor}>
              <div className={css.reasoningHead}>
                <span>{t('Level')}</span>
                <span>{t('API value')}</span>
              </div>
              {model.reasoning.map((row, rowIndex) => (
                <div key={`${row.level}-${String(rowIndex)}`} className={css.reasoningRow}>
                  <select className={css.nativeSelect} value={row.level}
                    aria-label={`${t('Level')} ${String(rowIndex + 1)}`}
                    onChange={(event) => {
                      const level = event.target.value as ReasoningEffort;
                      const reasoning = model.reasoning.map((entry, at) =>
                        at === rowIndex ? { ...entry, level, value: level === 'off' ? '' : entry.value || level } : entry);
                      patch({
                        reasoningTouched: true,
                        reasoning,
                        defaultEffort: model.defaultEffort === row.level ? level : model.defaultEffort,
                      });
                    }}>
                    {[row.level, ...REASONING_EFFORTS.filter((level) => level !== row.level && !used.has(level))]
                      .map((level) => <option key={level} value={level}>{level}</option>)}
                  </select>
                  <Input value={row.value} disabled={row.level === 'off'} placeholder={row.level}
                    aria-label={`${row.level} ${t('API value')}`}
                    onChange={(event) => {
                      patch({
                        reasoningTouched: true,
                        reasoning: model.reasoning.map((entry, at) =>
                          at === rowIndex ? { ...entry, value: event.target.value } : entry),
                      });
                    }} />
                  <button type="button" className={clsx(css.iconButton, css.iconButtonDanger)}
                    aria-label={`${t('Remove level')} ${row.level}`} title={t('Remove level')}
                    onClick={() => {
                      const reasoning = model.reasoning.filter((_entry, at) => at !== rowIndex);
                      patch({
                        reasoningTouched: true,
                        reasoning,
                        defaultEffort: reasoning.some((entry) => entry.level === model.defaultEffort)
                          ? model.defaultEffort : reasoning.find((entry) => entry.level !== 'off')?.level ?? '',
                      });
                    }}>
                    <IconTrashOutlineRegular size={14} />
                  </button>
                </div>
              ))}
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('Default reasoning level')}</span>
                <select className={css.nativeSelect} value={model.defaultEffort}
                  onChange={(event) => { patch({ defaultEffort: event.target.value, reasoningTouched: true }); }}>
                  <option value="">{t('First level')}</option>
                  {model.reasoning.filter((row) => row.level !== 'off').map((row) => (
                    <option key={row.level} value={row.level}>{row.level}</option>
                  ))}
                </select>
              </label>
              <button type="button" className={css.addModelButton} disabled={choices.length === 0}
                onClick={() => {
                  const level = choices.find((candidate) => candidate !== 'off') ?? choices[0];
                  if (level === undefined) return;
                  patch({
                    reasoningTouched: true,
                    reasoning: [...model.reasoning, { level, value: level === 'off' ? '' : level }],
                    defaultEffort: model.defaultEffort === '' && level !== 'off' ? level : model.defaultEffort,
                  });
                }}>
                <IconPlusOutlineRegular size={14} />
                {t('Add reasoning level')}
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

interface SourceEditorProps {
  source: ModelSourceSummary | null;
  onClose: () => void;
}

function SourceEditor({ source, onClose }: SourceEditorProps): ReactNode {
  const app = useApp();
  const t = translator(app.locale);
  const [draft, setDraft] = useState<DraftSource>(() => source === null ? newDraft() : draftFrom(source));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [candidates, setCandidates] = useState<readonly DiscoveredModel[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const knownProviders = app.modelSourceList?.catalogProviders ?? [];
  const isKnown = source?.builtIn === true || knownProviders.includes(draft.id.trim());
  const protocolItems = [
    ...(isKnown ? [{ id: '', label: t('Provider default') }] : []),
    ...(app.modelSourceList?.protocols ?? [])
      .filter((api) => api !== 'deepseek-messages' || draft.id.trim() === 'deepseek-official')
      .map((api) => ({ id: api, label: protocolLabel(api, t) })),
  ];
  const configured = source?.apiKeyConfigured === true;
  const keyConfigured = configured && !draft.clearApiKey;

  const patch = (next: Partial<DraftSource>): void => { setDraft((current) => ({ ...current, ...next })); };
  const patchModel = (index: number, next: DraftModel): void => {
    setDraft((current) => ({
      ...current,
      models: current.models.map((model, at) => at === index ? next : model),
    }));
  };
  const moveModel = (index: number, offset: -1 | 1): void => {
    setDraft((current) => {
      const target = index + offset;
      if (target < 0 || target >= current.models.length) return current;
      const models = [...current.models];
      const [moved] = models.splice(index, 1);
      if (moved === undefined) return current;
      models.splice(target, 0, moved);
      return { ...current, models };
    });
  };

  const fetchModels = async (): Promise<void> => {
    setFetching(true);
    setError('');
    try {
      const models = await store.discoverModels({
        ...(draft.id.trim() === '' ? {} : { provider: draft.id.trim() }),
        ...(draft.api === '' ? {} : { api: draft.api }),
        ...(draft.baseURL.trim() === '' ? {} : { baseURL: draft.baseURL.trim() }),
        ...(draft.apiKey.trim() === '' ? {} : { apiKey: draft.apiKey.trim() }),
        ...(draft.apiKeyEnv.trim() === '' ? {} : { apiKeyEnv: draft.apiKeyEnv.trim() }),
      });
      if (models.length === 0) {
        setError(t('The endpoint returned no models. Add models manually.'));
        return;
      }
      setCandidates(models);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setFetching(false);
    }
  };

  const save = async (): Promise<void> => {
    setError('');
    const invalid = validateDraft(draft, t, knownProviders);
    if (invalid !== undefined) {
      setError(invalid);
      return;
    }
    if (source === null && draft.api === '' && !knownProviders.includes(draft.id.trim())) {
      setError(t('Choose an API protocol for a custom model source.'));
      return;
    }
    setSaving(true);
    const failure = await store.saveModelSource(draft.id.trim(), draftWrite(draft));
    setSaving(false);
    if (failure === null) onClose();
    else setError(failure);
  };

  const remove = async (): Promise<void> => {
    if (source === null) return;
    setSaving(true);
    const failure = await store.deleteModelSource(source.id);
    setSaving(false);
    if (failure === null) onClose();
    else setError(failure);
  };

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title={source === null ? t('Add model source') : t('Edit model source')}
        closeLabel={t('Close')}
        className={css.editorDialogWide}
        footer={(
          <div className={css.editorFooter}>
            {source !== null && source.removable && (
              <Button variant="outline" onClick={() => { void remove(); }} disabled={saving}>{t('Delete')}</Button>
            )}
            <span className={css.editorFooterGap} />
            <Button variant="outline" onClick={onClose} disabled={saving}>{t('Cancel')}</Button>
            <Button variant="primary" onClick={() => { void save(); }} disabled={saving}>{saving ? t('Saving…') : t('Save')}</Button>
          </div>
        )}
      >
        <div className={css.editorForm}>
          {source?.legacy === true && (
            <p className={css.notice}>{t('This source uses the legacy top-level provider format. Saving it migrates the source into config.providers without changing the selected model.')}</p>
          )}
          <div className={css.editorGrid}>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('Source ID')}</span>
              <Input value={draft.id} disabled={source !== null} placeholder="my-provider"
                onChange={(event) => { patch({ id: event.target.value.toLowerCase() }); }} />
              <span className={css.fieldHint}>{t('Used as the provider key in config.json; cannot be changed later.')}</span>
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('Display name')}</span>
              <Input value={draft.name} placeholder={draft.id || t('My provider')}
                onChange={(event) => { patch({ name: event.target.value }); }} />
            </label>
          </div>
          {source === null && knownProviders.length > 0 && (
            <div className={css.field}>
              <span className={css.fieldLabel}>{t('Known providers')}</span>
              <SelectMenu
                value={knownProviders.includes(draft.id) ? draft.id : ''}
                items={knownProviders.map((id) => ({ id, label: id }))}
                onSelect={(id) => {
                  patch({ id, name: draft.name.trim() === '' ? id : draft.name, api: '' });
                }}
                ariaLabel={t('Known providers')}
                title={t('Choose a provider the adapter already knows, or enter your own ID.')}
                triggerClassName={css.editorSelect}
              >
                {knownProviders.includes(draft.id) ? draft.id : t('Custom provider')}
              </SelectMenu>
              <span className={css.fieldHint}>{t('Built-in providers can inherit their catalog and endpoint.')}</span>
            </div>
          )}
          <div className={css.editorGrid}>
            <div className={css.field}>
              <span className={css.fieldLabel}>{t('API protocol')}</span>
              <SelectMenu
                value={draft.api}
                items={protocolItems}
                onSelect={(api) => { patch({ api }); }}
                ariaLabel={t('API protocol')}
                title={t('API protocol')}
                triggerClassName={css.editorSelect}
                disabled={source?.builtIn === true && source.api === undefined && !isKnown}
              >
                {protocolLabel(draft.api, t)}
              </SelectMenu>
            </div>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('Base URL')}</span>
              <Input value={draft.baseURL} placeholder="https://gateway.example/v1"
                onChange={(event) => { patch({ baseURL: event.target.value }); }} />
            </label>
          </div>
          <div className={css.editorGrid}>
            <div className={css.field}>
              <span className={css.fieldLabel}>{t('API key')}</span>
              <div className={css.secretRow}>
                <Input type={showKey ? 'text' : 'password'} value={draft.apiKey} autoComplete="new-password"
                  placeholder={keyConfigured ? t('Saved — leave blank to keep') : t('Enter an API key')}
                  onChange={(event) => { patch({ apiKey: event.target.value, clearApiKey: false }); }} />
                <Button variant="outline" size="sm" onClick={() => { setShowKey((current) => !current); }}>
                  {showKey ? t('Hide') : t('Show')}
                </Button>
                {keyConfigured && (
                  <Button variant="outline" size="sm" onClick={() => { patch({ apiKey: '', clearApiKey: true }); }}>
                    {t('Clear')}
                  </Button>
                )}
              </div>
              <span className={css.fieldHint}>
                {keyConfigured ? t('A key is already stored; the value is never sent back to this page.')
                  : configured ? t('The stored key will be removed when you save.')
                    : t('The key is stored in config.json and never returned by the API.')}
              </span>
            </div>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('API key environment variable')}</span>
              <Input value={draft.apiKeyEnv} placeholder="PROVIDER_API_KEY"
                onChange={(event) => { patch({ apiKeyEnv: event.target.value, clearApiKeyEnv: event.target.value.trim() === '' }); }} />
              <span className={css.fieldHint}>{t('Used as a fallback when no key is stored above.')}</span>
            </label>
          </div>
          <section className={css.choiceGroup}>
            <div className={css.choiceHead}>
              <span className={css.fieldLabel}>{t('Models')}</span>
              <div className={css.inlineActions}>
                <Button variant="outline" size="sm" disabled={fetching || (draft.baseURL.trim() === '' && draft.id.trim() === '')}
                  onClick={() => { void fetchModels(); }}>
                  {fetching ? t('Fetching…') : t('Fetch models')}
                </Button>
                <Button variant="outline" size="sm" onClick={() => { patch({ models: [...draft.models, newModel()] }); }}>
                  <IconPlusOutlineRegular size={14} /> {t('Add model')}
                </Button>
              </div>
            </div>
            {draft.models.length === 0 ? (
              <p className={css.hint}>{t('A source needs at least one model.')}</p>
            ) : (
              <ul className={css.sourceModelList}>
                {draft.models.map((model, index) => (
                  <ModelRowEditor
                    key={model.key}
                    model={model}
                    index={index}
                    total={draft.models.length}
                    t={t}
                    onChange={(next) => { patchModel(index, next); }}
                    onRemove={() => {
                      patch({ models: draft.models.filter((_entry, at) => at !== index) });
                    }}
                    onMove={(offset) => { moveModel(index, offset); }}
                  />
                ))}
              </ul>
            )}
          </section>
          {error !== '' && <p className={css.formError} role="alert">{error}</p>}
        </div>
      </Modal>
      {candidates !== null && (
        <CandidatePicker
          candidates={candidates}
          models={draft.models}
          onApply={(models) => { patch({ models }); setCandidates(null); }}
          onClose={() => { setCandidates(null); }}
        />
      )}
    </>
  );
}

function roleModelText(role: RoleEntry, t: Translate): string {
  if (role.provider === undefined || role.model === undefined) return role.error ?? t('Invalid definition');
  return `${role.provider}/${role.model}`;
}

function sourceModelMeta(model: ModelSourceModel, t: Translate): string {
  const parts: string[] = [];
  if (model.contextWindow !== undefined) parts.push(t('{count}K context', { count: Math.round(model.contextWindow / 1024) }));
  if (model.maxTokens !== undefined) parts.push(t('{count}K output', { count: Math.round(model.maxTokens / 1024) }));
  if (model.input.includes('image')) parts.push(t('Image input'));
  if (model.reasoning !== undefined) {
    parts.push(t('Reasoning: {levels}', { levels: Object.keys(model.reasoning.efforts).join(' / ') }));
  }
  return parts.join(' · ');
}

export function SettingsModels(): ReactNode {
  const app = useApp();
  const t = translator(app.locale);
  const [editor, setEditor] = useState<{ editing: RoleEntry | null; prefill?: { provider: string; model: string } } | null>(null);
  const [sourceEditor, setSourceEditor] = useState<{ source: ModelSourceSummary | null } | null>(null);
  const loading = app.modelsLoading || app.rolesLoading || app.modelSourcesLoading;
  const error = app.modelsError !== '' ? app.modelsError
    : app.rolesError !== '' ? app.rolesError : app.modelSourcesError;
  const roles = app.roleEntries;
  const sources = app.modelSources;
  const sourceName = useMemo(() => {
    const names = new Map(sources.map((source) => [source.id, source.name]));
    return (id: string): string => names.get(id) ?? id;
  }, [sources]);

  return (
    <section className={css.page}>
      <header className={css.pageHead}>
        <div>
          <h2 className={css.pageTitle}>{t('Model configuration')}</h2>
          <p className={css.pageIntro}>
            {t('Edit model sources, their models and API keys, then bind a source to an optional named role. A mode can follow the agent role, a role, or one model directly.')}
          </p>
        </div>
        <div className={css.inlineActions}>
          <Button variant="outline" size="sm" onClick={() => { void Promise.all([store.loadCatalogs(), store.loadRoleEntries(), store.loadModelSources()]); }} disabled={loading}>
            {t('Refresh')}
          </Button>
          <Button variant="primary" size="sm" onClick={() => { setSourceEditor({ source: null }); }}>
            {t('Add model source')}
          </Button>
        </div>
      </header>

      {error !== '' && (
        <div className={css.error}>
          <span>{t('Could not load model configuration: {message}', { message: error })}</span>
          <Button variant="outline" size="sm" onClick={() => { void Promise.all([store.loadCatalogs(), store.loadRoleEntries(), store.loadModelSources()]); }}>{t('Retry')}</Button>
        </div>
      )}
      {loading && <p className={css.hint}>{t('Loading…')}</p>}

      <section className={css.group}>
        <div className={css.groupHeadRow}>
          <h3 className={css.groupHead}>{t('Roles')}</h3>
          <Button variant="outline" size="sm" onClick={() => { setEditor({ editing: null }); }} disabled={app.models.length === 0}>{t('New role')}</Button>
        </div>
        <p className={css.hint}>{t('A role binds a name to one provider/model source. Assign a role to a model below, or leave models without one.')}</p>
        {roles.length === 0 && !loading ? (
          <p className={css.hint}>{t('No roles yet. Add one to give modes a named model source.')}</p>
        ) : (
          <ul className={css.roleList}>
            {roles.map((role) => (
              <li key={role.id} className={css.roleRow}>
                <button type="button" className={css.roleMain} onClick={() => { setEditor({ editing: role }); }}>
                  <span className={css.modelName}>
                    {role.name}
                    {role.id === 'default' && <Tag tone="solid">{t('Default')}</Tag>}
                    {role.builtIn === true && <Tag tone="outline">{t('Built-in')}</Tag>}
                    {!role.valid && <Tag tone="outline">{t('Invalid')}</Tag>}
                  </span>
                  <code className={css.modelId}>{role.id}</code>
                  <span className={role.valid ? css.roleSource : css.roleErrorText}>{roleModelText(role, t)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={css.group}>
        <h3 className={css.groupHead}>{t('Model sources')}</h3>
        {sources.length === 0 && !loading ? (
          <div className={css.emptyCustom}>
            <p className={css.hint}>{t('No model sources are configured. Add one to select a provider, endpoint and models.')}</p>
            <Button variant="outline" onClick={() => { setSourceEditor({ source: null }); }}>{t('Add model source')}</Button>
          </div>
        ) : (
          <ul className={css.sourceList}>
            {sources.map((source) => (
              <li key={source.id} className={clsx(css.sourceCard, !source.valid && css.sourceCardBroken)}>
                <div className={css.sourceCardHead}>
                  <div className={css.sourceIdentity}>
                    <span className={css.modelName}>
                      {source.name}
                      {source.active && <Tag tone="solid">{t('Default')}</Tag>}
                      {source.builtIn && <Tag tone="outline">{t('Built-in')}</Tag>}
                      {source.legacy && <Tag tone="outline">{t('Legacy')}</Tag>}
                    </span>
                    <code className={css.modelId}>{source.id}</code>
                    <span className={css.sourceMeta}>
                      {protocolLabel(source.api, t)}
                      {source.baseURL === undefined ? '' : ` · ${source.baseURL}`}
                      {` · ${t('{count} models', { count: source.models.length })}`}
                    </span>
                    <span className={source.apiKeyConfigured ? css.sourceKeyOk : css.sourceKeyMissing}>
                      {source.auth === 'ambient' ? t('Provider-native authentication')
                        : source.apiKeyConfigured ? t('API key configured') : t('No API key configured')}
                    </span>
                  </div>
                  <div className={css.inlineActions}>
                    <Button variant="outline" size="sm" onClick={() => { setSourceEditor({ source }); }}>{t('Edit')}</Button>
                  </div>
                </div>
                {!source.valid && source.error !== undefined && (
                  <p className={css.presetWarning} role="alert">{source.error}</p>
                )}
                {source.models.length > 0 && (
                  <ul className={css.modelList}>
                    {source.models.map((model) => {
                      const assigned = roles.filter((role) =>
                        role.valid && role.provider === source.id && role.model === model.id);
                      return (
                        <li key={`${source.id}/${model.id}`} className={css.modelRow}>
                          <div className={css.modelIdentity}>
                            <span className={css.modelName}>{model.name}</span>
                            <code className={css.modelId}>{source.id}/{model.id}</code>
                            {sourceModelMeta(model, t) !== '' && (
                              <span className={css.modelSourceMeta}>{sourceModelMeta(model, t)}</span>
                            )}
                            <span className={css.modelRoles}>
                              {assigned.length === 0
                                ? <span className={css.hint}>{t('No role assigned')}</span>
                                : assigned.map((role) => <Tag key={role.id} tone="outline">{role.name}</Tag>)}
                            </span>
                          </div>
                          <div className={css.modelMeta}>
                            <Button variant="outline" size="sm"
                              onClick={() => { setEditor({ editing: null, prefill: { provider: source.id, model: model.id } }); }}>
                              {t('Assign role')}
                            </Button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <div className={css.sourceFoot}>
                  <Button variant="outline" size="sm" onClick={() => { setSourceEditor({ source }); }}>
                    {t('Edit models and API key')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {editor !== null && (
        <RoleEditor
          key={`${editor.editing?.id ?? 'new'}:${editor.prefill?.provider ?? ''}/${editor.prefill?.model ?? ''}`}
          editing={editor.editing}
          {...(editor.prefill === undefined ? {} : { prefill: editor.prefill })}
          onClose={() => { setEditor(null); }}
        />
      )}
      {sourceEditor !== null && (
        <SourceEditor
          key={sourceEditor.source?.id ?? 'new-source'}
          source={sourceEditor.source}
          onClose={() => { setSourceEditor(null); }}
        />
      )}
    </section>
  );
}
