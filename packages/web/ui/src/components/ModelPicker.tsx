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
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
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
import { usePointerGrace } from '../../vendor/primitives/pointer-grace.ts';
import { translator, type Translate } from '../lib/i18n.ts';
import { store, useApp } from '../lib/store.ts';
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

/** Composer source flyout placement against the live main-menu rect. */
type SourcePlacement = 'right' | 'left' | 'inline';

const SOURCE_FLYOUT_WIDTH = 220;
const SOURCE_FLYOUT_GAP = 8;

function placeSourceFlyout(menu: DOMRect, viewportWidth: number, margin: number): SourcePlacement {
  const right = viewportWidth - menu.right - margin;
  const left = menu.left - margin;
  if (right >= SOURCE_FLYOUT_WIDTH + SOURCE_FLYOUT_GAP) return 'right';
  if (left >= SOURCE_FLYOUT_WIDTH + SOURCE_FLYOUT_GAP) return 'left';
  return 'inline';
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
  saving = false,
  openRequest = 0,
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
  /** Prevent transient range previews and writes while the host is saving. */
  saving?: boolean;
  /** Increment to open the existing picker from an external recovery action. */
  openRequest?: number;
}): ReactNode {
  const app = useApp();
  const t = translator(app.locale);
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<'root' | 'model' | 'effort'>('root');
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourcePlacement, setSourcePlacement] = useState<SourcePlacement>('right');
  const [query, setQuery] = useState('');
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [previewEffort, setPreviewEffort] = useState<number | null>(null);
  const effortPointerActive = useRef(false);
  const sourceTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sourcePaneRef = useRef<HTMLButtonElement | null>(null);
  const sourceFocusFromKeyboard = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const sourceMenuRef = useRef<HTMLDivElement | null>(null);
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
    layoutKey: `${pane}:${sourceOpen ? sourcePlacement : 'closed'}`,
  });
  const closeSource = (): void => { setSourceOpen(false); };
  const sourceGrace = usePointerGrace(closeSource);

  useEffect(() => {
    if (openRequest > 0) setOpen(true);
  }, [openRequest]);
  useEffect(() => {
    if (!open || pane !== 'model') return;
    const frame = requestAnimationFrame(() => {
      if (models.length + (!concreteOnly && allowRoles ? roles.length : 0) + (!concreteOnly && allowAgent ? 1 : 0) > 4) searchRef.current?.focus();
    });
    return () => { cancelAnimationFrame(frame); };
  }, [allowAgent, allowRoles, concreteOnly, models.length, open, pane, roles.length]);
  useEffect(() => {
    if (!open || !concreteOnly || pane !== 'root' || !sourceOpen || sourcePlacement === 'inline') return;
    const menu = menuRef.current;
    const view = menu?.ownerDocument.defaultView;
    if (menu === null || menu === undefined || view === null || view === undefined) return;
    const place = (): void => {
      const next = placeSourceFlyout(menu.getBoundingClientRect(), view.innerWidth, 12);
      setSourcePlacement((current) => current === next ? current : next);
    };
    place();
    view.addEventListener('resize', place);
    return () => { view.removeEventListener('resize', place); };
  }, [concreteOnly, open, pane, sourceOpen, sourcePlacement]);
  useEffect(() => {
    if (!open || !concreteOnly || !sourceOpen || !sourceFocusFromKeyboard.current) return;
    const frame = requestAnimationFrame(() => { sourcePaneRef.current?.focus(); });
    return () => { cancelAnimationFrame(frame); };
  }, [concreteOnly, open, sourceOpen]);

  const effectiveBinding: ModelBinding | null = concreteOnly && resolved !== null
    ? { version: 2, kind: 'model', provider: resolved.provider, model: resolved.model,
      ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }) }
    : binding;
  const current = effortEffect(effectiveBinding, models);
  useEffect(() => {
    if (!open) return;
    const provider = effectiveBinding?.kind === 'model' ? effectiveBinding.provider : models[0]?.provider;
    setSelectedProvider(provider ?? null);
    setPreviewEffort(null);
  }, [open, effectiveBinding?.kind, effectiveBinding !== null && effectiveBinding.kind === 'model' ? effectiveBinding.provider : undefined, models]);
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
  const currentProvider = effectiveBinding !== null && effectiveBinding.kind === 'model' ? effectiveBinding.provider : undefined;
  const activeProvider = selectedProvider !== null && grouped.some(([provider]) => provider === selectedProvider)
    ? selectedProvider
    : currentProvider !== undefined && grouped.some(([provider]) => provider === currentProvider)
      ? currentProvider
      : grouped[0]?.[0] ?? null;
  const activeModels = activeProvider === null ? [] : models.filter((model) => model.provider === activeProvider);
  const effortLevels = current.model?.reasoningEfforts ?? [];
  const effortIndex = current.effort === undefined ? -1 : effortLevels.indexOf(current.effort);
  const previewIndex = effortPointerActive.current && previewEffort !== null ? previewEffort : effortIndex;
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
    effortPointerActive.current = false;
    sourceFocusFromKeyboard.current = false;
    sourceGrace.cancel();
    setPreviewEffort(null);
    setSourceOpen(false);
    setOpen(false);
    setPane('root');
    setQuery('');
    if (restore) queueMicrotask(() => { triggerRef.current?.focus(); });
  };

  const choose = (next: ModelBinding): void => {
    onSelect(next);
    close(true);
  };

  const chooseModel = (model: ModelSummary, keepFocus?: HTMLElement): void => {
    if (saving) return;
    if (keepFocus !== undefined) keepFocus.focus();
    const next = concreteOnly ? concreteModelBinding(model, resolved) : (() => {
      const same = binding?.kind === 'model'
        && binding.provider === model.provider && binding.model === model.model;
      const effort = same && binding.reasoningEffort !== undefined && model.reasoningEfforts.includes(binding.reasoningEffort)
        ? binding.reasoningEffort
        : model.defaultReasoningEffort;
      return {
        version: 2 as const,
        kind: 'model' as const,
        provider: model.provider,
        model: model.model,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
      };
    })();
    if (concreteOnly) {
      sourceGrace.cancel();
      sourceFocusFromKeyboard.current = false;
      setSourceOpen(false);
      setQuery('');
      onSelect(next);
      return;
    }
    choose(next);
  };

  const chooseEffort = (effort: ReasoningEffort | undefined, closeMenu = true): void => {
    if (saving || effectiveBinding?.kind !== 'model' || current.model === undefined) return;
    const next = {
      version: 2 as const,
      kind: 'model' as const,
      provider: effectiveBinding.provider,
      model: effectiveBinding.model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    };
    onSelect(next);
    if (closeMenu) close(true);
  };

  const commitRange = (index: number): void => {
    if (index < 0 || index >= effortLevels.length || saving) return;
    const effort = effortLevels[index];
    if (effort === undefined || effort === current.effort) return;
    chooseEffort(effort, false);
  };

  const openSource = (fromKeyboard: boolean): void => {
    sourceGrace.cancel();
    sourceFocusFromKeyboard.current = fromKeyboard;
    const menu = menuRef.current;
    const width = menu?.ownerDocument.defaultView?.innerWidth ?? 0;
    setSourcePlacement(menu === null ? 'right' : placeSourceFlyout(menu.getBoundingClientRect(), width, 12));
    setSourceOpen(true);
  };

  const hoverSource = (event: ReactPointerEvent<HTMLElement>): void => {
    if (!concreteOnly || event.pointerType === 'touch') return;
    if (event.pointerType === 'mouse' && window.matchMedia('(any-hover: hover)').matches !== true) return;
    openSource(false);
  };

  const leaveSourceRegion = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.pointerType === 'touch') return;
    const next = event.relatedTarget;
    if (next instanceof Node
      && (event.currentTarget.contains(next)
        || sourceMenuRef.current?.contains(next) === true
        || sourceTriggerRef.current?.contains(next) === true)) return;
    sourceGrace.arm();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      if (concreteOnly && sourceOpen) {
        sourceGrace.cancel();
        sourceFocusFromKeyboard.current = false;
        sourceTriggerRef.current?.focus();
        setSourceOpen(false);
      } else if (pane !== 'root') {
        setPane('root');
        setQuery('');
        queueMicrotask(() => { triggerRef.current?.focus(); });
      } else {
        close(true);
      }
      return;
    }
    if (event.target instanceof HTMLInputElement && event.target.type === 'range') return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    const inSource = concreteOnly && target !== null && sourceMenuRef.current?.contains(target) === true;
    if (event.key === 'ArrowRight' && concreteOnly && target === sourceTriggerRef.current) {
      event.preventDefault();
      if (!sourceOpen) openSource(true);
      else (sourcePaneRef.current ?? sourceMenuRef.current?.querySelector('button:not([disabled])'))?.focus();
      return;
    }
    if (event.key === 'Enter' && concreteOnly && target === sourceTriggerRef.current && !sourceOpen) {
      event.preventDefault();
      openSource(true);
      return;
    }
    if (event.key === 'ArrowLeft' && inSource && sourceOpen) {
      event.preventDefault();
      sourceGrace.cancel();
      sourceFocusFromKeyboard.current = false;
      sourceTriggerRef.current?.focus();
      setSourceOpen(false);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = [...((inSource ? sourceMenuRef.current : menuRef.current)?.querySelectorAll<HTMLButtonElement>(
      inSource ? 'button:not([disabled])' : 'button[data-menu-row]:not([disabled])',
    ) ?? [])].filter((row) => row.getAttribute('aria-disabled') !== 'true'
      && (inSource || sourceMenuRef.current?.contains(row) !== true));
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
    setSourceOpen(false);
    setPane(concreteOnly ? 'root' : (current.model !== undefined && current.model.reasoningEfforts.length > 0 ? 'root' : 'model'));
    setOpen(true);
  };

  const sourceSubmenu = (
    <div
      ref={sourceMenuRef}
      className={clsx(css.sourceSubmenu, sourcePlacement === 'inline' && css.sourceInline)}
      id={`${id}-source`}
      data-source-submenu=""
      role="menu"
      aria-label={t('Model source')}
      onPointerEnter={hoverSource}
      onPointerLeave={leaveSourceRegion}
    >
      <div className={css.scroll}>
        {grouped.map(([provider], index) => (
          <button ref={index === 0 ? sourcePaneRef : undefined} key={provider} type="button" role="menuitemradio" aria-checked={provider === activeProvider}
            className={css.option} onClick={() => { sourceTriggerRef.current?.focus(); setSelectedProvider(provider); sourceGrace.cancel(); sourceFocusFromKeyboard.current = false; setSourceOpen(false); setQuery(''); }}>
            <span className={css.optionText}>{provider}</span>
            <span className={css.check}>{provider === activeProvider ? <IconCheckOutlineRegular /> : null}</span>
          </button>
        ))}
        {grouped.length === 0 && <div className={css.empty}>{t('No model sources')}</div>}
        <button type="button" className={css.option} onClick={() => { store.openSettings('models'); close(true); }}>
          {t('Manage models')}
        </button>
      </div>
    </div>
  );

  const modelRows = (groups: readonly (readonly [string, readonly ModelSummary[]])[]): ReactNode => groups.map(([provider, groupModels]) => (
    <section key={provider} className={css.group}>
      <div className={css.groupHead}>{provider}</div>
      {groupModels.map((model) => {
        const selected = effectiveBinding?.kind === 'model'
          && effectiveBinding.provider === model.provider && effectiveBinding.model === model.model;
        return (
          <button key={`${provider}/${model.model}`} type="button" role="menuitemradio"
            aria-checked={selected} aria-disabled={concreteOnly && saving ? true : undefined}
            data-menu-row="" data-model-key={`${provider}/${model.model}`}
            className={css.option} title={`${provider}/${model.model}`}
            onClick={(event) => { chooseModel(model, event.currentTarget); }}>
            <span className={css.optionCopy}>
              <span className={css.optionText}>{model.name}</span>
              <span className={css.optionMeta}>
                {model.model}
                {model.contextWindow === undefined ? '' : ` · ${Math.round(model.contextWindow / 1024)}K`}
                {model.capabilities.imageInput ? ` · ${t('Vision')}` : ''}
              </span>
            </span>
            <span className={css.check}>{selected ? <IconCheckOutlineRegular /> : null}</span>
          </button>
        );
      })}
    </section>
  ));

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
            const next = event.relatedTarget;
            if (next instanceof Node
              && (rootRef.current?.contains(next) === true
                || menuRef.current?.contains(next) === true
                || sourceMenuRef.current?.contains(next) === true)) return;
            close();
          }}
        >
          {pane === 'root' && concreteOnly && (
            <>
              <div
                className={css.sourceRow}
                onPointerEnter={hoverSource}
                onPointerLeave={leaveSourceRegion}
              >
                <button ref={sourceTriggerRef} type="button" role="menuitem" className={css.cell} data-menu-row=""
                  aria-haspopup="menu" aria-expanded={sourceOpen}
                  aria-controls={sourceOpen ? `${id}-source` : undefined}
                  onClick={() => { if (sourceOpen) { sourceGrace.cancel(); setSourceOpen(false); } else openSource(true); }}>
                  <span className={css.cellLabel}>{t('Model source')}</span>
                  <span className={css.cellValue}>{activeProvider ?? t('No model sources')}</span>
                  <IconChevronRightOutlineRegular className={css.cellChevron} aria-hidden />
                </button>
                {sourceOpen && sourcePlacement !== 'inline' && (
                  <MenuSurface
                    className={clsx(css.sourceSurface, sourcePlacement === 'left' && css.sourceSurfaceLeft)}
                    data-placement={sourcePlacement}
                    role="presentation"
                  >
                    {sourceSubmenu}
                  </MenuSurface>
                )}
              </div>
              {sourceOpen && sourcePlacement === 'inline' && sourceSubmenu}
              {showSearch && (
                <div className={css.searchRow}>
                  <Input ref={searchRef} className={css.search} type="search" value={query}
                    placeholder={t('Search models')} aria-label={t('Search models')}
                    onChange={(event) => { setQuery(event.target.value); }} />
                </div>
              )}
              <div className={css.scroll}>
                {modelRows(normalizedQuery === ''
                  ? (activeProvider === null ? [] : [[activeProvider, activeModels] as const])
                  : filteredGroups)}
                {models.length === 0 && <div className={css.empty}>{t('No model sources')}</div>}
                {normalizedQuery !== '' && filteredGroups.length === 0 && <div className={css.empty}>{t('No matching models')}</div>}
              </div>
              {effortLevels.length > 0 ? (
                <label className={clsx(css.effortSlider, concreteOnly && css.effortTrack)}>
                  <span>{t('Reasoning effort')}</span>
                  <input type="range" min={effortIndex < 0 ? -1 : 0} max={Math.max(0, effortLevels.length - 1)} step={1}
                    value={previewIndex} aria-label={t('Reasoning effort')}
                    aria-valuetext={previewIndex < 0 ? t('Model default') : effortLevels[previewIndex] ?? t('Model default')}
                    aria-disabled={saving}
                    style={{
                      '--effort-stops': Math.max(1, effortLevels.length),
                      '--effort-progress': `${(() => {
                        const min = effortIndex < 0 ? -1 : 0;
                        const max = Math.max(0, effortLevels.length - 1);
                        return max <= min ? 0 : (previewIndex - min) / (max - min) * 100;
                      })()}%`,
                    } as CSSProperties}
                    onKeyDown={(event) => {
                      if (saving) event.preventDefault();
                    }}
                    onChange={(event) => {
                      if (effortPointerActive.current) setPreviewEffort(Number(event.target.value));
                      else commitRange(Number(event.target.value));
                    }}
                    onPointerDown={(event) => {
                      if (saving) return;
                      effortPointerActive.current = true;
                      event.currentTarget.setPointerCapture(event.pointerId);
                    }}
                    onPointerUp={(event) => {
                      const index = Number(event.currentTarget.value);
                      effortPointerActive.current = false;
                      setPreviewEffort(null);
                      commitRange(index);
                    }}
                    onLostPointerCapture={() => {
                      if (!effortPointerActive.current) return;
                      effortPointerActive.current = false;
                      setPreviewEffort(null);
                    }}
                    onPointerCancel={() => {
                      effortPointerActive.current = false;
                      setPreviewEffort(null);
                    }} />
                  <output>{previewIndex < 0 ? t('Model default') : effortLevels[previewIndex] ?? t('Model default')}</output>
                </label>
              ) : <div className={css.empty}>{t('Model default')}</div>}
            </>
          )}

          {pane === 'root' && !concreteOnly && (
            <>
              <button type="button" role="menuitem" className={css.cell} data-menu-row="" onClick={() => { setPane('model'); }}>
                <span className={css.cellLabel}>{t('Model')}</span>
                <span className={css.cellValue}>{displayLabel}</span>
                <IconChevronRightOutlineRegular className={css.cellChevron} aria-hidden />
              </button>
              {effortChoices.length > 1 && (
                <button type="button" role="menuitem" className={css.cell} data-menu-row="" onClick={() => { setPane('effort'); }}>
                  <span className={css.cellLabel}>{t('Reasoning effort')}</span>
                  <span className={css.cellValue}>{current.label ?? t('Model default')}</span>
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
                      data-menu-row="" className={css.option} onClick={() => { choose({ version: 2, kind: 'agent' }); }}>
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
                        data-menu-row="" className={css.option}
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
                {modelRows(concreteOnly && normalizedQuery === ''
                  ? (activeProvider === null ? [] : [[activeProvider, activeModels] as const])
                  : filteredGroups)}
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
                    data-menu-row="" className={css.option} onClick={() => { chooseEffort(choice.effort); }}>
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
