import { useState, type ReactNode } from 'react';
import {
  Button,
  IconPlusOutlineRegular,
  IconTrashOutlineRegular,
  Input,
  Modal,
  Switch,
  Tag,
} from '../../../vendor/primitives/index.ts';
import { SelectMenu } from '../SelectMenu.tsx';
import { store, useApp } from '../../lib/store.ts';
import { translator, type Translate } from '../../lib/i18n.ts';
import type {
  McpProbeResult,
  McpServerSummary,
  McpServerWrite,
  McpTransport,
} from '../../lib/wire.ts';
import css from '../../styles/settings.module.css';

const SERVER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const TRANSPORTS: McpTransport[] = ['stdio', 'http', 'sse', 'ws'];

function transportLabel(transport: McpTransport, t: Translate): string {
  switch (transport) {
    case 'stdio':
      return t('Standard input/output (stdio)');
    case 'sse':
      return t('HTTP + SSE (legacy)');
    case 'http':
      return t('Streamable HTTP');
    case 'ws':
      return t('WebSocket');
  }
}

function runtimeLabel(server: McpServerSummary, t: Translate): string {
  const runtime = server.runtime;
  if (runtime === undefined) return server.enabled ? t('Not connected') : t('Disabled');
  switch (runtime.state) {
    case 'connected':
      return t('Connected · {count} tools', { count: runtime.toolCount });
    case 'disconnected':
      return t('Not connected');
    case 'disabled':
      return t('Disabled');
    case 'invalid':
      return t('Invalid configuration');
  }
}

function endpointLabel(server: McpServerSummary): string {
  if (server.command !== undefined) {
    return [server.command, ...server.args].join(' ');
  }
  return server.url ?? '';
}

interface TestState {
  pending?: boolean;
  result?: McpProbeResult;
  error?: string;
}

function TestResult({ state, t }: { state: TestState; t: Translate }): ReactNode {
  if (state.pending === true) return <p className={css.hint}>{t('Testing connection…')}</p>;
  if (state.error !== undefined) return <p className={css.formError} role="alert">{state.error}</p>;
  const result = state.result;
  if (result === undefined) return null;
  if (!result.ok) {
    return <p className={css.formError} role="alert">{result.error ?? t('The server did not respond.')}</p>;
  }
  const identity = [result.serverName, result.serverVersion].filter(Boolean).join(' ');
  return (
    <div className={css.mcpTestResult}>
      <span className={css.mcpTestHead}>
        {identity === '' ? t('Connected') : `${identity} · ${t('connected')}`}
        <span className={css.presetDot} aria-hidden>·</span>
        {t('{count} tools', { count: result.tools.length })}
        {result.resources.length > 0 && (
          <>
            <span className={css.presetDot} aria-hidden>·</span>
            {t('{count} resources', { count: result.resources.length })}
          </>
        )}
        {result.prompts.length > 0 && (
          <>
            <span className={css.presetDot} aria-hidden>·</span>
            {t('{count} prompts', { count: result.prompts.length })}
          </>
        )}
      </span>
      {result.tools.length === 0 ? (
        <span className={css.hint}>{t('This server exposes no tools.')}</span>
      ) : (
        <ul className={css.mcpToolList}>
          {result.tools.slice(0, 40).map((tool) => (
            <li key={tool.name} className={css.mcpToolRow}>
              <code className={css.modelId}>{tool.name}</code>
              {tool.readOnly && <Tag tone="outline">{t('Read-only')}</Tag>}
              {tool.description !== undefined && tool.description !== '' && (
                <span className={css.mcpToolDesc}>{tool.description}</span>
              )}
            </li>
          ))}
          {result.tools.length > 40 && (
            <li className={css.hint}>{t('and {count} more', { count: result.tools.length - 40 })}</li>
          )}
        </ul>
      )}
    </div>
  );
}

interface KeyValueRow {
  key: string;
  value: string;
  saved: boolean;
}

interface KeyValueEditorProps {
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  addLabel: string;
  keyPlaceholder: string;
  valuePlaceholder: string;
  savedHint: string;
}

function KeyValueEditor({ rows, onChange, addLabel, keyPlaceholder, valuePlaceholder, savedHint }: KeyValueEditorProps): ReactNode {
  const update = (index: number, patch: Partial<KeyValueRow>): void => {
    onChange(rows.map((row, current) => current === index ? { ...row, ...patch } : row));
  };
  return (
    <div className={css.kvRows}>
      {rows.map((row, index) => (
        <div className={css.kvRow} key={`${row.key}-${index}`}>
          <Input
            value={row.key}
            placeholder={keyPlaceholder}
            disabled={row.saved}
            onChange={(event) => { update(index, { key: event.target.value }); }}
          />
          <Input
            value={row.value}
            placeholder={row.saved ? savedHint : valuePlaceholder}
            onChange={(event) => { update(index, { value: event.target.value }); }}
          />
          <button
            type="button"
            className={css.kvRemove}
            aria-label={addLabel}
            onClick={() => { onChange(rows.filter((_item, current) => current !== index)); }}
          >
            <IconTrashOutlineRegular size={14} />
          </button>
        </div>
      ))}
      <button type="button" className={css.addModelButton} onClick={() => { onChange([...rows, { key: '', value: '', saved: false }]); }}>
        <IconPlusOutlineRegular size={12} />
        {addLabel}
      </button>
    </div>
  );
}

function parseTimeout(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0 || value > 600) return undefined;
  return Math.round(value * 1000);
}

interface EditorProps {
  editing: McpServerSummary | null;
  transports: string[];
  onClose: () => void;
}

function McpServerEditor({ editing, transports, onClose }: EditorProps): ReactNode {
  const app = useApp();
  const t = translator(app.locale);
  const [id, setId] = useState(editing?.id ?? '');
  const [transport, setTransport] = useState<McpTransport>(editing?.transport ?? 'stdio');
  const [command, setCommand] = useState(editing?.command ?? '');
  const [argsText, setArgsText] = useState((editing?.args ?? []).join('\n'));
  const [envRows, setEnvRows] = useState<KeyValueRow[]>(
    (editing?.envKeys ?? []).map((key) => ({ key, value: '', saved: true })),
  );
  const [cwd, setCwd] = useState(editing?.cwd ?? '');
  const [url, setUrl] = useState(editing?.url ?? '');
  const [headerRows, setHeaderRows] = useState<KeyValueRow[]>(
    (editing?.headerKeys ?? []).map((key) => ({ key, value: '', saved: true })),
  );
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);
  const [timeoutText, setTimeoutText] = useState(
    editing?.timeoutMs === undefined ? '60' : String(Math.round(editing.timeoutMs / 1000)),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [test, setTest] = useState<TestState>({});

  const selectable = transports.length > 0 ? transports : TRANSPORTS;
  const current = editing?.transport;
  const transportItems = (current !== undefined && !selectable.includes(current) ? [current, ...selectable] : selectable)
    .filter((item): item is McpTransport => (TRANSPORTS as string[]).includes(item))
    .map((item) => ({ id: item, label: transportLabel(item, t) }));

  const buildInput = (): { input?: McpServerWrite; error?: string } => {
    if (!SERVER_ID.test(id.trim())) {
      return { error: t('Server id must use lowercase letters, digits, dots, dashes or underscores.') };
    }
    const timeoutMs = parseTimeout(timeoutText);
    if (timeoutMs === undefined) {
      return { error: t('Timeout must be a number of seconds between 1 and 600.') };
    }
    const base: McpServerWrite = {
      type: transport,
      enabled,
      timeoutMs,
    };
    if (transport === 'stdio') {
      if (command.trim() === '') return { error: t('A stdio server needs a command.') };
      return {
        input: {
          ...base,
          command: command.trim(),
          args: argsText.split('\n').map((line) => line.trim()).filter((line) => line !== ''),
          env: Object.fromEntries(envRows.filter((row) => row.key.trim() !== '').map((row) => [row.key.trim(), row.value])),
          clearEnv: (editing?.envKeys ?? []).filter((key) => !envRows.some((row) => row.key === key)),
          cwd: cwd.trim() === '' ? null : cwd.trim(),
        },
      };
    }
    if (url.trim() === '') return { error: t('A remote server needs a URL.') };
    return {
      input: {
        ...base,
        url: url.trim(),
        headers: Object.fromEntries(headerRows.filter((row) => row.key.trim() !== '').map((row) => [row.key.trim(), row.value])),
        clearHeaders: (editing?.headerKeys ?? []).filter((key) => !headerRows.some((row) => row.key === key)),
      },
    };
  };

  const runTest = async (): Promise<void> => {
    setError('');
    const built = buildInput();
    if (built.input === undefined) {
      setError(built.error ?? '');
      return;
    }
    setTest({ pending: true });
    try {
      const result = await store.testMcpServer(id.trim(), built.input);
      setTest({ result });
    } catch (failure) {
      setTest({ error: (failure as Error).message });
    }
  };

  const save = async (): Promise<void> => {
    setError('');
    const built = buildInput();
    if (built.input === undefined) {
      setError(built.error ?? '');
      return;
    }
    setSaving(true);
    const failure = await store.saveMcpServer(id.trim(), built.input);
    setSaving(false);
    if (failure === null) onClose();
    else setError(failure);
  };

  const remove = async (): Promise<void> => {
    if (editing === null) return;
    setSaving(true);
    const failure = await store.deleteMcpServer(editing.id);
    setSaving(false);
    if (failure === null) onClose();
    else setError(failure);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={editing === null ? t('New MCP server') : t('Edit MCP server')}
      closeLabel={t('Close')}
      className={css.editorDialogWide}
      footer={(
        <div className={css.editorFooter}>
          {editing !== null && (
            <Button variant="outline" onClick={() => { void remove(); }} disabled={saving}>{t('Delete')}</Button>
          )}
          <Button variant="outline" onClick={() => { void runTest(); }} disabled={saving || test.pending === true}>
            {test.pending === true ? t('Testing…') : t('Test connection')}
          </Button>
          <span className={css.editorFooterGap} />
          <Button variant="outline" onClick={onClose} disabled={saving}>{t('Cancel')}</Button>
          <Button variant="primary" onClick={() => { void save(); }} disabled={saving}>
            {saving ? t('Saving…') : t('Save')}
          </Button>
        </div>
      )}
    >
      <div className={css.editorForm}>
        <div className={css.editorGrid}>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('Server id')}</span>
            <Input value={id} disabled={editing !== null} placeholder="filesystem"
              onChange={(event) => { setId(event.target.value); }} />
            <span className={css.fieldHint}>{t('Used as the key in config.json; cannot be changed later.')}</span>
          </label>
          <div className={css.field}>
            <span className={css.fieldLabel}>{t('Transport')}</span>
            <SelectMenu
              value={transport}
              items={transportItems}
              onSelect={(value) => { setTransport(value as McpTransport); }}
              ariaLabel={t('Transport')}
              title={t('Transport')}
              triggerClassName={css.editorSelect}
            >
              {transportLabel(transport, t)}
            </SelectMenu>
            <span className={css.fieldHint}>{t('stdio runs a local command; Streamable HTTP connects to a remote server. Older HTTP+SSE servers are detected automatically.')}</span>
          </div>
        </div>

        {transport === 'stdio' ? (
          <>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('Command')}</span>
              <Input value={command} placeholder="npx"
                onChange={(event) => { setCommand(event.target.value); }} />
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('Arguments')}</span>
              <textarea
                className={css.agentInstructions}
                value={argsText}
                rows={4}
                placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/workspace'}
                onChange={(event) => { setArgsText(event.target.value); }}
              />
              <span className={css.fieldHint}>{t('One argument per line.')}</span>
            </label>
            <div className={css.field}>
              <span className={css.fieldLabel}>{t('Environment variables')}</span>
              <KeyValueEditor
                rows={envRows}
                onChange={setEnvRows}
                addLabel={t('Add variable')}
                keyPlaceholder="KEY"
                valuePlaceholder={t('Value')}
                savedHint={t('Saved — leave blank to keep')}
              />
              <span className={css.fieldHint}>{t('Stored values are never sent back to this page.')}</span>
            </div>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('Working directory')}</span>
              <Input value={cwd} placeholder={t('Inherit the OmniAgent process directory')}
                onChange={(event) => { setCwd(event.target.value); }} />
            </label>
          </>
        ) : (
          <>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('URL')}</span>
              <Input value={url} placeholder="https://example.com/mcp"
                onChange={(event) => { setUrl(event.target.value); }} />
            </label>
            <div className={css.field}>
              <span className={css.fieldLabel}>{t('Headers')}</span>
              <KeyValueEditor
                rows={headerRows}
                onChange={setHeaderRows}
                addLabel={t('Add header')}
                keyPlaceholder="Authorization"
                valuePlaceholder={t('Value')}
                savedHint={t('Saved — leave blank to keep')}
              />
              <span className={css.fieldHint}>{t('Use headers for bearer tokens and other remote credentials.')}</span>
            </div>
          </>
        )}

        <div className={css.editorGrid}>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('Timeout (seconds)')}</span>
            <Input value={timeoutText} inputMode="numeric"
              onChange={(event) => { setTimeoutText(event.target.value); }} />
            <span className={css.fieldHint}>{t('Connection and per-call timeout. Defaults to 60 seconds.')}</span>
          </label>
          <div className={css.field}>
            <span className={css.fieldLabel}>{t('Enabled')}</span>
            <div className={css.mcpSwitchRow}>
              <Switch checked={enabled} onChange={setEnabled} label={t('Enabled')} />
              <span className={css.fieldHint}>{t('Disabled servers keep their configuration but are not connected.')}</span>
            </div>
          </div>
        </div>

        <TestResult state={test} t={t} />
        {error !== '' && <p className={css.formError} role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

/**
 * Settings → MCP servers. Rows mirror `config.json#mcpServers`; the connection
 * test spawns the server (stdio) or performs the MCP handshake (remote) so the
 * user can verify command, args, environment and headers before relying on it.
 */
export function SettingsMcp(): ReactNode {
  const app = useApp();
  const t = translator(app.locale);
  const [editor, setEditor] = useState<{ editing: McpServerSummary | null } | null>(null);
  const [rowTests, setRowTests] = useState<Record<string, TestState>>({});

  const testServer = async (server: McpServerSummary): Promise<void> => {
    setRowTests((current) => ({ ...current, [server.id]: { pending: true } }));
    try {
      const result = await store.testMcpServer(server.id);
      setRowTests((current) => ({ ...current, [server.id]: { result } }));
    } catch (failure) {
      setRowTests((current) => ({ ...current, [server.id]: { error: (failure as Error).message } }));
    }
  };

  return (
    <section className={css.page}>
      <header className={css.pageHead}>
        <div>
          <h2 className={css.pageTitle}>{t('MCP servers')}</h2>
          <p className={css.pageIntro}>
            {t('Connect Model Context Protocol servers to give agents their tools. stdio, streamable HTTP, legacy SSE and WebSocket servers are supported.')}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => { setEditor({ editing: null }); }}>
          {t('Add server')}
        </Button>
      </header>

      {app.mcpServersError !== '' && (
        <div className={css.error} role="alert">
          <span>{t('Could not load MCP servers: {message}', { message: app.mcpServersError })}</span>
          <Button variant="outline" size="sm" onClick={() => { void store.loadMcpServers(); }}>{t('Retry')}</Button>
        </div>
      )}
      {app.mcpServersLoading && <p className={css.hint}>{t('Loading…')}</p>}

      <section className={css.group}>
        <h3 className={css.groupHead}>{t('Configured servers')}</h3>
        {app.mcpServers.length === 0 && !app.mcpServersLoading ? (
          <div className={css.emptyCustom}>
            <p className={css.hint}>
              {t('No MCP servers yet. Add a local stdio server or a remote HTTP/SSE endpoint to expose its tools.')}
            </p>
            <Button variant="outline" size="sm" onClick={() => { setEditor({ editing: null }); }}>{t('Add server')}</Button>
          </div>
        ) : (
          <ul className={css.agentList}>
            {app.mcpServers.map((server) => (
              <li key={server.id} className={css.agentRow}>
                <div className={css.agentRowHead}>
                  <div className={css.agentIdentity}>
                    <span className={css.modelName}>
                      {server.id}
                      <Tag tone="outline">{transportLabel(server.transport, t)}</Tag>
                      {!server.enabled && <Tag tone="outline">{t('Disabled')}</Tag>}
                      {!server.valid && <Tag tone="outline">{t('Invalid')}</Tag>}
                    </span>
                    <code className={css.modelId}>{endpointLabel(server)}</code>
                    <span className={css.agentMeta}>
                      <span>{runtimeLabel(server, t)}</span>
                      {server.envKeys.length > 0 && (
                        <>
                          <span className={css.presetDot} aria-hidden>·</span>
                          <span>{t('{count} environment variables', { count: server.envKeys.length })}</span>
                        </>
                      )}
                      {server.headerKeys.length > 0 && (
                        <>
                          <span className={css.presetDot} aria-hidden>·</span>
                          <span>{t('{count} headers', { count: server.headerKeys.length })}</span>
                        </>
                      )}
                      {server.timeoutMs !== undefined && (
                        <>
                          <span className={css.presetDot} aria-hidden>·</span>
                          <span>{t('{count}s timeout', { count: Math.round(server.timeoutMs / 1000) })}</span>
                        </>
                      )}
                    </span>
                  </div>
                  <div className={css.mcpActions}>
                    <Button variant="outline" size="sm"
                      disabled={rowTests[server.id]?.pending === true}
                      onClick={() => { void testServer(server); }}>
                      {rowTests[server.id]?.pending === true ? t('Testing…') : t('Test')}
                    </Button>
                    <Button variant="outline" size="sm"
                      onClick={() => { setEditor({ editing: server }); }}>
                      {t('Edit')}
                    </Button>
                  </div>
                </div>
                {!server.valid && server.error !== undefined && (
                  <span className={css.presetWarning} role="alert">{server.error}</span>
                )}
                {server.runtime?.error !== undefined && (
                  <span className={css.presetWarning} role="alert">{server.runtime.error}</span>
                )}
                {rowTests[server.id] !== undefined && (
                  <TestResult state={rowTests[server.id]!} t={t} />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {editor !== null && (
        <McpServerEditor
          key={editor.editing?.id ?? 'new-mcp-server'}
          editing={editor.editing}
          transports={app.mcpTransports}
          onClose={() => { setEditor(null); }}
        />
      )}
    </section>
  );
}
