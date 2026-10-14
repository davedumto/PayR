import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  findAttributionViolations,
  findIdentityViolations,
  type CommitIdentity,
  type CommitMessage,
} from "@/ci/attribution";

// Runs in CI on pull requests with ATTRIBUTION_RANGE=<base sha>..<head sha>.
// Skipped locally unless the variable is set.
const range = process.env.ATTRIBUTION_RANGE;

const RECORD = "\x1e";
const FIELD = "\x1f";

type CommitRecord = CommitMessage & CommitIdentity;

function readCommits(gitRange: string): CommitRecord[] {
  const output = execFileSync(
    "git",
    ["log", `--format=%H${FIELD}%ae${FIELD}%ce${FIELD}%B${RECORD}`, gitRange],
    { encoding: "utf8" },
  );
  return output
    .split(RECORD)
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha = "", authorEmail = "", committerEmail = "", ...body] = record.split(FIELD);
      return { sha, authorEmail, committerEmail, message: body.join(FIELD) };
    });
}

describe.skipIf(!range)("No AI attribution in commits", () => {
  const commits = range ? readCommits(range) : [];

  it("no commit in ATTRIBUTION_RANGE carries an AI attribution trailer", () => {
    expect(findAttributionViolations(commits)).toEqual([]);
  });

  it("no commit in ATTRIBUTION_RANGE has an Anthropic author or committer", () => {
    expect(findIdentityViolations(commits)).toEqual([]);
  });
});
