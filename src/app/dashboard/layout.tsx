import { AppShell } from "@/components/shell/AppShell";
import { getPublicNetwork } from "@/env.proxy";

export default function DashboardLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <AppShell network={getPublicNetwork()}>{children}</AppShell>;
}
