import localFont from "next/font/local";

// Self-hosted from /fonts (Latin subsets, SIL OFL). No runtime request leaves
// the origin: next/font/local copies these files into the build output.
export const inter = localFont({
  src: [
    { path: "../../fonts/Inter-Regular.woff2", weight: "400", style: "normal" },
    { path: "../../fonts/Inter-SemiBold.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-inter",
  display: "swap",
});

export const spaceMono = localFont({
  src: [
    { path: "../../fonts/SpaceMono-Regular.woff2", weight: "400", style: "normal" },
    { path: "../../fonts/SpaceMono-Bold.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-space-mono",
  display: "swap",
});

export const bigShoulders = localFont({
  src: [
    { path: "../../fonts/BigShouldersDisplay-Bold.woff2", weight: "700", style: "normal" },
    { path: "../../fonts/BigShouldersDisplay-ExtraBold.woff2", weight: "800", style: "normal" },
  ],
  variable: "--font-big-shoulders",
  display: "swap",
});
