import { z } from "zod";

/**
 * Environment variables the proxy request handler may read.
 *
 * This file must never reference a server-only secret. A test in
 * env.proxy.test.ts reads this file's source and fails if one appears. Server
 * secrets belong in env.server.ts.
 */

export type RawEnv = Record<string, string | undefined>;

export class EnvValidationError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      [
        "Invalid environment configuration:",
        ...problems.map((p) => `  - ${p}`),
        "Set these in .env.local (see .env.example) and restart.",
      ].join("\n"),
    );
    this.name = "EnvValidationError";
    this.problems = problems;
  }
}

/**
 * Checks that every key in the schema is present and well formed. Reports all
 * problems at once. Error messages name the variable but never echo its value,
 * so secrets cannot leak through logs.
 */
export function validateEnv<S extends z.ZodObject>(schema: S, raw: RawEnv): z.output<S> {
  const problems: string[] = [];
  for (const key of Object.keys(schema.shape)) {
    if (raw[key] === undefined || raw[key] === "") {
      problems.push(`${key} is missing`);
    }
  }
  if (problems.length > 0) {
    throw new EnvValidationError(problems);
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${String(issue.path[0])} ${issue.message}`),
    );
  }
  return result.data as z.output<S>;
}

export const publicSchema = z.object({
  NEXT_PUBLIC_VELLAR_NETWORK: z.enum(["testnet", "mainnet"], {
    message: "must be exactly 'testnet' or 'mainnet'",
  }),
});

const parseUrl = (value: string): URL | undefined => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

/**
 * An absolute URL that is https, or http to localhost in tests only. Anything
 * that carries a credential or a facilitator request must not travel over
 * plain http.
 */
/**
 * True for an absolute https URL, or for http to localhost in tests only. Anything
 * that carries a credential or a facilitator request must not travel over plain http.
 */
export function isSecureServiceUrl(value: string): boolean {
  const url = parseUrl(value);
  if (!url) {
    return false;
  }
  const isLocalTestHost =
    process.env.NODE_ENV === "test" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  return url.protocol === "https:" || (url.protocol === "http:" && isLocalTestHost);
}

const secureUrl = (message: string) => z.string().refine(isSecureServiceUrl, { message });

export const proxySchema = publicSchema.extend({
  VELLAR_FACILITATOR_URL: secureUrl(
    "must be an absolute https URL (http is allowed for localhost in tests only)",
  ),
  // CONFIG: seller configs. The proxy only reads them, so its token is read-only.
  KV_CONFIG_REST_API_URL: secureUrl("must be an absolute https URL"),
  KV_CONFIG_READ_ONLY_TOKEN: z.string().min(1, { message: "must not be empty" }),
  // STATE: locks and rate counters. The proxy writes these, so its token is read-write.
  KV_STATE_REST_API_URL: secureUrl("must be an absolute https URL"),
  KV_STATE_REST_API_TOKEN: z.string().min(1, { message: "must not be empty" }),
});

export type ProxyEnv = z.output<typeof proxySchema>;
export type PublicNetwork = ProxyEnv["NEXT_PUBLIC_VELLAR_NETWORK"];

export function parseProxyEnv(raw: RawEnv): ProxyEnv {
  return validateEnv(proxySchema, raw);
}

let cachedProxy: ProxyEnv | undefined;

/**
 * Reads the proxy variables once and caches the result. Property access is
 * written out literally so Next.js can inline the NEXT_PUBLIC_ value.
 */
export function getProxyEnv(): ProxyEnv {
  if (!cachedProxy) {
    cachedProxy = parseProxyEnv({
      VELLAR_FACILITATOR_URL: process.env.VELLAR_FACILITATOR_URL,
      KV_CONFIG_REST_API_URL: process.env.KV_CONFIG_REST_API_URL,
      KV_CONFIG_READ_ONLY_TOKEN: process.env.KV_CONFIG_READ_ONLY_TOKEN,
      KV_STATE_REST_API_URL: process.env.KV_STATE_REST_API_URL,
      KV_STATE_REST_API_TOKEN: process.env.KV_STATE_REST_API_TOKEN,
      NEXT_PUBLIC_VELLAR_NETWORK: process.env.NEXT_PUBLIC_VELLAR_NETWORK,
    });
  }
  return cachedProxy;
}

/**
 * The only value the dashboard needs. Validates just the public network, so a
 * page that renders the notice does not depend on any other variable.
 */
export function getPublicNetwork(): PublicNetwork {
  return validateEnv(publicSchema, {
    NEXT_PUBLIC_VELLAR_NETWORK: process.env.NEXT_PUBLIC_VELLAR_NETWORK,
  }).NEXT_PUBLIC_VELLAR_NETWORK;
}
