import { useState, type ReactNode } from 'react';
import {
  Button,
  RiskConfirmation,
  SegmentedControl,
  type MenuEntry,
} from '../../../vendor/primitives/index.ts';
import { isPermissionPreset, permissionPresets, type PermissionPreset } from '../../lib/wire.ts';
import { store, useApp } from '../../lib/store.ts';
import { localeOptions, translator } from '../../lib/i18n.ts';
import { SelectMenu } from '../SelectMenu.tsx';
import { permissionIcon } from '../permission-icon.tsx';
import permissionCss from '../../styles/dsh/permission-row.module.css';
import css from '../../styles/app.module.css';

/**
 * Foreground wait for ask_user. A blank or illegal stored value shows the
 * five-minute default until the user saves a replacement. -1 waits indefinitely.
 */
function WebSearchSettings(): ReactNode {
  const app = useApp();
  const t = translator(app.locale);
  const stored = app.webSearch;
  const [apiKey, setApiKey] = useState('');
  const [apiKeyEnv, setApiKeyEnv] = useState(stored?.apiKeyEnv ?? '');
  const [maxResults, setMaxResults] = useState(String(stored?.maxResults ?? 5));
  const [seen, setSeen] = useState(stored?.apiKeyEnv);
  if (stored !== null && stored.apiKeyEnv !== seen) {
    setSeen(stored.apiKeyEnv);
    setApiKeyEnv(stored.apiKeyEnv ?? '');
    setMaxResults(String(stored.maxResults));
  }
  const save = (): void => {
    const results = Number(maxResults);
    void store.saveWebSearch({
      ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
      ...(apiKeyEnv.trim() === '' ? { clearApiKeyEnv: true } : { apiKeyEnv: apiKeyEnv.trim() }),
      ...(Number.isInteger(results) && results >= 1 && results <= 20 ? { maxResults: results } : {}),
    }).then(() => setApiKey(''));
  };
  return (
    <div className={css.settingsRow}>
      <div>
        <span className={css.settingsLabel}>{t('Web search')}</span>
        <span className={css.settingsDescription}>
          {t('Tavily powers the global web_search tool. A stored key is write-only; an environment variable is used when no key is stored.')}
        </span>
      </div>
      <div>
        <input
          aria-label={t('Tavily API key')}
          type="password"
          value={apiKey}
          placeholder={stored?.apiKeyConfigured === true ? t('Key configured') : t('Not configured')}
          disabled={app.webSearchSaving}
          onChange={(event) => setApiKey(event.target.value)}
        />
        <input
          aria-label={t('Tavily API key environment variable')}
          value={apiKeyEnv}
          placeholder="TAVILY_API_KEY"
          disabled={app.webSearchSaving}
          onChange={(event) => setApiKeyEnv(event.target.value)}
        />
        <input
          aria-label={t('Maximum search results')}
          inputMode="numeric"
          value={maxResults}
          disabled={app.webSearchSaving}
          onChange={(event) => setMaxResults(event.target.value)}
        />
        <Button variant="outline" size="sm" disabled={app.webSearchSaving} onClick={save}>{t('Save')}</Button>
        {stored?.apiKeyConfigured === true && (
          <Button variant="outline" size="sm" disabled={app.webSearchSaving} onClick={() => { void store.saveWebSearch({ clearApiKey: true }); }}>
            {t('Clear stored key')}
          </Button>
        )}
      </div>
    </div>
  );
}

function QuestionTimeout(): ReactNode {
  const app = useApp();
  const t = translator(app.locale);
  const stored = app.askUserTimeout;
  const indefinite = stored?.timeoutSec === -1;
  const minutes = stored === null || indefinite ? 5 : Math.max(1, Math.round(stored.timeoutSec / 60));
  const [draft, setDraft] = useState(String(minutes));
  const [seen, setSeen] = useState(stored?.timeoutSec);
  if (stored !== null && stored.timeoutSec !== seen) {
    setSeen(stored.timeoutSec);
    setDraft(String(minutes));
  }
  const saveMinutes = (): void => {
    const value = Number(draft);
    if (!Number.isInteger(value) || value < 1 || value > 1440) return;
    void store.saveAskUserTimeout(value * 60);
  };
  return (
    <div className={css.settingsRow}>
      <div>
        <span className={css.settingsLabel}>{t('Question wait')}</span>
        <span className={css.settingsDescription}>
          {t('How long a question waits before the agent continues. The question stays answerable. The default is 5 minutes.')}
        </span>
      </div>
      <div>
        <input
          aria-label={t('Question wait in minutes')}
          inputMode="numeric"
          value={indefinite ? '' : draft}
          disabled={indefinite || app.askUserTimeoutSaving}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={saveMinutes}
        />
        <label>
          <input
            type="checkbox"
            checked={indefinite}
            disabled={app.askUserTimeoutSaving}
            onChange={(event) => {
              void store.saveAskUserTimeout(event.target.checked ? -1 : Math.max(1, minutes) * 60);
            }}
          />
          {t('Wait until answered')}
        </label>
        {stored?.requiresSelection === true && (
          <p className={css.settingsHint}>{t('The saved wait is invalid. Saving replaces it with the value shown here.')}</p>
        )}
      </div>
    </div>
  );
}

/**
 * General preferences: permission default, appearance and about. This is the
 * first rail page of the settings panel, so it keeps the pre-rail content.
 */
export function SettingsGeneral(): ReactNode {
  const app = useApp();
  const t = translator(app.locale);
  const [risk, setRisk] = useState<{ acknowledged: boolean } | null>(null);
  const defaultPreset = app.permissions !== null && isPermissionPreset(app.permissions.defaultPreset)
    ? app.permissions.defaultPreset
    : null;

  const chooseDefault = (value: string): void => {
    if (!isPermissionPreset(value)) return;
    if (value === defaultPreset) return;
    if (value === 'danger-full-access') {
      setRisk({ acknowledged: false });
      return;
    }
    void store.saveDefaultPermission(value);
  };

  const permissionItems: MenuEntry[] = [
    ...(app.permissions?.requiresSelection === true
      ? [{ id: '', label: t('Not selected'), disabled: true }]
      : []),
    ...Object.entries(permissionPresets).map(([value, preset]) => ({
      id: value,
      label: t(preset.label),
      icon: permissionIcon(value as PermissionPreset),
    })),
  ];

  return (
    <>
      <section className={css.settingsSection}>
        <h3>{t('Permissions')}</h3>
        <div className={permissionCss.row}>
          <div className={permissionCss.rowText}>
            <span className={permissionCss.title}>{t('Default permission for new sessions')}</span>
            <span className={permissionCss.desc}>
              {t('Each session chooses its own permission; this is the preset a new session starts from.')}
            </span>
          </div>
          <SelectMenu
            value={defaultPreset ?? ''}
            items={permissionItems}
            onSelect={chooseDefault}
            ariaLabel={t('Default permission for new sessions')}
            title={t('Default permission for new sessions')}
            disabled={app.permissionsLoading || app.permissionsSaving || app.permissionsError !== ''}
            align="end"
            leading={defaultPreset === null ? undefined : permissionIcon(defaultPreset)}
            triggerClassName={permissionCss.selector}
            listClassName={css.selectMenuList}
          >
            {defaultPreset === null ? t('Not selected') : t(permissionPresets[defaultPreset].label)}
          </SelectMenu>
        </div>
        {app.permissionsError !== '' && (
          <div className={css.settingsError}>
            <span>{app.permissionsError}</span>
            <Button variant="outline" size="sm" onClick={() => { void store.loadPermissions(); }}>{t('Retry')}</Button>
          </div>
        )}
        {app.permissionsSaving && <p className={css.settingsHint}>{t('Saving…')}</p>}
        {!app.permissionsLoading && app.permissions !== null && app.permissions.requiresSelection
          && defaultPreset === null && (
            <p className={css.settingsHint}>{t('New sessions wait for a permission choice until a default is set.')}</p>
          )}
      </section>

      <section className={css.settingsSection}>
        <h3>{t('Web search')}</h3>
        <WebSearchSettings />
      </section>

      <section className={css.settingsSection}>
        <h3>{t('Questions')}</h3>
        <QuestionTimeout />
      </section>

      <section className={css.settingsSection}>
        <h3>{t('Conversation')}</h3>
        <div className={css.settingsRow}>
          <div>
            <span className={css.settingsLabel}>{t('Send while responding')}</span>
            <span className={css.settingsDescription}>{t('Choose how messages are delivered while the agent is working.')}</span>
          </div>
          <SegmentedControl
            id="settings-busy-send"
            value={app.busySend}
            options={[
              { value: 'queue', label: t('Queue') },
              { value: 'steer', label: t('Steer') },
            ]}
            onChange={(value) => { if (value === 'queue' || value === 'steer') store.setBusySend(value); }}
            label={t('Send while responding')}
          />
        </div>
      </section>

      <section className={css.settingsSection}>
        <h3>{t('Appearance')}</h3>
        <div className={css.settingsRow}>
          <div>
            <span className={css.settingsLabel}>{t('Theme')}</span>
            <span className={css.settingsDescription}>{t('Follow this device with a manual light or dark override.')}</span>
          </div>
          <SegmentedControl
            id="settings-theme"
            value={app.theme}
            options={[
              { value: 'light', label: t('Light') },
              { value: 'dark', label: t('Dark') },
            ]}
            onChange={(value) => {
              const theme = value === 'dark' ? 'dark' : 'light';
              store.setTheme(theme);
            }}
            label={t('Theme')}
          />
        </div>
        <div className={css.settingsRow}>
          <div>
            <span className={css.settingsLabel}>{t('Language')}</span>
            <span className={css.settingsDescription}>{t('Choose the language used by the web interface.')}</span>
          </div>
          <SegmentedControl
            id="settings-language"
            value={app.locale}
            options={localeOptions.map((option) => ({ value: option.value, label: option.label }))}
            onChange={(value) => {
              if (value === 'zh' || value === 'en') store.setLocale(value);
            }}
            label={t('Language')}
          />
        </div>
        <div className={css.settingsRow}>
          <div>
            <span className={css.settingsLabel}>{t('Tool activity')}</span>
            <span className={css.settingsDescription}>{t("Show a turn's reasoning and tool calls expanded by default.")}</span>
          </div>
          <SegmentedControl
            id="settings-process"
            value={app.processDisplay}
            options={[
              { value: 'collapsed', label: t('Collapsed') },
              { value: 'expanded', label: t('Expanded') },
            ]}
            onChange={(value) => { store.setProcessDisplay(value); }}
            label={t('Tool activity display')}
          />
        </div>
      </section>

      <section className={css.settingsSection}>
        <h3>{t('About')}</h3>
        <p className={css.settingsAbout}>
          {t('OmniAgent runs an agent session inside a local workspace. File tools stay inside the selected permission sandbox; approvals pause the turn until a decision is submitted.')}
        </p>
      </section>

      <RiskConfirmation
        open={risk !== null}
        title={t('Enable full access by default?')}
        description={t('Full access lets new sessions modify files without file sandbox restrictions or approval prompts, including sensitive files and external commands. Only use it when you trust subsequent tasks.')}
        acknowledgeLabel={t('I understand the risks')}
        cancelLabel={t('Cancel')}
        closeLabel={t('Close')}
        confirmLabel={t('Enable full access')}
        acknowledged={risk?.acknowledged === true}
        onAcknowledgedChange={(acknowledged) => { setRisk((current) => current === null ? null : { ...current, acknowledged }); }}
        onCancel={() => { setRisk(null); }}
        onConfirm={() => {
          setRisk(null);
          void store.saveDefaultPermission('danger-full-access' satisfies PermissionPreset);
        }}
      />
    </>
  );
}
