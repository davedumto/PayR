import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center px-4 text-center">
      <p className="font-mono text-sm uppercase tracking-wider text-cyber-tin">404</p>
      <h1 className="mt-3 font-display text-4xl uppercase">Page not found</h1>
      <Link
        href="/dashboard"
        className="mt-8 rounded-full border border-cement-grey px-5 py-2.5 text-sm text-silo-oatmeal hover:border-silo-oatmeal"
      >
        Back to overview
      </Link>
    </main>
  );
}
