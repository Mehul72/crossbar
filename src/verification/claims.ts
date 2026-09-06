import type { Claim, ToolActivity, Usage } from "../shared/domain";
export function verifyClaims(text: string, tools: ToolActivity[]): Claim[] {
  const checks = [
    {
      pattern:
        /\b(?:tests? (?:pass(?:ed|es)?|succeed(?:ed)?)|all tests (?:are )?passing)\b/gi,
      command:
        /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:pytest|go test|cargo test)\b/,
    },
    {
      pattern:
        /\b(?:typecheck(?:ing)?|type check)(?:\s+)(?:pass(?:ed|es)?|succeed(?:ed)?|clean)\b/gi,
      command: /\b(?:typecheck|tsc)\b/,
    },
    {
      pattern: /\blint(?:ing)?\s+(?:pass(?:ed|es)?|succeed(?:ed)?|clean)\b/gi,
      command: /\b(?:lint|eslint|ruff check)\b/,
    },
  ];
  return checks.flatMap((check) =>
    [...text.matchAll(check.pattern)].map((match) => {
      const evidence = tools
        .filter(
          (tool) =>
            tool.command &&
            check.command.test(tool.command) &&
            tool.exitCode !== undefined,
        )
        .at(-1);
      return {
        claim: match[0],
        status: evidence
          ? evidence.exitCode === 0
            ? ("verified" as const)
            : ("conflicting" as const)
          : ("unverified" as const),
        evidence: evidence
          ? `${evidence.command} exited ${evidence.exitCode}. Evidence applies to this command run, not all code correctness.\n${evidence.output ?? ""}`
          : "No matching command exit status was provided in this response. Model agreement is not proof.",
      };
    }),
  );
}
export function usageLabel(usage: Usage | undefined, now = Date.now()): string {
  if (!usage) return "Usage unavailable";
  const stale = now - usage.observedAt > 300_000 ? " · stale" : "";
  if (usage.quota?.length)
    return `${usage.quota[0]!.remaining.toFixed(0)}% remaining${stale}`;
  if (usage.context)
    return `${Math.round((usage.context.used / usage.context.limit) * 100)}% context${stale}`;
  if (usage.tokens)
    return `${usage.tokens.input + usage.tokens.output} tokens reported${stale}`;
  return `Usage unavailable${stale}`;
}
export function resetLabel(timestamp?: number, now = Date.now()): string {
  if (!timestamp) return "Reset time unavailable";
  return timestamp <= now
    ? "Reset time passed; refresh usage"
    : `Resets ${new Date(timestamp).toLocaleString()}`;
}
