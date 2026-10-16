import { z } from "zod";

import { isStellarAddress, strKeyKind } from "@/proxy/strkey";
import { validateTargetUrl } from "@/proxy/ssrf";

/**
 * Seller proxy config, validated on every write and every read. Seller input is
 * untrusted. Unknown keys are rejected so a config cannot smuggle a field.
 */

export const PROXY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,62}$/;

/** Upper bound on one request's price: 100,000,000.0000000 units at 7 decimals. */
export const MAX_PRICE_BASE_UNITS = 10n ** 15n;

export const USDC_DECIMALS = 7;

/** Timeout maxima in milliseconds. The request budget (ADR 0001) is derived from these. */
export const TIMEOUT_LIMITS = { verifyMs: 15_000, upstreamMs: 30_000, settleMs: 60_000 } as const;

/** Worst case for one paid request: verify + upstream + settle. The serving function needs at least this, plus margin. */
export function worstCaseBudgetMs(): number {
  return TIMEOUT_LIMITS.verifyMs + TIMEOUT_LIMITS.upstreamMs + TIMEOUT_LIMITS.settleMs;
}

/** Methods that can change the seller's upstream state. */
const SIDE_EFFECT_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const DECIMAL_PATTERN = /^(0|[1-9]\d*)(?:\.(\d{1,7}))?$/;

/**
 * Converts a decimal string such as "0.05" into base units (bigint) using string
 * arithmetic only. Rejects numbers, floats, exponents, signs, separators, more
 * than `decimals` fractional digits, and anything else that is not a plain
 * decimal. Throws TypeError or RangeError.
 */
export function parseDecimalToBaseUnits(input: unknown, decimals: number = USDC_DECIMALS): bigint {
  if (typeof input !== "string") {
    throw new TypeError("amount must be a decimal string, not a number");
  }
  const match = DECIMAL_PATTERN.exec(input);
  if (!match) {
    throw new RangeError("amount must be a plain decimal with no sign, exponent or separators");
  }
  const whole = match[1]!;
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    throw new RangeError(`amount has more than ${decimals} decimal places`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0"));
}

const payToSchema = z.string().refine((value) => isStellarAddress(value), {
  message: "must be a valid Stellar G or C address",
});

const contractSchema = z.string().refine((value) => strKeyKind(value) === "C", {
  message: "must be a valid Stellar contract (C) address",
});

export const ProxyConfigSchema = z
  .object({
    version: z.number().int().min(1),
    id: z.string().regex(PROXY_ID_PATTERN, {
      message: "must be 3 to 63 characters of lowercase letters, digits and hyphens",
    }),
    status: z.enum(["active", "paused"]),
    targetUrl: z
      .string()
      .max(2048)
      .superRefine((value, ctx) => {
        const check = validateTargetUrl(value);
        if (!check.ok) {
          ctx.addIssue({ code: "custom", message: `target URL rejected: ${check.reason}` });
        }
      }),
    priceBaseUnits: z.string().refine(
      // The regex runs first and short-circuits, so BigInt only sees digit strings.
      (value) => /^[1-9]\d*$/.test(value) && BigInt(value) <= MAX_PRICE_BASE_UNITS,
      { message: "must be digits only, greater than zero, and within the maximum price" },
    ),
    asset: contractSchema,
    payTo: payToSchema,
    network: z.enum(["stellar:testnet", "stellar:pubnet"]),
    description: z.string().regex(/^[\x20-\x7e]{1,256}$/, {
      message: "must be 1 to 256 printable ASCII characters",
    }),
    // Read-only by default. Methods that can change the seller's upstream state need an explicit acknowledgement.
    allowedMethods: z
      .array(z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]))
      .min(1)
      .default(["GET", "HEAD"]),
    sideEffectsAcknowledged: z.boolean().default(false),
    // How the proxy proves to the seller's origin that a call came through it (B7). "none" adds nothing.
    originAuth: z
      .object({
        mode: z.enum(["none", "secret_header"]).default("none"),
        headerName: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]{0,63}$/i, { message: "must be a header token" })
          .default("x-payr-origin-key"),
      })
      .strict()
      .default({ mode: "none", headerName: "x-payr-origin-key" }),
    // Records who accepted running on pubnet without origin authentication (B7). Required for that combination.
    lockdownWaiver: z
      .object({
        acceptedAt: z.string().datetime(),
        acceptedBy: z.string().min(1).max(128),
      })
      .strict()
      .optional(),
    maxRequestBytes: z.number().int().min(0).max(1_048_576).default(65_536),
    // Content types the guard accepts in a request body. Parameters such as charset are ignored when matching.
    allowedContentTypes: z
      .array(z.string().regex(/^[a-z]+\/[a-z0-9.+-]+$/i, { message: "must be a type/subtype" }))
      .min(1)
      .max(10)
      .default(["application/json", "text/plain", "application/x-www-form-urlencoded"]),
    maxResponseBytes: z.number().int().min(1).max(5_242_880).default(1_048_576),
    upstreamTimeoutMs: z.number().int().min(1).max(TIMEOUT_LIMITS.upstreamMs).default(10_000),
    // verify is quick; the facilitator answers verify without retries.
    verifyTimeoutMs: z.number().int().min(1).max(TIMEOUT_LIMITS.verifyMs).default(5_000),
    // settle can take up to 2 facilitator retries of 6 s each before it answers.
    settleTimeoutMs: z.number().int().min(1).max(TIMEOUT_LIMITS.settleMs).default(45_000),
  })
  .strict()
  .superRefine((value, ctx) => {
    const sideEffecting = value.allowedMethods.some((method) => SIDE_EFFECT_METHODS.has(method));
    if (
      value.network === "stellar:pubnet" &&
      value.originAuth.mode === "none" &&
      !value.lockdownWaiver
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["originAuth", "mode"],
        message: "stellar:pubnet needs originAuth.mode other than none, or a lockdownWaiver",
      });
    }
    if (sideEffecting && !value.sideEffectsAcknowledged) {
      ctx.addIssue({
        code: "custom",
        path: ["sideEffectsAcknowledged"],
        message: "must be true when POST, PUT, PATCH or DELETE is allowed",
      });
    }
  });

export type ProxyConfig = z.output<typeof ProxyConfigSchema>;

export type ConfigParseResult =
  | { readonly ok: true; readonly config: ProxyConfig }
  | { readonly ok: false; readonly issues: readonly string[] };

/** Parses untrusted input (for example a KV value). Never throws. */
export function parseProxyConfig(input: unknown): ConfigParseResult {
  const result = ProxyConfigSchema.safeParse(input);
  if (result.success) {
    return { ok: true, config: result.data };
  }
  return {
    ok: false,
    issues: result.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    ),
  };
}
