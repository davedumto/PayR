"use client";

import { useRef, useState } from "react";

import { MobileDrawer } from "@/components/shell/MobileDrawer";
import { NavList } from "@/components/shell/NavList";
import { NetworkNotice } from "@/components/shell/NetworkNotice";
import { Wordmark } from "@/components/shell/Wordmark";
import { Badge } from "@/components/ui/Badge";

type Props = {
  network: "testnet" | "mainnet";
  children: React.ReactNode;
};

/**
 * Dashboard frame: persistent 240px sidebar and 64px top bar on desktop,
 * a navigation drawer below md. The content column is centred and capped in width.
 */
export function AppShell({ network, children }: Props) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="min-h-dvh bg-slate-black">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:rounded-sm focus:bg-slate-black focus:px-4 focus:py-2 focus:text-sm focus:text-silo-oatmeal"
      >
        Skip to content
      </a>

      <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col gap-10 border-r border-cement-grey bg-slate-black p-6 md:flex">
        <Wordmark />
        <NavList />
      </aside>

      <div inert={drawerOpen} className="flex min-h-dvh flex-col md:pl-60">
        <NetworkNotice network={network} />

        <header className="flex h-16 items-center justify-between border-b border-cement-grey px-4 md:px-8">
          <div className="flex items-center gap-4">
            <button
              ref={menuButtonRef}
              type="button"
              aria-controls="mobile-nav"
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen(true)}
              className="rounded-sm border border-cement-grey px-3 py-1.5 text-sm text-silo-oatmeal md:hidden"
            >
              Menu
            </button>
            <span className="md:hidden">
              <Wordmark />
            </span>
          </div>
          <Badge variant={network === "testnet" ? "crimson" : "warning"}>
            {network === "testnet" ? "Testnet" : "Mainnet"}
          </Badge>
        </header>

        <main
          id="main"
          tabIndex={-1}
          className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 md:px-8"
        >
          {children}
        </main>
      </div>

      {drawerOpen ? <MobileDrawer onClose={() => setDrawerOpen(false)} /> : null}
    </div>
  );
}
