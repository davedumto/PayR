import type { Metadata } from "next";

import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = { title: "New paywall" };

export default function NewPaywallPage() {
  return (
    <>
      <PageHeader
        title="New paywall"
        description="Set an endpoint, a price and a payee. The form arrives in a later milestone."
      />
      <EmptyState
        title="Paywall setup is coming next"
        body="This screen will take an upstream URL, a per-call price and the settlement address. For now it is a placeholder."
        action={{ href: "/dashboard/paywalls", label: "Back to paywalls" }}
      />
    </>
  );
}
