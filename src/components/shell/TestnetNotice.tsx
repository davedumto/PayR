import { Badge } from "@/components/ui/Badge";

type Props = { network: "testnet" | "mainnet" };

/**
 * Persistent network notice across the whole shell. Testnet gets the subtle
 * crimson tint; mainnet gets a neutral notice so it is never mistaken for test use.
 */
export function NetworkNotice({ network }: Props) {
  if (network === "testnet") {
    return (
      <div
        role="status"
        className="border-b border-risk-crimson/40 bg-[color-mix(in_srgb,var(--color-risk-crimson)_12%,transparent)] px-4 py-2 text-sm text-risk-crimson-tint md:px-8"
      >
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Badge variant="crimson">Testnet</Badge>
          <span>Payments use Stellar testnet funds. Nothing here moves real money.</span>
        </span>
      </div>
    );
  }
  return (
    <div
      role="status"
      className="border-b border-cement-grey px-4 py-2 text-sm text-cyber-tin md:px-8"
    >
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge variant="warning">Mainnet</Badge>
        <span>Payments settle on Stellar mainnet with real funds.</span>
      </span>
    </div>
  );
}
