// Shared class strings for buttons, cards and badges, so a <Link> and a
// <button> render identically.

export type ButtonVariant = "primary" | "secondary";

export function buttonClass(variant: ButtonVariant = "primary"): string {
  const base =
    "inline-flex items-center justify-center rounded-full px-5 py-2.5 text-sm font-semibold transition-colors";
  const variants: Record<ButtonVariant, string> = {
    // Text is slate black, not oatmeal: oatmeal on crimson is about 3:1 and fails AA.
    primary: "bg-risk-crimson text-slate-black hover:opacity-90",
    secondary: "border border-cement-grey text-silo-oatmeal hover:border-silo-oatmeal",
  };
  return `${base} ${variants[variant]}`;
}

export const cardClass = "rounded-sm border border-cement-grey p-6";

export const linkedCardClass =
  "block rounded-sm border border-cement-grey p-6 transition-colors hover:border-risk-crimson";

export type BadgeVariant = "neutral" | "success" | "warning" | "risk" | "crimson";

export const badgeVariants: Record<BadgeVariant, string> = {
  neutral: "border-cement-grey text-cyber-tin",
  success: "border-risk-low text-risk-low",
  warning: "border-risk-moderate text-risk-moderate",
  risk: "border-risk-elevated text-risk-elevated",
  crimson: "border-risk-crimson text-risk-crimson-tint",
};
