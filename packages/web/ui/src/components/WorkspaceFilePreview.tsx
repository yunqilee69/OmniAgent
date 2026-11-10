import { useEffect, useState, type ReactNode } from 'react';
import { authFetch } from '../lib/auth.ts';
import { translator } from '../lib/i18n.ts';
import { useApp } from '../lib/store.ts';
import { workspaceApiPath } from '../lib/wire.ts';
import css from '../styles/workspace-files.module.css';

export interface FileSelection { workspaceId: string; workspaceName: string; path: string }

export function WorkspaceFilePreview({ file }: { file: FileSelection }): ReactNode {
  const t = translator(useApp().locale);
  const [result, setResult] = useState<{ key: string; content?: string; error?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([file.workspaceId, file.path]);
  useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    const query = new URLSearchParams({ path: file.path });
    void authFetch(workspaceApiPath(file.workspaceId, `files/content?${query}`), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          if (response.status === 413) throw new Error('File is too large to preview.');
          if (response.status === 415) throw new Error('Binary files cannot be previewed.');
          throw new Error('Could not load file.');
        }
        return await response.json() as { content: string };
      })
      .then((body) => { if (!controller.signal.aborted) setResult({ key, content: body.content }); })
      .catch((error: Error) => { if (!controller.signal.aborted) setResult({ key, error: error.message }); });
    return () => { controller.abort(); };
  }, [file.workspaceId, file.path, key, attempt]);
  const current = result?.key === key ? result : null;
  return <div className={css.preview}>
    <div className={css.previewPath} title={`${file.workspaceName} / ${file.path}`}><strong>{file.workspaceName}</strong><span>{file.path}</span></div>
    {current === null && <div className={css.status}>{t('Loading file…')}</div>}
    {current?.error && <div className={css.status} role="alert">{t(current.error)} <button type="button" onClick={() => { setAttempt((value) => value + 1); }}>{t('Retry')}</button></div>}
    {current?.content !== undefined && <pre className={css.content}><code>{current.content}</code></pre>}
  </div>;
}
