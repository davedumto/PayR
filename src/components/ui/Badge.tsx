import { badgeVariants, type BadgeVariant } from "@/components/ui/styles";

type Props = { variant?: BadgeVariant; children: React.ReactNode };

/** Compact status tag. Always carries a text label; colour alone never signals risk. */
export function Badge({ variant = "neutral", children }: Props) {
  return (
    <span
      className={`inline-flex items-center rounded-sm border px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider ${badgeVariants[variant]}`}
    >
      {children}
    </span>
  );
}
