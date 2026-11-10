/**
 * The preview surface: classify the path, load its body, then hand both to the
 * one viewer that renders that kind. Every state a user can reach — loading,
 * failure, unsupported, ready — renders inside the same frame, so the panel
 * never jumps between layouts.
 *
 * There is no header of its own: the dock tab already names the file, and the
 * workspace is implied by the session.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { PreviewFailure, PreviewSkeleton } from './PreviewChrome.tsx';
import { previewKindFor } from './path.ts';
import { usePreviewResource } from './resource.ts';
import { viewerFor } from './registry.ts';
import type { FileSelection } from './types.ts';
import css from '../../styles/preview.module.css';

export function PreviewSurface({ file }: { file: FileSelection }): ReactNode {
  const kind = previewKindFor(file.path);
  const [attempt, setAttempt] = useState(0);
  const resource = usePreviewResource(file.workspaceId, file.path, kind, attempt);
  const Viewer = useMemo(() => viewerFor(kind), [kind]);

  const payload = resource.status === 'text'
    ? { text: resource.text }
    : resource.status === 'bytes'
      ? { bytes: resource.bytes }
      : resource.status === 'url'
        ? { url: resource.url }
        : {};

  return (
    <div className={css.root}>
      <div className={css.body}>
        {resource.status === 'loading' && <PreviewSkeleton />}
        {resource.status === 'error' && (
          <PreviewFailure message={resource.message} onRetry={() => { setAttempt((value) => value + 1); }} />
        )}
        {resource.status !== 'loading' && resource.status !== 'error' && (
          <Viewer
            workspaceId={file.workspaceId}
            path={file.path}
            {...(file.line === undefined ? {} : { line: file.line })}
            {...payload}
          />
        )}
      </div>
    </div>
  );
}
