import { useState, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  IconChevronDownOutlineRegular,
  Menu,
  type MenuEntry,
} from '../../vendor/primitives/index.ts';
import triggerCss from '../styles/dsh/permission-select.module.css';

/**
 * One anchored dropdown selection over the DSH Menu primitive. The trigger
 * chrome defaults to DSH's permission trigger; callers that live in another
 * surface (sidebar field, settings row, trajectory toolbar) pass their own
 * class while keeping the same open/close, keyboard, and selection behavior.
 */
export function SelectMenu({
  value,
  items,
  onSelect,
  ariaLabel,
  children,
  title,
  disabled = false,
  triggerClassName,
  labelClassName,
  chevronClassName,
  leading,
  side = 'bottom',
  align = 'start',
  portal = true,
  minWidthFromAnchor = false,
  listClassName,
  wrapperClassName,
}: {
  value: string;
  items: readonly MenuEntry[];
  onSelect: (id: string) => void;
  ariaLabel: string;
  children: ReactNode;
  title?: string;
  disabled?: boolean;
  triggerClassName?: string;
  labelClassName?: string;
  chevronClassName?: string;
  leading?: ReactNode;
  side?: 'top' | 'bottom';
  align?: 'start' | 'end';
  portal?: boolean;
  minWidthFromAnchor?: boolean;
  listClassName?: string;
  wrapperClassName?: string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <Menu
      open={open}
      items={items}
      selectedId={value}
      onSelect={(id) => {
        setOpen(false);
        onSelect(id);
      }}
      onClose={() => { setOpen(false); }}
      side={side}
      align={align}
      portal={portal}
      minWidthFromAnchor={minWidthFromAnchor}
      listClassName={listClassName}
      className={wrapperClassName}
      anchor={(
        <button
          type="button"
          className={triggerClassName ?? triggerCss.trigger}
          aria-label={ariaLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          title={title}
          disabled={disabled}
          onClick={() => { setOpen((current) => !current); }}
        >
          {leading !== undefined && <span className={triggerCss.triggerIcon} aria-hidden>{leading}</span>}
          <span className={labelClassName ?? triggerCss.triggerLabel}>{children}</span>
          <span className={clsx(triggerCss.chevron, chevronClassName, open && triggerCss.chevronOpen)} aria-hidden>
            <IconChevronDownOutlineRegular />
          </span>
        </button>
      )}
    />
  );
}
