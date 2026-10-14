import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { findAttributionViolations, type CommitMessage } from "@/ci/attribution";

// Runs in CI on pull requests with ATTRIBUTION_RANGE=<base sha>..<head sha>.
// Skipped locally unless the variable is set.
const range = process.env.ATTRIBUTION_RANGE;

const RECORD = "\x1e";
const FIELD = "\x1f";

function readCommits(gitRange: string): CommitMessage[] {
  const output = execFileSync("git", ["log", `--format=%H${FIELD}%B${RECORD}`, gitRange], {
    encoding: "utf8",
  });
  return output
    .split(RECORD)
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha, message = ""] = record.split(FIELD);
      return { sha: sha ?? "", message };
    });
}

describe.skipIf(!range)("No AI attribution trailers", () => {
  it("no commit in ATTRIBUTION_RANGE carries AI attribution", () => {
    const violations = findAttributionViolations(readCommits(range ?? ""));
    expect(violations).toEqual([]);
  });
});
