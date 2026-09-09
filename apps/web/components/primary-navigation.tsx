'use client';

import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { BarChart3, BookOpenCheck, LayoutDashboard, Menu, X } from 'lucide-react';

interface Destination {
  href: string;
  label: string;
  Icon: typeof LayoutDashboard;
  badge?: string;
}

const DESTINATIONS: readonly Destination[] = [
  { href: '/', label: 'Review queue', Icon: LayoutDashboard, badge: 'Live' },
  { href: '/policies', label: 'Policy library', Icon: BookOpenCheck },
  { href: '/analytics', label: 'Analytics', Icon: BarChart3 },
];

/**
 * The header's primary destinations, as one navigation landmark in both layouts.
 *
 * Wide viewports show it inline. Narrow ones collapse it behind a toggle, because the links do not
 * fit beside the workspace context - and until now they were simply hidden below 1180px, which left
 * every destination except the review queue unreachable on a phone.
 *
 * One `<nav>` rather than two: a second landmark with the same label would be announced twice by a
 * screen reader and would make "the primary navigation" ambiguous to query, in tests and for
 * assistive technology alike.
 */
export function PrimaryNavigation() {
  const [open, setOpen] = useState(false);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [open]);

  return (
    <>
      <button
        className="navigation-toggle"
        type="button"
        aria-controls={menuId}
        aria-expanded={open}
        aria-label={open ? 'Close navigation' : 'Open navigation'}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        {open ? <X aria-hidden="true" size={18} /> : <Menu aria-hidden="true" size={18} />}
      </button>

      <nav
        className={open ? 'primary-navigation is-open' : 'primary-navigation'}
        id={menuId}
        aria-label="Primary navigation"
      >
        {DESTINATIONS.map(({ href, label, Icon, badge }) => (
          <Link
            key={href}
            href={href}
            // Closing on selection matters on a phone: the panel covers the page it just navigated
            // to, and nothing else would dismiss it.
            onClick={() => setOpen(false)}
          >
            <Icon aria-hidden="true" size={16} />
            {label}
            {badge ? <span>{badge}</span> : null}
          </Link>
        ))}
      </nav>
    </>
  );
}
