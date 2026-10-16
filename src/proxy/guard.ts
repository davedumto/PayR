/**
 * Deterministic request guard. It runs before any payment logic and before any
 * upstream call. It is not a scanner and makes no judgement about content. Each
 * rule is a fixed check that fails closed.
 *
 * Header rule: forwarding is allowlist-only. Every header not listed in
 * GUARD_HEADER_ALLOWLIST is dropped, including credentials and anything a buyer
 * could use to reach the seller's origin.
 */

export const GUARD_URL_MAX_LENGTH = 2048;
export const GUARD_JSON_MAX_DEPTH = 20;
export const GUARD_JSON_MAX_KEYS = 1000;
export const GUARD_HEADER_ALLOWLIST: readonly string[] = [
  "accept",
  "accept-language",
  "content-type",
  "user-agent",
  "x-request-id",
];
export const DEFAULT_ALLOWED_CONTENT_TYPES: readonly string[] = [
  "application/json",
  "text/plain",
  "application/x-www-form-urlencoded",
];

export type GuardConfig = {
  readonly allowedMethods: readonly string[];
  readonly maxRequestBytes: number;
  readonly allowedContentTypes: readonly string[];
};

export type GuardInput = {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly config: GuardConfig;
};

export type GuardResult =
  | { readonly ok: true; readonly headers: Record<string, string> }
  | { readonly ok: false; readonly status: 400 | 405 | 413 | 414 | 415; readonly reason: string };

const fail = (status: 400 | 405 | 413 | 414 | 415, reason: string): GuardResult => ({
  ok: false,
  status,
  reason,
});
const NUL = "\u0000";

function mediaTypeOf(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

function charsetOf(contentType: string): string | undefined {
  const match = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType);
  return match?.[1]?.toLowerCase();
}

/**
 * Checks depth and key count in one iterative pass, so a pathological value
 * cannot exhaust the stack. Returns a reason string, or undefined if within limits.
 */
export function jsonShapeProblem(value: unknown): string | undefined {
  let keys = 0;
  const stack: { node: unknown; depth: number }[] = [{ node: value, depth: 1 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (node !== null && typeof node === "object") {
      if (depth > GUARD_JSON_MAX_DEPTH) return "json-too-deep";
      const children = Array.isArray(node) ? node : Object.values(node);
      if (!Array.isArray(node)) {
        keys += Object.keys(node).length;
        if (keys > GUARD_JSON_MAX_KEYS) return "json-too-many-keys";
      }
      for (const child of children) {
        stack.push({ node: child, depth: depth + 1 });
      }
    }
  }
  return undefined;
}

export function runGuard(input: GuardInput): GuardResult {
  const { method, path, headers, body, config } = input;

  if (!config.allowedMethods.includes(method)) return fail(405, "method-not-allowed");
  if (path.length > GUARD_URL_MAX_LENGTH) return fail(414, "url-too-long");
  if (body.byteLength > config.maxRequestBytes) return fail(413, "body-too-large");
  if (path.includes(NUL)) return fail(400, "nul-in-path");
  if (body.includes(0)) return fail(400, "nul-in-body");

  const allowedTypes = config.allowedContentTypes.map((type) => type.toLowerCase());
  const contentType = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === "content-type",
  )?.[1];
  if (contentType !== undefined) {
    if (contentType.includes(NUL)) return fail(400, "nul-in-header");
    const mediaType = mediaTypeOf(contentType);
    if (!allowedTypes.includes(mediaType)) return fail(415, "content-type-not-allowed");
    const charset = charsetOf(contentType);
    if (charset !== undefined && charset !== "utf-8" && charset !== "us-ascii") {
      return fail(415, "charset-not-allowed");
    }
  } else if (body.byteLength > 0) {
    return fail(415, "content-type-required");
  }

  for (const [name, value] of Object.entries(headers)) {
    if (name.includes(NUL) || value.includes(NUL)) return fail(400, "nul-in-header");
  }

  if (
    contentType !== undefined &&
    mediaTypeOf(contentType) === "application/json" &&
    body.byteLength > 0
  ) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      return fail(400, "invalid-json");
    }
    const problem = jsonShapeProblem(parsed);
    if (problem !== undefined) return fail(400, problem);
  }

  const allowed: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (GUARD_HEADER_ALLOWLIST.includes(key)) {
      allowed[key] = value;
    }
  }
  return { ok: true, headers: allowed };
}
