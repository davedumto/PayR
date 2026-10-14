/**
 * Detects AI attribution in commit messages. Used by the "No AI attribution
 * trailers" CI step. Product text that mentions Claude (for example "Claude
 * calls") is not attribution and must not match.
 */

export type CommitMessage = { readonly sha: string; readonly message: string };

export type Violation = { readonly sha: string; readonly line: string; readonly reason: string };

const RULES: readonly { readonly reason: string; readonly pattern: RegExp }[] = [
  {
    reason: "Co-Authored-By trailer naming Claude or Anthropic",
    pattern: /^\s*Co-Authored-By:.*\b(claude|anthropic)\b/i,
  },
  { reason: "Claude-Session trailer", pattern: /^\s*Claude-Session:/i },
  {
    reason: "Claude Code generation footer",
    pattern: /Generated (with|by) \[?Claude Code/i,
  },
];

export function findAttributionViolations(commits: readonly CommitMessage[]): Violation[] {
  const violations: Violation[] = [];
  for (const commit of commits) {
    for (const line of commit.message.split("\n")) {
      for (const rule of RULES) {
        if (rule.pattern.test(line)) {
          violations.push({ sha: commit.sha, line: line.trim(), reason: rule.reason });
        }
      }
    }
  }
  return violations;
}

export type CommitIdentity = {
  readonly sha: string;
  readonly authorEmail: string;
  readonly committerEmail: string;
};

export type IdentityViolation = {
  readonly sha: string;
  readonly role: "author" | "committer";
  readonly email: string;
};

/** True for noreply@anthropic.com and any address at the anthropic.com domain. */
export function isAnthropicEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  return normalized === "noreply@anthropic.com" || normalized.endsWith("@anthropic.com");
}

/**
 * Message-only checks miss identity: a commit can be authored as Claude with a
 * clean message. This catches the author and committer identities too.
 */
export function findIdentityViolations(commits: readonly CommitIdentity[]): IdentityViolation[] {
  const violations: IdentityViolation[] = [];
  for (const commit of commits) {
    if (isAnthropicEmail(commit.authorEmail)) {
      violations.push({ sha: commit.sha, role: "author", email: commit.authorEmail });
    }
    if (isAnthropicEmail(commit.committerEmail)) {
      violations.push({ sha: commit.sha, role: "committer", email: commit.committerEmail });
    }
  }
  return violations;
}
