# Crossbar extension

Status: complete

## Goal and decisions

Build a desktop VS Code chat extension with canonical local conversations, managed Codex App Server and Claude Agent SDK adapters, incremental streaming, context handoff, compare, capsules, approvals, and honest evidence and usage displays. Use TypeScript, React, esbuild, atomic per-conversation storage, strict webview validation and Workspace Trust.

Codex uses its official ChatGPT login. Claude uses the official Agent SDK with the local Claude Code executable and existing subscription authentication. The current Help Center confirms subscription usage for SDK and third-party apps despite conflicting SDK overview text. Block API keys, alternate billing environments and non-subscription authentication; never silently fall back to API billing. No scraping, private endpoints, telemetry, automatic dependency installation, remote configuration, or publishing. Real account calls require interactive validation; automated tests use fake runtimes.

## Steps

- [x] 1. Scaffold build, packaging, domain types and secure transport. Verify typecheck/build and framing tests.
- [x] 2. Implement provider adapters against official protocol and SDK. Verify lifecycle, errors, cancellation and event mapping with fake processes.
- [x] 3. Implement persistence, synchronization, compare, capsules and evidence. Verify domain and disk tests.
- [x] 4. Implement VS Code host and accessible chat UI. Verify typed boundary, attachment containment, UI interactions and dark/light layouts.
- [x] 5. Document setup and limitations, run all checks, package and commit locally. Verify package contents and Git history.

## Open validation

- Claude account turn verified end to end against the live subscription: streaming text and a returned session id.
- Codex account status, model list and quota verified live. Its streaming turn is blocked by the account usage limit that resets at 15:49 on 2026-09-06 and is unverified since.
- Marketplace reservation cannot be proven without a publisher account. Local package identifier is crossbar; no publisher claimed or registration performed.

## Log

- Repository initially contained only a README. Source requirements preserved outside repository and were never tracked.
- Protocol types generated with installed Codex CLI 0.153.0 for implementation reference.
- Codex is not on PATH on this machine; the CLI bundled in the ChatGPT VS Code extension supplies it. Both verification scripts and the extension take an explicit executable path.
- The VS Code check raced extension registration and typed into an unindexed command palette. It now reopens the palette until the command is listed, and asserts each provider card reports a runtime state rather than a machine-specific connected string.
- Both providers discarded the runtime's own failure reason. They now surface it, redacted and truncated, so a usage limit is distinguishable from a fault.
- @types/vscode pinned to 1.95.0 to match engines.vscode, which vsce requires and which keeps newer API use a compile error.
