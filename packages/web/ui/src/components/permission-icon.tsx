import type { ReactNode } from 'react';
import {
  PermissionIconFullAccessRegular,
  PermissionIconReadOnlyRegular,
  PermissionIconWorkspaceWriteRegular,
} from '../../vendor/primitives/index.ts';
import type { PermissionPreset } from '../lib/wire.ts';

export function permissionIcon(preset: PermissionPreset | null): ReactNode {
  switch (preset) {
    case 'read-only': return <PermissionIconReadOnlyRegular />;
    case 'workspace-write': return <PermissionIconWorkspaceWriteRegular />;
    case 'danger-full-access': return <PermissionIconFullAccessRegular />;
    default: return <PermissionIconReadOnlyRegular />;
  }
}
