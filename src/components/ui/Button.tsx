import Link from "next/link";

import { buttonClass, type ButtonVariant } from "@/components/ui/styles";

type Props = {
  variant?: ButtonVariant;
  href: string;
  children: React.ReactNode;
};

export function ButtonLink({ variant = "primary", href, children }: Props) {
  return (
    <Link href={href} className={buttonClass(variant)}>
      {children}
    </Link>
  );
}
