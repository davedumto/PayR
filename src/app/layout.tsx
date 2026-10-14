import type { Metadata, Viewport } from "next";

import { bigShoulders, inter, spaceMono } from "@/app/fonts";
import "@/styles/globals.css";

export const metadata: Metadata = {
  title: { default: "Sylox", template: "%s · Sylox" },
  description: "Sylox: one-click x402 paywalls for APIs, built on Vellar.",
};

export const viewport: Viewport = {
  themeColor: "#0b0c0e",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${spaceMono.variable} ${bigShoulders.variable}`}>
      <body className="bg-slate-black text-silo-oatmeal antialiased">{children}</body>
    </html>
  );
}
