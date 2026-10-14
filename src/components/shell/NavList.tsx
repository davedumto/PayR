"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { isActivePath, NAV_ITEMS } from "@/lib/nav";

type Props = { onNavigate?: () => void };

/**
 * Primary navigation. The active item gets a thin crimson marker on its left
 * edge and aria-current, not a filled highlight.
 */
export function NavList({ onNavigate }: Props) {
  const pathname = usePathname();

  return (
    <nav aria-label="Primary">
      <ul className="flex flex-col gap-1">
        {NAV_ITEMS.map((item) => {
          const active = isActivePath(item.href, pathname);
          return (
            <li key={item.href} className="relative">
              {active ? (
                <span
                  aria-hidden="true"
                  className="absolute top-2 bottom-2 left-0 w-[2px] bg-risk-crimson"
                />
              ) : null}
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                onClick={onNavigate}
                className={`block rounded-sm px-4 py-2.5 text-sm transition-colors hover:text-silo-oatmeal ${
                  active ? "text-silo-oatmeal" : "text-cyber-tin"
                }`}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
