import { createHash } from "node:crypto";

/**
 * Stable JSON for hashing. Object keys are sorted at every depth, so two
 * encodings of the same value produce the same string. Array order is kept.
 * Depth is capped, so a deeply nested value cannot exhaust the stack.
 */

export const CANONICAL_MAX_DEPTH = 64;

function encode(value: unknown, depth: number): string {
  if (depth > CANONICAL_MAX_DEPTH) {
    throw new RangeError(`value nested deeper than ${CANONICAL_MAX_DEPTH}`);
  }
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new TypeError("value is not JSON-serialisable");
    }
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => encode(item, depth + 1)).join(",")}]`;
  }
  const entries = Object.keys(value)
    .sort()
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map(
      (key) =>
        `${JSON.stringify(key)}:${encode((value as Record<string, unknown>)[key], depth + 1)}`,
    );
  return `{${entries.join(",")}}`;
}

/** Canonical JSON text for a JSON-compatible value. Throws RangeError or TypeError. */
export function canonicalJson(value: unknown): string {
  return encode(value, 0);
}

/** Lowercase hex SHA-256 of the canonical JSON of a value. */
export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
