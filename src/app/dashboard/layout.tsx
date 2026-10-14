import { AppShell } from "@/components/shell/AppShell";
import { getEnv } from "@/env";

export default function DashboardLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const { NEXT_PUBLIC_VELLAR_NETWORK } = getEnv();
  return <AppShell network={NEXT_PUBLIC_VELLAR_NETWORK}>{children}</AppShell>;
}
