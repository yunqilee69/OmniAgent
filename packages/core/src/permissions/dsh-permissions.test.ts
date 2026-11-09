import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStore } from '../session/store';
import {
  DSH_PERMISSION_PRESETS,
  DSH_PRESET_BUNDLES,
  createDshPresetSwitch,
  createInitialDshPermissionEvent,
  projectDshPermissions,
  resolveDshDefaultPreset,
  snapshotDshPermissions,
} from './dsh-permissions';

describe('DSH permission presets', () => {
  it('exposes the closed preset and bundle contract', () => {
    expect(DSH_PERMISSION_PRESETS).toEqual([
      'read-only', 'workspace-write', 'danger-full-access',
    ]);
    expect(DSH_PRESET_BUNDLES).toEqual({
      'read-only': { sandbox: 'read-only', approval: 'ask' },
      'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
      'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
    });
  });

  it('resolves only a genuinely absent default to workspace-write', () => {
    expect(resolveDshDefaultPreset(undefined)).toEqual({ defaultPreset: 'workspace-write', requiresSelection: false });
    for (const preset of DSH_PERMISSION_PRESETS) {
      expect(resolveDshDefaultPreset(preset)).toEqual({ defaultPreset: preset, requiresSelection: false });
    }
    for (const invalid of [null, '', 'invalid-preset', '__proto__', 1, {}]) {
      expect(resolveDshDefaultPreset(invalid)).toEqual({ defaultPreset: null, requiresSelection: true });
    }
  });

  it('requires a valid explicit initial preset and makes a complete atomic event', () => {
    for (const preset of DSH_PERMISSION_PRESETS) {
      expect(createInitialDshPermissionEvent(preset)).toEqual({
        type: 'permission/dsh-preset', data: { version: 1, preset },
      });
    }
    for (const invalid of [undefined, null, 'invalid-preset', '__proto__', {}, 1]) {
      expect(() => createInitialDshPermissionEvent(invalid)).toThrow();
    }
  });

  it('does not infer permissions from an empty log or unrelated events', () => {
    const legacy = projectDshPermissions([
      { type: 'message/user', data: { text: 'hello' } },
    ]);
    expect(legacy).toEqual({ status: 'legacy', preset: null });
    expect(projectDshPermissions([])).toEqual({ status: 'legacy', preset: null });
    expect(() => snapshotDshPermissions(legacy)).toThrow();
  });

  it('replays the last complete preset while ignoring unrelated events', () => {
    const events = [
      createInitialDshPermissionEvent('read-only'),
      { type: 'message/user', data: { text: 'hello' } },
      createInitialDshPermissionEvent('workspace-write'),
    ];
    expect(projectDshPermissions(events)).toEqual({ status: 'ready', preset: 'workspace-write' });
    expect(events[0]?.data).toEqual({ version: 1, preset: 'read-only' });
  });

  it.each([
    null,
    {},
    { version: 2, preset: 'danger-full-access' },
    { version: 1, preset: 'invalid-preset' },
    { version: 1, preset: 'danger-full-access', extra: true },
  ])('fails closed when the latest event is malformed: %j', (data) => {
    const projection = projectDshPermissions([
      createInitialDshPermissionEvent('read-only'),
      { type: 'permission/dsh-preset', data },
    ]);
    expect(projection).toEqual({ status: 'invalid', preset: null });
    expect(() => snapshotDshPermissions(projection)).toThrow();
  });

  it('permits only an explicit validated switch and no-ops for the current preset', () => {
    const legacy = projectDshPermissions([]);
    const initial = createDshPresetSwitch(legacy, 'read-only');
    expect(initial).toEqual(createInitialDshPermissionEvent('read-only'));
    const selected = projectDshPermissions([initial!]);
    expect(createDshPresetSwitch(selected, 'read-only')).toBeUndefined();
    expect(createDshPresetSwitch(selected, 'danger-full-access')).toEqual(
      createInitialDshPermissionEvent('danger-full-access'),
    );
    for (const invalid of [undefined, null, 'auto', 'custom', 'invalid-preset', '__proto__', {}]) {
      expect(() => createDshPresetSwitch(selected, invalid)).toThrow();
    }
  });

  it('allows an explicit switch to recover an invalid history', () => {
    const invalid = projectDshPermissions([{ type: 'permission/dsh-preset', data: { version: 0 } }]);
    const event = createDshPresetSwitch(invalid, 'read-only');
    expect(projectDshPermissions([{ type: 'permission/dsh-preset', data: { version: 0 } }, event!]))
      .toEqual({ status: 'ready', preset: 'read-only' });
  });

  it('captures an immutable bundle that does not change when the session switches', () => {
    const initial = createInitialDshPermissionEvent('read-only');
    const snapshot = snapshotDshPermissions(projectDshPermissions([initial]));
    const switched = projectDshPermissions([initial, createInitialDshPermissionEvent('danger-full-access')]);
    expect(snapshot).toEqual({ preset: 'read-only', sandbox: 'read-only', approval: 'ask' });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshotDshPermissions(switched)).toEqual({
      preset: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never',
    });
    expect(() => snapshotDshPermissions({ status: 'ready', preset: 'invalid-preset' } as never)).toThrow();
  });

  it('persists and restores the selected preset through SessionStore without entering the transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omniagent-dsh-permissions-'));
    try {
      const store = new SessionStore(root);
      const handle = await store.create({ id: 'permissions', workspace: root, cwd: root });
      await handle.append(createInitialDshPermissionEvent('workspace-write'));
      await handle.append({ type: 'message/user', data: { text: 'hello' } });
      const beforeSwitch = projectDshPermissions(handle.events);
      await handle.append(createDshPresetSwitch(beforeSwitch, 'read-only')!);
      await handle.close();

      const reopened = await new SessionStore(root).open(root, 'permissions');
      expect(projectDshPermissions(reopened.events)).toEqual({ status: 'ready', preset: 'read-only' });
      expect(reopened.messages.map((event) => event.type)).toEqual(['message/user']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
