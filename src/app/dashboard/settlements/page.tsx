import type { Metadata } from "next";

import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = { title: "Settlements" };

export default function SettlementsPage() {
  return (
    <>
      <PageHeader
        title="Settlements"
        description="Every payment your paywalls have settled, with its transaction hash."
      />
      <EmptyState
        title="No settlements yet"
        body="Settled payments appear here as soon as an agent pays one of your paywalls."
      />
    </>
  );
}
