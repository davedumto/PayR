import { describe, expect, it } from "vitest";

import { isStellarAddress, strKeyKind } from "@/proxy/strkey";

// Vectors generated with @stellar/stellar-base 15.0.0 (the reference SDK), not
// with this module, so the checksum logic is cross-checked against it.
const VALID_G = [
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57",
];
const VALID_C = ["CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4"];

describe("strKeyKind", () => {
  it.each(VALID_G)("accepts the account address %s", (value) => {
    expect(strKeyKind(value)).toBe("G");
  });

  it.each(VALID_C)("accepts the contract address %s", (value) => {
    expect(strKeyKind(value)).toBe("C");
  });

  const invalid: readonly { name: string; value: string }[] = [
    { name: "empty string", value: "" },
    { name: "one character short", value: VALID_G[0]!.slice(0, 55) },
    { name: "one character long", value: `${VALID_G[0]!}A` },
    {
      name: "checksum altered at the end",
      value: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHE",
    },
    {
      name: "checksum altered in the middle",
      value: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    },
    { name: "lowercase letters", value: VALID_G[0]!.toLowerCase() },
    { name: "padding character", value: `${VALID_G[0]!.slice(0, 55)}=` },
    { name: "character outside base32 (0, 1, 8, 9)", value: `G0${VALID_G[0]!.slice(2)}` },
    { name: "secret seed (S) prefix", value: `S${VALID_G[0]!.slice(1)}` },
    { name: "muxed account (M) prefix", value: `M${VALID_G[0]!.slice(1)}` },
    { name: "G-prefix with C checksum", value: `G${VALID_C[0]!.slice(1)}` },
    { name: "leading and trailing whitespace", value: ` ${VALID_G[0]!} ` },
    { name: "embedded newline", value: `${VALID_G[0]!.slice(0, 28)}\n${VALID_G[0]!.slice(29)}` },
    {
      name: "URL-looking input",
      value: "https://example.test/GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    },
    {
      name: "unicode look-alike letter",
      value: `${VALID_G[0]!.slice(0, 10)}Ａ${VALID_G[0]!.slice(11)}`,
    },
  ];

  it.each(invalid)("rejects $name", ({ value }) => {
    expect(strKeyKind(value)).toBeUndefined();
    expect(isStellarAddress(value)).toBe(false);
  });
});
