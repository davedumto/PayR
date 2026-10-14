import { Badge } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { cardClass } from "@/components/ui/styles";

type Props = {
  title: string;
  body: string;
  action?: { href: string; label: string };
};

export function EmptyState({ title, body, action }: Props) {
  return (
    <section aria-labelledby="empty-state-title" className={`${cardClass} py-12 text-center`}>
      <div className="flex justify-center">
        <Badge>No data yet</Badge>
      </div>
      <h2 id="empty-state-title" className="mt-5 font-display text-2xl uppercase tracking-wide">
        {title}
      </h2>
      <p className="mx-auto mt-2 max-w-prose text-cyber-tin">{body}</p>
      {action ? (
        <div className="mt-8 flex justify-center">
          <ButtonLink href={action.href}>{action.label}</ButtonLink>
        </div>
      ) : null}
    </section>
  );
}
