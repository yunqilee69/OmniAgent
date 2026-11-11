import { useEffect, useRef, useState, type CSSProperties, type MutableRefObject, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPosition, useDismissOnOutsidePointer } from '../../vendor/primitives/index.ts';
import css from '../styles/dsh/stat-dialog.module.css';

/** Viewport margin the placement clamp keeps. */
const PANEL_MARGIN = 12;
/** Distance between the trigger's top edge and the panel's bottom. */
const PANEL_GAP = 8;

/** Unplaced portal panel: hidden but laid out so the clamp measures real dimensions. */
export const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 };

/** Open state, refs, and clamped placement for one trigger-anchored dialog. */
export interface StatDialogSeat {
  open: boolean;
  setOpen: (open: boolean) => void;
  rootRef: MutableRefObject<HTMLSpanElement | null>;
  panelRef: MutableRefObject<HTMLDivElement | null>;
  pos: CSSProperties | null;
}

/**
 * One trigger-anchored dialog seat: open state, viewport-clamped placement above
 * the trigger, and dismissal on Escape or an outside pointerdown/click. Each
 * reading owns its own seat, so opening one dialog closes the other.
 */
export function useStatDialog(): StatDialogSeat {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const pos = useAnchoredPosition({ open, anchorRef: rootRef, panelRef, side: 'top', gap: PANEL_GAP, margin: PANEL_MARGIN });
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onClick = (event: MouseEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target) !== true
        && panelRef.current?.contains(event.target) !== true) setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('click', onClick, true);
    };
  }, [open, setOpen]);
  return { open, setOpen, rootRef, panelRef, pos };
}

/**
 * Title line plus hairline rule shared by every reading dialog; the details list
 * or context legend renders as children.
 */
export function StatDialogChrome({ seat, label, title, titleValue, icon, children }: {
  seat: StatDialogSeat;
  label: string;
  title: ReactNode;
  titleValue?: ReactNode;
  icon: ReactNode;
  children: ReactNode;
}): ReactNode {
  return createPortal(
    <div ref={seat.panelRef} className={css.panel} role="dialog" aria-label={label} style={seat.pos ?? MEASURE_STYLE}>
      <div className={css.title}>
        <span className={css.titleLabel}>{icon}{title}</span>
        {titleValue !== undefined && <span className={css.titleValue}>{titleValue}</span>}
      </div>
      <div className={css.titleRule} aria-hidden />
      {children}
    </div>,
    document.body,
  );
}
