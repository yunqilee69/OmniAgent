import { type ReactNode } from 'react';
import clsx from 'clsx';
import { Button, Modal, Tag } from '../../vendor/primitives/index.ts';
import { store, useApp } from '../lib/store.ts';
import { translator } from '../lib/i18n.ts';
import type { ModeSummary } from '../lib/wire.ts';
import css from '../styles/settings.module.css';

function agentName(mode: ModeSummary, app: ReturnType<typeof useApp>): string {
  return app.agents.find((agent) => agent.id === mode.agent)?.name ?? mode.agent;
}

function modelLabel(mode: ModeSummary, app: ReturnType<typeof useApp>, t: ReturnType<typeof translator>): string {
  const binding = mode.model;
  let provider: string | undefined;
  let modelId: string | undefined;
  let effort: string | undefined;
  if (binding.kind === 'agent') {
    const roleId = app.agents.find((agent) => agent.id === mode.agent)?.role;
    const role = app.roles.find((item) => item.id === roleId);
    if (role === undefined) return t('Follow agent role');
    provider = role.provider;
    modelId = role.model;
    effort = role.reasoningEffort;
  } else if (binding.kind === 'role') {
    const role = app.roles.find((item) => item.id === binding.role);
    if (role === undefined) return `Role · ${binding.role}`;
    provider = role.provider;
    modelId = role.model;
    effort = role.reasoningEffort;
  } else {
    provider = binding.provider;
    modelId = binding.model;
    const model = app.models.find((item) => item.provider === binding.provider && item.model === binding.model);
    effort = binding.reasoningEffort ?? model?.defaultReasoningEffort;
  }
  if (provider === undefined || modelId === undefined) return t('Follow agent role');
  const model = app.models.find((item) => item.provider === provider && item.model === modelId);
  const name = model?.name ?? `${provider}/${modelId}`;
  return effort === undefined ? name : `${name} · ${effort}`;
}

/** Pre-session mode picker. The selected mode is written into the new session and cannot be changed. */
export function NewSessionDialog(): ReactNode {
  const app = useApp();
  const t = translator(app.locale);
  const modes = app.modes.filter((mode) => mode.valid);
  return (
    <Modal
      open={app.newSessionOpen}
      onClose={() => { store.closeNewSessionPicker(); }}
      title={t('Choose a mode')}
      closeLabel={t('Close')}
      className={css.dialog}
      footer={<Button variant="outline" onClick={() => { store.closeNewSessionPicker(); }}>{t('Cancel')}</Button>}
    >
      <div className={css.page}>
        <header className={css.pageHead}>
          <div>
            <h2 className={css.pageTitle}>{t('Choose a mode for this session')}</h2>
            <p className={css.pageIntro}>
              {t('The mode sets the agent, default model, tools and skills for the whole session. The model can be overridden before or during the conversation; to use a different mode, create a new session.')}
            </p>
          </div>
        </header>
        {app.modesError !== '' && (
          <div className={css.error}>
            <span>{t('Could not load modes: {message}', { message: app.modesError })}</span>
            <Button variant="outline" size="sm" onClick={() => { void store.loadModes(); }}>{t('Retry')}</Button>
          </div>
        )}
        {app.modesLoading && <p className={css.hint}>{t('Loading…')}</p>}
        {!app.modesLoading && modes.length === 0 ? (
          <p className={css.hint}>{t('No usable modes are configured.')}</p>
        ) : (
          <ul className={css.presetGrid}>
            {modes.map((mode) => (
              <li key={mode.id} className={clsx(css.presetCard, mode.id === app.defaultMode && css.presetCardSelected)}>
                <button type="button" className={css.presetMain} onClick={() => { store.startDraftSession(mode.id); }}>
                  <span className={css.presetHead}>
                    <span className={css.presetName}>{mode.name}</span>
                    <span className={css.badgeRow}>
                      {mode.id === app.defaultMode && <Tag tone="solid">{t('Default')}</Tag>}
                      {mode.builtIn && <Tag tone="outline">{t('Built-in')}</Tag>}
                    </span>
                  </span>
                  <span className={css.presetDesc}>{mode.description || t('No description.')}</span>
                  <span className={css.presetMeta}>
                    <span>{agentName(mode, app)}</span>
                    <span className={css.presetDot} aria-hidden>·</span>
                    <span>{modelLabel(mode, app, t)}</span>
                  </span>
                  <span className={css.presetMeta}>
                    <span>{mode.tools === '*' ? t('All tools') : t('{count} tools', { count: mode.tools.length })}</span>
                    <span className={css.presetDot} aria-hidden>·</span>
                    <span>{mode.skills === '*' ? t('All skills') : t('{count} skills', { count: mode.skills.length })}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
