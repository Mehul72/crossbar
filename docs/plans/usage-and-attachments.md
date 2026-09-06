# Plan: usage updates and chat attachments

Status: done

## Goal

Show Claude's numeric 5-hour and weekly remaining usage and reset times without manual refresh. Attach dropped text files and editor selections to the next chat message.

## Decisions

Prefer the official Claude Code extension runtime for the default executable, retaining explicit configured paths. Use the installed Claude SDK's structured usage control request with no prompt, bounded waits, and cached refreshes. Preserve subscription authentication. Reuse attachment limits and workspace validation for URI drops; browser file drops carry explicitly supplied text bytes.

## Steps

- [x] Fix usage retrieval and publish streaming usage updates. Verify with provider and engine regressions.
- [x] Add automatic refresh, file drops, and editor context-menu action. Verify message validation and browser interaction.
- [x] Run tests, typecheck, lint, build, and available UI checks; update documentation.

## Scope

No publishing or commits. Existing uncommitted changes are retained.

## Findings

- Rate-limit events only update ClaudeProvider's private cache; engine statuses do not receive them.
- Installed SDK exposes structured percentage utilization for both required windows; current code only reads rate-limit status events.

- Provider regressions reproduced both missing numeric usage and absent stream events before the fix. Provider/usage tests now pass. SDK usage calls have a 10-second deadline, no retry, and retain stale cached readings on failure.

- Live check found PATH Claude 2.1.92 rejects get_usage; official Claude Code extension already includes matching 2.1.261. Default runtime discovery now prefers that installed binary. No install/update or credential parsing needed.
- 125 unit tests, typecheck, lint, build, and dark/light browser checks passed. Browser checks cover both file and URI drops, automatic refresh, timer cleanup, and accessibility.

- Live Claude check returned 7% remaining in the 5-hour window and 33% in the weekly window, with reset timestamps.
- Native VS Code verification passed: editor selection, visible Add to Crossbar chat context-menu item activated after hover, attachment contents delivered to the webview, and workspace URI drop. Custom menus make macOS menu controls accessible to the test.
- Packaged crossbar-0.1.0.vsix. No commits, publishing, account changes, or model prompts.
