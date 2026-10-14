import type { Metadata } from "next";

import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = { title: "Security" };

export default function SecurityPage() {
  return (
    <>
      <PageHeader
        title="Security"
        description="Keys, allowed origins and alerts for your paywalls."
      />
      <EmptyState
        title="Nothing to review"
        body="Access events and key activity will be listed here once paywalls are live."
      />
    </>
  );
}
