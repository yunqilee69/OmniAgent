/**
 * DSH-style model seat: a trigger that shows the current model and reasoning
 * effort, and a two-level menu that separates choosing a model from choosing
 * its effort. Models are grouped by provider and searchable once the catalog
 * grows past four entries. The same component serves the composer, role
 * editor and mode editor so model identity and effort mean the same thing
 * everywhere.
 */

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import clsx from 'clsx';
import {
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconDataOutlineRegular,
  Input,
  MenuSurface,
  useAnchoredPosition,
  useDismissOnOutsidePointer,
} from '../../vendor/primitives/index.ts';
import { translator, type Translate } from '../lib/i18n.ts';
import { useApp } from '../lib/store.ts';
import type {
  ModelBinding,
  ModelSummary,
  ReasoningEffort,
  ResolvedModel,
  RoleSummary,
} from '../lib/wire.ts';
import css from '../styles/model-picker.module.css';

interface EffortChoice {
  id: string;
  effort?: ReasoningEffort;
  label: string;
}

function roleLabel(role: RoleSummary): string {
  return `${role.name} · ${role.provider}/${role.model}`;
}

function effortEffect(
  binding: ModelBinding | null,
  models: readonly ModelSummary[],
): { model?: ModelSummary; effort?: ReasoningEffort; label?: string } {
  if (binding?.kind === 'model') {
    const model = models.find((entry) => entry.provider === binding.provider && entry.model === binding.model);
    const effort = binding.reasoningEffort ?? model?.defaultReasoningEffort;
    return { ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }), ...(effort === undefined ? {} : { label: effort }) };
  }
  return {};
}

export function concreteModelBinding(model: ModelSummary, resolved: ResolvedModel | null): ModelBinding {
  const same = resolved?.provider === model.provider && resolved.model === model.model;
  const effort = same ? resolved.reasoningEffort ?? model.defaultReasoningEffort : model.defaultReasoningEffort;
  return {
    version: 2, kind: 'model', provider: model.provider, model: model.model,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
  };
}

function bindingLabel(
  binding: ModelBinding | null,
  models: readonly ModelSummary[],
  roles: readonly RoleSummary[],
  t: Translate,
  resolved: ResolvedModel | null = null,
): string {
  // A resolved model is what the session actually runs with. Roles and
  // agent-following bindings are configuration, so the seat shows the
  // concrete model and effort instead of the role name.
  if (resolved !== null) {
    return resolved.reasoningEffort === undefined
      ? resolved.name
      : `${resolved.name} · ${resolved.reasoningEffort}`;
  }
  if (binding === null) return t('Select model');
  if (binding.kind === 'agent') return t('Follow agent');
  if (binding.kind === 'role') {
    const role = roles.find((entry) => entry.id === binding.role);
    if (role === undefined) return t('Role · {role}', { role: binding.role });
    return role.reasoningEffort === undefined ? role.name : `${role.name} · ${role.reasoningEffort}`;
  }
  const model = models.find((entry) => entry.provider === binding.provider && entry.model === binding.model);
  const effort = binding.reasoningEffort ?? model?.defaultReasoningEffort;
  const name = model?.name ?? `${binding.provider}/${binding.model}`;
  return effort === undefined ? name : `${name} · ${effort}`;
}

export function ModelPicker({
  binding,
  models,
  roles,
  resolved = null,
  onSelect,
  ariaLabel,
  title,
  disabled = false,
  allowAgent = true,
  allowRoles = true,
  concreteOnly = false,
  triggerClassName,
  side = 'bottom',
  align = 'start',
  showLeading = true,
}: {
  binding: ModelBinding | null;
  models: readonly ModelSummary[];
  roles: readonly RoleSummary[];
  /** Effective model resolved by the server; overrides the binding label. */
  resolved?: ResolvedModel | null;
  onSelect: (binding: ModelBinding) => void;
  ariaLabel: string;
  title?: string;
  disabled?: boolean;
  allowAgent?: boolean;
  allowRoles?: boolean;
  /** Show resolved concrete model and effort without configuration-only choices. */
  concreteOnly?: boolean;
  triggerClassName?: string;
  side?: 'top' | 'bottom';
  align?: 'start' | 'end';
  showLeading?: boolean;
}): ReactNode {
  const app = useApp();
  const t = translator(app.locale);
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<'root' | 'model' | 'effort'>('root');
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const id = useId();
  useDismissOnOutsidePointer(rootRef, open, setOpen, menuRef);
  const position = useAnchoredPosition({
    open,
    anchorRef: triggerRef,
    panelRef: menuRef,
    side,
    align,
    gap: 8,
    margin: 12,
    layoutKey: pane,
  });

  useEffect(() => {
    if (!open || pane !== 'model') return;
    const frame = requestAnimationFrame(() => {
      if (models.length + (!concreteOnly && allowRoles ? roles.length : 0) + (!concreteOnly && allowAgent ? 1 : 0) > 4) searchRef.current?.focus();
    });
    return () => { cancelAnimationFrame(frame); };
  }, [allowAgent, allowRoles, concreteOnly, models.length, open, pane, roles.length]);

  const effectiveBinding: ModelBinding | null = concreteOnly && resolved !== null
    ? { version: 2, kind: 'model', provider: resolved.provider, model: resolved.model,
      ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }) }
    : binding;
  const current = effortEffect(effectiveBinding, models);
  const effortChoices = useMemo<EffortChoice[]>(() => {
    if (current.model === undefined) return [];
    const choices: EffortChoice[] = concreteOnly ? [] : [{
      id: 'default',
      label: current.model.defaultReasoningEffort === undefined
        ? t('Model default')
        : t('Model default ({effort})', { effort: current.model.defaultReasoningEffort }),
    }];
    for (const effort of current.model.reasoningEfforts) {
      choices.push({ id: effort, effort, label: effort });
    }
    return choices;
  }, [concreteOnly, current.model, t]);
  const grouped = useMemo(() => {
    const groups = new Map<string, ModelSummary[]>();
    for (const model of models) {
      const list = groups.get(model.provider) ?? [];
      list.push(model);
      groups.set(model.provider, list);
    }
    return [...groups.entries()];
  }, [models]);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredGroups = grouped.flatMap(([provider, groupModels]) => {
    const filtered = normalizedQuery === ''
      ? groupModels
      : groupModels.filter((model) =>
        model.name.toLowerCase().includes(normalizedQuery)
        || model.model.toLowerCase().includes(normalizedQuery)
        || provider.toLowerCase().includes(normalizedQuery));
    return filtered.length === 0 ? [] : [[provider, filtered] as const];
  });
  const filteredRoles = allowRoles && !concreteOnly
    ? roles.filter((role) => normalizedQuery === ''
      || role.name.toLowerCase().includes(normalizedQuery)
      || role.id.toLowerCase().includes(normalizedQuery)
      || `${role.provider}/${role.model}`.toLowerCase().includes(normalizedQuery))
    : [];
  const agentVisible = !concreteOnly && allowAgent && (normalizedQuery === ''
    || t('Follow agent').toLowerCase().includes(normalizedQuery));
  const showSearch = models.length + (!concreteOnly && allowRoles ? roles.length : 0) + (!concreteOnly && allowAgent ? 1 : 0) > 4;
  const hasResults = agentVisible || filteredRoles.length > 0 || filteredGroups.length > 0;

  const close = (restore = false): void => {
    setOpen(false);
    setPane('root');
    setQuery('');
    if (restore) queueMicrotask(() => { triggerRef.current?.focus(); });
  };

  const choose = (next: ModelBinding): void => {
    onSelect(next);
    close(true);
  };

  const chooseModel = (model: ModelSummary): void => {
    if (concreteOnly) {
      choose(concreteModelBinding(model, resolved));
      return;
    }
    const same = binding?.kind === 'model'
      && binding.provider === model.provider && binding.model === model.model;
    const effort = same && binding.reasoningEffort !== undefined && model.reasoningEfforts.includes(binding.reasoningEffort)
      ? binding.reasoningEffort
      : model.defaultReasoningEffort;
    choose({
      version: 2,
      kind: 'model',
      provider: model.provider,
      model: model.model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    });
  };

  const chooseEffort = (effort: ReasoningEffort | undefined): void => {
    if (effectiveBinding?.kind !== 'model' || current.model === undefined) return;
    choose({
      version: 2,
      kind: 'model',
      provider: effectiveBinding.provider,
      model: effectiveBinding.model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      if (pane !== 'root') {
        setPane('root');
        setQuery('');
        queueMicrotask(() => { triggerRef.current?.focus(); });
      } else {
        close(true);
      }
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])];
    if (rows.length === 0) return;
    event.preventDefault();
    const active = rows.findIndex((row) => row === document.activeElement);
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    const next = active === -1 ? (direction > 0 ? 0 : rows.length - 1)
      : (active + direction + rows.length) % rows.length;
    rows[next]?.focus();
  };

  const displayLabel = concreteOnly && resolved === null && binding?.kind !== 'model'
    ? t('Select model')
    : bindingLabel(binding, models, roles, t, resolved);

  const openMenu = (): void => {
    if (disabled) return;
    setQuery('');
    setPane(current.model !== undefined && current.model.reasoningEfforts.length > 0 ? 'root' : 'model');
    setOpen(true);
  };

  return (
    <div ref={rootRef} className={css.root} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className={clsx(css.trigger, triggerClassName)}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={title ?? displayLabel}
        disabled={disabled}
        onClick={() => { if (open) close(true); else openMenu(); }}
      >
        {showLeading && <IconDataOutlineRegular className={css.leading} size={16} />}
        <span className={css.label}>{displayLabel}</span>
        {!disabled && <IconChevronDownOutlineRegular className={clsx(css.chevron, open && css.chevronOpen)} aria-hidden />}
      </button>

      {open && (
        <MenuSurface
          ref={menuRef}
          id={`${id}-menu`}
          className={css.menu}
          style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
          role="menu"
          aria-label={ariaLabel}
          onBlur={(event) => {
            if (event.relatedTarget instanceof Node
              && (rootRef.current?.contains(event.relatedTarget) === true
                || menuRef.current?.contains(event.relatedTarget) === true)) return;
            close();
          }}
        >
          {pane === 'root' && (
            <>
              <button type="button" role="menuitem" className={css.cell} onClick={() => { setPane('model'); }}>
                <span className={css.cellLabel}>{t('Model')}</span>
                <span className={css.cellValue}>{displayLabel}</span>
                <IconChevronRightOutlineRegular className={css.cellChevron} aria-hidden />
              </button>
              {effortChoices.length > (concreteOnly ? 0 : 1) && (
                <button type="button" role="menuitem" className={css.cell} onClick={() => { setPane('effort'); }}>
                  <span className={css.cellLabel}>{t('Reasoning effort')}</span>
                  <span className={css.cellValue}>{current.label ?? (concreteOnly ? '—' : t('Model default'))}</span>
                  <IconChevronRightOutlineRegular className={css.cellChevron} aria-hidden />
                </button>
              )}
            </>
          )}

          {pane === 'model' && (
            <>
              {showSearch && (
                <div className={css.searchRow}>
                  <Input
                    ref={searchRef}
                    className={css.search}
                    type="search"
                    value={query}
                    placeholder={t('Search models')}
                    aria-label={t('Search models')}
                    onChange={(event) => { setQuery(event.target.value); }}
                  />
                </div>
              )}
              <div className={css.scroll}>
                {agentVisible && (
                  <section className={css.group}>
                    <div className={css.groupHead}>{t('Bindings')}</div>
                    <button type="button" role="menuitemradio" aria-checked={binding?.kind === 'agent'}
                      className={css.option} onClick={() => { choose({ version: 2, kind: 'agent' }); }}>
                      <span className={css.optionText}>{t('Follow agent')}</span>
                      <span className={css.check}>{binding?.kind === 'agent' ? <IconCheckOutlineRegular /> : null}</span>
                    </button>
                  </section>
                )}
                {filteredRoles.length > 0 && (
                  <section className={css.group}>
                    <div className={css.groupHead}>{t('Roles')}</div>
                    {filteredRoles.map((role) => (
                      <button key={role.id} type="button" role="menuitemradio"
                        aria-checked={binding?.kind === 'role' && binding.role === role.id}
                        className={css.option}
                        onClick={() => { choose({ version: 2, kind: 'role', role: role.id }); }}>
                        <span className={css.optionCopy}>
                          <span className={css.optionText}>{role.name}</span>
                          <span className={css.optionMeta}>{roleLabel(role)}{role.reasoningEffort === undefined ? '' : ` · ${role.reasoningEffort}`}</span>
                        </span>
                        <span className={css.check}>{binding?.kind === 'role' && binding.role === role.id ? <IconCheckOutlineRegular /> : null}</span>
                      </button>
                    ))}
                  </section>
                )}
                {filteredGroups.map(([provider, groupModels]) => (
                  <section key={provider} className={css.group}>
                    <div className={css.groupHead}>{provider}</div>
                    {groupModels.map((model) => {
                      const selected = effectiveBinding?.kind === 'model'
                        && effectiveBinding.provider === model.provider && effectiveBinding.model === model.model;
                      return (
                        <button key={`${provider}/${model.model}`} type="button" role="menuitemradio"
                          aria-checked={selected} className={css.option}
                          title={`${provider}/${model.model}`}
                          onClick={() => { chooseModel(model); }}>
                          <span className={css.optionCopy}>
                            <span className={css.optionText}>{model.name}</span>
                            <span className={css.optionMeta}>
                              {model.model}
                              {model.contextWindow === undefined ? '' : ` · ${Math.round(model.contextWindow / 1024)}K`}
                            </span>
                          </span>
                          <span className={css.check}>{selected ? <IconCheckOutlineRegular /> : null}</span>
                        </button>
                      );
                    })}
                  </section>
                ))}
                {!hasResults && (
                  <div className={css.empty} role="status">
                    {models.length === 0 && roles.length === 0
                      ? t('No models are configured yet. Add one in Settings → Model configuration.')
                      : t('No matching models')}
                  </div>
                )}
              </div>
            </>
          )}

          {pane === 'effort' && (
            <div className={css.scroll}>
              {effortChoices.map((choice) => {
                const selected = concreteOnly
                  ? choice.effort === current.effort
                  : choice.effort === undefined
                    ? binding?.kind === 'model' && binding.reasoningEffort === undefined
                    : binding?.kind === 'model' && binding.reasoningEffort === choice.effort;
                return (
                  <button key={choice.id} type="button" role="menuitemradio" aria-checked={selected}
                    className={css.option} onClick={() => { chooseEffort(choice.effort); }}>
                    <span className={css.optionText}>{choice.label}</span>
                    <span className={css.check}>{selected ? <IconCheckOutlineRegular /> : null}</span>
                  </button>
                );
              })}
            </div>
          )}
        </MenuSurface>
      )}
    </div>
  );
}
