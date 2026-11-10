/** Settled state for a file this client cannot render, with the two exits that always work. */
import type { ReactNode } from 'react';
import { translator } from '../../../lib/i18n.ts';
import { useApp } from '../../../lib/store.ts';
import { PreviewUnsupported } from '../PreviewChrome.tsx';
import { rawFileUrl } from '../resource.ts';
import type { ViewerProps } from '../types.ts';

export function UnsupportedViewer({ workspaceId, path }: ViewerProps): ReactNode {
  const t = translator(useApp().locale);
  return (
    <PreviewUnsupported
      path={path}
      reason={t('This file type has no viewer yet.')}
      onDownload={() => { window.open(rawFileUrl(workspaceId, path, { download: true }), '_blank', 'noopener'); }}
      onOpen={() => { window.open(rawFileUrl(workspaceId, path), '_blank', 'noopener'); }}
    />
  );
}
