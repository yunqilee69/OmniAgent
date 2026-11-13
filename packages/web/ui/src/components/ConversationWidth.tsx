import { useCallback, useLayoutEffect, useRef, type ReactNode, type WheelEvent as ReactWheelEvent, type PointerEvent as ReactPointerEvent } from 'react';
import css from '../styles/app.module.css';
import { readWidthPreference, resolveContentWidth, WIDTH_PREF_KEY } from '../lib/conversation-width.ts';

const WHEEL_DELTA_LINE = 1;
const WHEEL_DELTA_PAGE = 2;
const FALLBACK_WHEEL_LINE_PX = 16;

function storageOrNull(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

/** Convert a wheel event's vertical delta to scrollport pixels. */
function wheelDeltaY(event: ReactWheelEvent, scrollport: HTMLElement): number {
  if (event.deltaMode === WHEEL_DELTA_LINE) {
    const lineHeight = Number.parseFloat(getComputedStyle(scrollport).lineHeight);
    return event.deltaY * (Number.isFinite(lineHeight) ? lineHeight : FALLBACK_WHEEL_LINE_PX);
  }
  if (event.deltaMode === WHEEL_DELTA_PAGE) return event.deltaY * scrollport.clientHeight;
  return event.deltaY;
}

/** Publish one resolved message-column width and the table cap derived from it. */
function publishResolved(column: HTMLElement, width: number | null): void {
  if (width === null) column.style.removeProperty('--dsh-chat-user-width');
  else column.style.setProperty('--dsh-chat-user-width', `${width}px`);
  // Table cells cannot divide a custom property (the declaration is dropped),
  // so the quarter-column cap has to be a concrete length. Without a drag the
  // adaptive clamp resolves it; CSS still clamps the column on a narrow window.
  const content = width ?? resolveContentWidth(column.offsetWidth, null);
  column.style.setProperty('--dsh-chat-table-cell-max', `${Math.max(320, content / 4)}px`);
}

/** Publish the measured column and the clamped preference onto the width axis. */
function publishWidths(column: HTMLElement): void {
  column.style.setProperty('--dsh-conversation-column-width', `${column.offsetWidth}px`);
  const preference = readWidthPreference(storageOrNull());
  publishResolved(column, preference === null ? null : resolveContentWidth(column.offsetWidth, preference));
}

/** One pointer-captured transcript width handle. */
function WidthHandle(props: {
  side: 'left' | 'right';
  onStart: () => number;
  onDrag: (width: number) => void;
  onCommit: (width: number) => void;
  onEnd: () => void;
}): ReactNode {
  const dragging = useRef(false);
  const base = useRef(0);
  const origin = useRef(0);
  const latest = useRef(0);
  const frame = useRef<number | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;

  const outwardWidth = (): number => {
    const dx = latest.current - origin.current;
    const outward = callbacks.current.side === 'right' ? dx : -dx;
    return base.current + outward * 2;
  };
  const cancelFrame = (): void => {
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
  };
  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    origin.current = event.clientX;
    latest.current = event.clientX;
    base.current = callbacks.current.onStart();
    dragging.current = true;
    event.currentTarget.toggleAttribute('data-dragging', true);
  }, []);
  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const box = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty('--dsh-width-handle-pointer-y', `${event.clientY - box.top}px`);
    latest.current = event.clientX;
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null;
      callbacks.current.onDrag(outwardWidth());
    });
  }, []);
  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    dragging.current = false;
    event.currentTarget.toggleAttribute('data-dragging', false);
    event.currentTarget.releasePointerCapture(event.pointerId);
    cancelFrame();
    latest.current = event.clientX;
    // A press-only gesture must not overwrite a wider preference with its window-clamped display value.
    if (latest.current !== origin.current) callbacks.current.onCommit(outwardWidth());
    callbacks.current.onEnd();
  }, []);
  const onPointerCancel = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    event.currentTarget.toggleAttribute('data-dragging', false);
    cancelFrame();
    callbacks.current.onEnd();
  }, []);
  const onWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const body = event.currentTarget.parentElement;
    if (body === null) return;
    const scrollport = body.querySelector<HTMLElement>('[data-conversation-scroll]');
    if (scrollport === null) return;
    if (event.ctrlKey || event.deltaY === 0) return;
    scrollport.scrollBy({ top: wheelDeltaY(event, scrollport) });
  }, []);

  return (
    <div
      className={css.widthHandle}
      data-side={props.side}
      data-width-handle={props.side}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
      onWheel={onWheel}
    />
  );
}

/**
 * Measure one conversation column and render the drag handles that resize it.
 * The measured width feeds `--dsh-chat-content-width`; a drag is remembered.
 */
export function ConversationWidth(): ReactNode {
  const column = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = column.current?.parentElement;
    if (element === undefined || element === null) return;
    const observer = new ResizeObserver(() => { publishWidths(element); });
    observer.observe(element);
    publishWidths(element);
    return () => { observer.disconnect(); };
  }, []);

  const onStart = useCallback((): number => {
    const element = column.current?.parentElement;
    if (element === undefined || element === null) return 680;
    return resolveContentWidth(element.offsetWidth, readWidthPreference(storageOrNull()));
  }, []);
  const onDrag = useCallback((width: number): void => {
    const element = column.current?.parentElement;
    if (element === undefined || element === null) return;
    publishResolved(element, resolveContentWidth(element.offsetWidth, width));
  }, []);
  const onCommit = useCallback((width: number): void => {
    const element = column.current?.parentElement;
    if (element === undefined || element === null) return;
    storageOrNull()?.setItem(WIDTH_PREF_KEY, `${resolveContentWidth(element.offsetWidth, width)}`);
  }, []);
  const onEnd = useCallback((): void => {
    const element = column.current?.parentElement;
    if (element !== undefined && element !== null) publishWidths(element);
  }, []);

  return (
    <>
      <div ref={column} hidden />
      {(['left', 'right'] as const).map((side) => (
        <WidthHandle key={side} side={side} onStart={onStart} onDrag={onDrag} onCommit={onCommit} onEnd={onEnd} />
      ))}
    </>
  );
}
