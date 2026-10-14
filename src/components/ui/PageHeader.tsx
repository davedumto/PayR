type Props = { title: string; description?: string };

export function PageHeader({ title, description }: Props) {
  return (
    <header className="mb-10">
      <h1 className="font-display text-4xl uppercase leading-none tracking-wide md:text-5xl">
        {title}
      </h1>
      {description ? <p className="mt-3 max-w-prose text-cyber-tin">{description}</p> : null}
    </header>
  );
}
