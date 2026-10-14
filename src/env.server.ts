import "server-only";

import { z } from "zod";

import { edgeSchema, type EdgeEnv, type RawEnv, validateEnv } from "@/env.edge";

/**
 * Server-only environment: secrets and server configuration, on top of the Edge
 * set. Importing this module from client code is a build error (server-only).
 */

const serverOnlySchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, { message: "must not be empty" }),
  VELLAR_BOOTSTRAP_AGENT_KEY: z.string().min(1, { message: "must not be empty" }),
  ANTHROPIC_MODEL: z.string().min(1, { message: "must not be empty" }),
});

export const serverSchema = edgeSchema.extend(serverOnlySchema.shape);

export type ServerEnv = EdgeEnv & z.output<typeof serverOnlySchema>;

export function parseServerEnv(raw: RawEnv): ServerEnv {
  return validateEnv(serverSchema, raw);
}

let cachedServer: ServerEnv | undefined;

/**
 * Validates the full server environment once. Called from instrumentation.ts so
 * the process refuses to start on any missing or malformed value.
 */
export function getServerEnv(): ServerEnv {
  if (!cachedServer) {
    cachedServer = parseServerEnv({
      VELLAR_FACILITATOR_URL: process.env.VELLAR_FACILITATOR_URL,
      KV_REST_API_URL: process.env.KV_REST_API_URL,
      KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
      NEXT_PUBLIC_VELLAR_NETWORK: process.env.NEXT_PUBLIC_VELLAR_NETWORK,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      VELLAR_BOOTSTRAP_AGENT_KEY: process.env.VELLAR_BOOTSTRAP_AGENT_KEY,
      ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    });
  }
  return cachedServer;
}
