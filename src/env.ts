import "server-only";

import { z } from "zod";

/**
 * Environment contract for PayR.
 *
 * Server-only variables must never carry the NEXT_PUBLIC_ prefix: Next.js
 * inlines every NEXT_PUBLIC_ variable into the client bundle. The public
 * schema below is the only place a NEXT_PUBLIC_ name is allowed.
 *
 * Validation is lazy: importing this module has no side effects, so unit
 * tests can exercise `parseEnv` directly. `getEnv()` is called from
 * instrumentation.ts so the process refuses to start on a bad config.
 */

const serverSchema = z.object({
  VELLAR_FACILITATOR_URL: z.url({ message: "must be an absolute URL" }),
  ANTHROPIC_API_KEY: z.string().min(1, { message: "must not be empty" }),
  KV_REST_API_URL: z.url({ message: "must be an absolute URL" }),
  KV_REST_API_TOKEN: z.string().min(1, { message: "must not be empty" }),
  VELLAR_BOOTSTRAP_AGENT_KEY: z.string().min(1, { message: "must not be empty" }),
  ANTHROPIC_MODEL: z.string().min(1, { message: "must not be empty" }),
});

const publicSchema = z.object({
  NEXT_PUBLIC_VELLAR_NETWORK: z.enum(["testnet", "mainnet"], {
    message: "must be exactly 'testnet' or 'mainnet'",
  }),
});

export const serverEnvKeys = Object.keys(serverSchema.shape) as readonly (keyof z.infer<
  typeof serverSchema
>)[];
export const publicEnvKeys = Object.keys(publicSchema.shape) as readonly (keyof z.infer<
  typeof publicSchema
>)[];

export type ServerEnv = z.infer<typeof serverSchema>;
export type PublicEnv = z.infer<typeof publicSchema>;
export type Env = ServerEnv & PublicEnv;
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
 * Validates a raw environment record. Never echoes a value back in the error
 * message, so secrets cannot leak through logs.
 */
export function parseEnv(raw: RawEnv): Env {
  const problems: string[] = [];

  for (const key of [...serverEnvKeys, ...publicEnvKeys]) {
    if (raw[key] === undefined || raw[key] === "") {
      problems.push(`${key} is missing`);
    }
  }
  if (problems.length > 0) {
    throw new EnvValidationError(problems);
  }

  const server = serverSchema.safeParse(raw);
  const pub = publicSchema.safeParse(raw);
  const issues = [
    ...(server.success ? [] : server.error.issues),
    ...(pub.success ? [] : pub.error.issues),
  ].map((issue) => `${String(issue.path[0])} ${issue.message}`);

  if (!server.success || !pub.success) {
    throw new EnvValidationError(issues);
  }

  return { ...server.data, ...pub.data };
}

let cached: Env | undefined;

/**
 * Reads the process environment once and caches the validated result.
 * Property access is written out literally so Next.js can inline the
 * NEXT_PUBLIC_ value where it is needed.
 */
export function getEnv(): Env {
  if (cached) {
    return cached;
  }
  cached = parseEnv({
    VELLAR_FACILITATOR_URL: process.env.VELLAR_FACILITATOR_URL,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    KV_REST_API_URL: process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
    VELLAR_BOOTSTRAP_AGENT_KEY: process.env.VELLAR_BOOTSTRAP_AGENT_KEY,
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    NEXT_PUBLIC_VELLAR_NETWORK: process.env.NEXT_PUBLIC_VELLAR_NETWORK,
  });
  return cached;
}
