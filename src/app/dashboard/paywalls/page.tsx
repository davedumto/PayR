import type { Metadata } from "next";

import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = { title: "Paywalls" };

export default function PaywallsPage() {
  return (
    <>
      <PageHeader
        title="Paywalls"
        description="Each paywall wraps one API endpoint with a price per request."
      />
      <EmptyState
        title="No paywalls yet"
        body="Create your first paywall to start charging per request. Nothing is live until you publish it."
        action={{ href: "/dashboard/paywalls/new", label: "New paywall" }}
      />
    </>
  );
}
