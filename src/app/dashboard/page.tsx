import type { Metadata } from "next";

import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = { title: "Overview" };

const STATS = [
  { label: "Live paywalls" },
  { label: "Settlements, 30 days" },
  { label: "Revenue, 30 days" },
] as const;

export default function OverviewPage() {
  return (
    <>
      <PageHeader
        title="Overview"
        description="Paywalls, settlements and security at a glance. Figures appear once your first paywall is live."
      />

      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {STATS.map((stat) => (
          <div key={stat.label} className="rounded-sm border border-cement-grey p-6">
            <dt className="font-mono text-[11px] uppercase tracking-wider text-cyber-tin">
              {stat.label}
            </dt>
            <dd className="mt-3 font-mono text-3xl text-silo-oatmeal" aria-label="No data yet">
              —
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card title="Create a paywall" href="/dashboard/paywalls/new">
          Put a price on an endpoint and let agents pay per call.
        </Card>
        <Card title="Review settlements" href="/dashboard/settlements">
          See what has been paid, when, and to which address.
        </Card>
        <Card title="Check security" href="/dashboard/security">
          Review keys, allowed origins and recent alerts.
        </Card>
      </div>
    </>
  );
}
