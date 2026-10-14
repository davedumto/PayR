export type NavItem = { href: string; label: string };

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/paywalls", label: "Paywalls" },
  { href: "/dashboard/settlements", label: "Settlements" },
  { href: "/dashboard/security", label: "Security" },
  { href: "/dashboard/settings", label: "Settings" },
];

/** Overview matches only exactly; other items match their own section and below. */
export function isActivePath(itemHref: string, pathname: string): boolean {
  if (itemHref === "/dashboard") {
    return pathname === "/dashboard";
  }
  return pathname === itemHref || pathname.startsWith(`${itemHref}/`);
}
