"use client";

import { useEffect, useRef } from "react";

import { NavList } from "@/components/shell/NavList";
import { Wordmark } from "@/components/shell/Wordmark";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

type Props = { onClose: () => void };

/**
 * Off-canvas navigation for narrow screens. While open:
 * - Escape closes it.
 * - Tab and Shift+Tab cycle inside the panel.
 * - Focus moves into the panel, and returns to the opener on close.
 * - Page scroll is locked.
 */
export function MobileDrawer({ onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      opener?.focus();
    };
  }, []);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !panelRef.current) {
      return;
    }

    const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) {
      return;
    }

    const active = document.activeElement;
    const outside = !(active instanceof Node) || !panelRef.current.contains(active);
    if (event.shiftKey && (active === first || outside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || outside)) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="fixed inset-0 z-50 md:hidden">
      <div aria-hidden="true" className="absolute inset-0 bg-slate-black/80" onClick={onClose} />
      <div
        ref={panelRef}
        id="mobile-nav"
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        onKeyDown={handleKeyDown}
        className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col gap-8 border-r border-cement-grey bg-slate-black p-6"
      >
        <div className="flex items-center justify-between">
          <Wordmark />
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded-sm px-3 py-1.5 text-sm text-cyber-tin hover:text-silo-oatmeal"
          >
            Close
          </button>
        </div>
        <NavList onNavigate={onClose} />
      </div>
    </div>
  );
}
