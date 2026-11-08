import { useState, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  IconAgentPresetOutlineRegular,
  IconCordisPluginOutlineRegular,
  IconDataOutlineRegular,
  IconPersonalizationOutlineRegular,
  IconSettingsOutlineRegular,
} from '../../vendor/primitives/index.ts';
import { useApp } from '../lib/store.ts';
import { translator } from '../lib/i18n.ts';
import { SettingsGeneral } from './settings/SettingsGeneral.tsx';
import { SettingsModels } from './settings/SettingsModels.tsx';
import { SettingsModes } from './settings/SettingsModes.tsx';
import { SettingsAgents } from './settings/SettingsAgents.tsx';
import { SettingsMcp } from './settings/SettingsMcp.tsx';
import css from '../styles/settings.module.css';

type SettingsTab = 'general' | 'models' | 'mcp' | 'modes' | 'agents';

/**
 * Settings page: a left navigation rail beside a scrollable content column.
 * Each rail page owns its content component; this shell only keeps the
 * selected tab.
 */
export function SettingsPage(): ReactNode {
  const app = useApp();
  const t = translator(app.locale);
  const [active, setActive] = useState<SettingsTab>('general');

  const tabs: Array<{ id: SettingsTab; label: string; icon: ReactNode }> = [
    { id: 'general', label: t('General'), icon: <IconSettingsOutlineRegular size={16} /> },
    { id: 'models', label: t('Model configuration'), icon: <IconDataOutlineRegular size={16} /> },
    { id: 'mcp', label: t('MCP servers'), icon: <IconCordisPluginOutlineRegular size={16} /> },
    { id: 'modes', label: t('Mode presets'), icon: <IconPersonalizationOutlineRegular size={16} /> },
    { id: 'agents', label: t('Agents'), icon: <IconAgentPresetOutlineRegular size={16} /> },
  ];

  return (
    <section className={css.pageRoot} aria-label={t('Settings')}>
      <div className={css.pageInner}>
        <h1 className={css.pageHeading}>{t('Settings')}</h1>
        <div className={css.pageShell}>
          <nav className={css.nav} aria-label={t('Settings sections')}>
            <div className={css.navList}>
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={clsx(css.navCell, tab.id === active && css.navCellActive)}
                  aria-current={tab.id === active ? 'page' : undefined}
                  onClick={() => { setActive(tab.id); }}
                >
                  <span className={css.navIcon} aria-hidden>{tab.icon}</span>
                  <span className={css.navLabel}>{tab.label}</span>
                </button>
              ))}
            </div>
          </nav>
          <div className={css.content}>
            {active === 'general' && <SettingsGeneral />}
            {active === 'models' && <SettingsModels />}
            {active === 'mcp' && <SettingsMcp />}
            {active === 'modes' && <SettingsModes />}
            {active === 'agents' && <SettingsAgents />}
          </div>
        </div>
      </div>
    </section>
  );
}
