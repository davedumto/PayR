import { z } from "zod";

/**
 * Environment variables that the Edge runtime may read.
 *
 * This file must never reference a server-only secret. A test in
 * env.edge.test.ts reads this file's source and fails if one appears. Server
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

export const edgeSchema = publicSchema.extend({
  VELLAR_FACILITATOR_URL: z.url({ message: "must be an absolute URL" }),
  KV_REST_API_URL: z.url({ message: "must be an absolute URL" }),
  KV_REST_API_TOKEN: z.string().min(1, { message: "must not be empty" }),
});

export type EdgeEnv = z.output<typeof edgeSchema>;
export type PublicNetwork = EdgeEnv["NEXT_PUBLIC_VELLAR_NETWORK"];

export function parseEdgeEnv(raw: RawEnv): EdgeEnv {
  return validateEnv(edgeSchema, raw);
}

let cachedEdge: EdgeEnv | undefined;

/**
 * Reads the Edge variables once and caches the result. Property access is
 * written out literally so Next.js can inline the NEXT_PUBLIC_ value.
 */
export function getEdgeEnv(): EdgeEnv {
  if (!cachedEdge) {
    cachedEdge = parseEdgeEnv({
      VELLAR_FACILITATOR_URL: process.env.VELLAR_FACILITATOR_URL,
      KV_REST_API_URL: process.env.KV_REST_API_URL,
      KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
      NEXT_PUBLIC_VELLAR_NETWORK: process.env.NEXT_PUBLIC_VELLAR_NETWORK,
    });
  }
  return cachedEdge;
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
