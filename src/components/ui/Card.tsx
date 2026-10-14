import Link from "next/link";

import { cardClass, linkedCardClass } from "@/components/ui/styles";

type StaticProps = { href?: undefined; title: string; children: React.ReactNode };
type LinkedProps = { href: string; title: string; children: React.ReactNode };

/**
 * A bordered container with no fill and no shadow. Pass `href` to make the whole
 * card a link; its border turns crimson on hover and focus.
 */
export function Card(props: StaticProps | LinkedProps) {
  if (props.href !== undefined) {
    return (
      <Link href={props.href} className={linkedCardClass}>
        <h2 className="font-display text-xl uppercase tracking-wide">{props.title}</h2>
        <div className="mt-2 text-sm text-cyber-tin">{props.children}</div>
      </Link>
    );
  }
  return (
    <section className={cardClass}>
      <h2 className="font-display text-xl uppercase tracking-wide">{props.title}</h2>
      <div className="mt-2 text-sm text-cyber-tin">{props.children}</div>
    </section>
  );
}
