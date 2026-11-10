/** Right-panel entry point for a file preview; the surface owns layout and dispatch. */
import type { ReactNode } from 'react';
import { PreviewSurface } from './preview/PreviewSurface.tsx';
import type { FileSelection } from './preview/types.ts';

export type { FileSelection } from './preview/types.ts';

export function WorkspaceFilePreview({ file }: { file: FileSelection }): ReactNode {
  // A new file must not reuse the previous file's settled resource, even for one frame.
  return <PreviewSurface key={`${file.workspaceId}\0${file.path}`} file={file} />;
}
