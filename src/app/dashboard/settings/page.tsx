import type { Metadata } from "next";

import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { getPublicNetwork } from "@/env.edge";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  const network = getPublicNetwork();
  return (
    <>
      <PageHeader
        title="Settings"
        description="Account and workspace settings. Only the network is configurable today."
      />
      <div className="grid grid-cols-1 gap-4">
        <Card title="Network">
          This build settles on <span className="font-mono text-silo-oatmeal">{network}</span>. It
          is set by the NEXT_PUBLIC_VELLAR_NETWORK variable at build time.
        </Card>
      </div>
    </>
  );
}
