import type { Claim, QuotaWindow, ToolActivity, Usage } from "../shared/domain";
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
  const window = tightestWindow(usage.quota);
  if (window) {
    if (window.state === "exhausted")
      return `Limit reached · ${resetLabel(window.resetsAt, now).toLowerCase()}${stale}`;
    if (window.remaining !== undefined)
      return `${window.remaining.toFixed(0)}% remaining${stale}`;
    return `Percentage unavailable${stale}`;
  }
  if (usage.context)
    return `${Math.round((usage.context.used / usage.context.limit) * 100)}% context${stale}`;
  if (usage.tokens)
    return `${usage.tokens.input + usage.tokens.output} tokens reported${stale}`;
  return `Usage unavailable${stale}`;
}
// The window that stops work first is the one worth showing, so exhaustion outranks
// a low percentage and an unknown percentage never displaces a known one.
export function tightestWindow(
  quota: QuotaWindow[] | undefined,
): QuotaWindow | undefined {
  const rank = (window: QuotaWindow) =>
    window.state === "exhausted"
      ? 0
      : window.state === "warning"
        ? 1
        : window.remaining !== undefined
          ? 2
          : 3;
  return [...(quota ?? [])].sort(
    (first, second) =>
      rank(first) - rank(second) ||
      (first.remaining ?? 100) - (second.remaining ?? 100),
  )[0];
}
export function windowLabel(window: QuotaWindow): string {
  const state =
    window.remaining !== undefined
      ? `${window.remaining.toFixed(0)}% remaining${window.state === "exhausted" ? " (limit reached)" : ""}`
      : window.state === "exhausted"
        ? "limit reached"
        : "percentage unavailable";
  return `${window.name}: ${state}`;
}
export function resetLabel(timestamp?: number, now = Date.now()): string {
  if (!timestamp) return "Reset time unavailable";
  if (timestamp <= now) return "Reset time passed; refresh usage";
  const remainingMs = timestamp - now;
  if (remainingMs < 60_000) return "Resets in under a minute";
  const minutes = Math.round(remainingMs / 60_000);
  const clock = new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (minutes < 60) return `Resets in ${minutes} min (${clock})`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Resets in ${hours}h ${minutes % 60}m (${clock})`;
  const days = Math.round(hours / 24);
  return `Resets in ${days} day${days === 1 ? "" : "s"} (${new Date(timestamp).toLocaleDateString()})`;
}
