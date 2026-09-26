# Changelog

All notable changes to TerminalAgent are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); this project uses
[Semantic Versioning](https://semver.org/).

Releases up to and including 2.2.0 shipped under the project's former name,
**Mentor**. Those entries are left exactly as they were written — a changelog is
a record of what was released, so renaming the project does not rewrite it.

## [Unreleased]

### Changed

- **Renamed the project from Mentor to TerminalAgent.** The display name, the
  system-prompt identity, the REPL banner and speaker label, the npm package
  name, and the installed command (`mentor` -> `terminal-agent`) all move. After
  pulling this, re-run `npm link` if you had the old command on your PATH.

### Security

- **A project directory can no longer switch off confirmation.** The working
  directory is often a repository somebody else wrote, yet an
  `autoApprove: true` in its `.mentorrc.json`, or an `AUTO_APPROVE=1` in its
  `.env`, made every shell command and file write the model proposed run
  unasked (in one-shot mode, with no banner). `.mentorrc.json` now accepts only
  `autoApprove: false` and fails loud on `true`; the `.env` loader ignores
  `AUTO_APPROVE` with a warning. Use `--yes` or `AUTO_APPROVE=1` in your shell.
- **A project `.env` can no longer redirect the API.** `ANTHROPIC_BASE_URL` from
  cwd's `.env` sent the user's API key and the whole conversation to a server
  of the project's choosing. It is now honoured only from the real environment.

- **Approval previews can no longer be repainted.** The command, path and diff
  shown at the `[y/N]` prompt were written to the terminal raw, so a carriage
  return or an ANSI sequence in a model-chosen command could erase the real
  command from view (`rm -rf ~/project\r\x1b[2Kls -la` displayed as
  `ls -la`), and a bidi override could reorder it. Control, zero-width and bidi
  characters are now shown as visible escapes there, in tool output, in
  `ask_user` questions and in streamed assistant text.

### Notes

- The on-disk names `.mentorrc.json`, `MENTOR.md` and `.mentor/` (sessions and
  checkpoints) are **deliberately unchanged**. They are a data contract rather
  than a label: renaming them would silently orphan every existing config file,
  project-memory file, saved session and checkpoint store in every directory the
  tool has run in. That is a breaking change owed a major version and a
  read-the-old-name fallback, not a documentation pass. See `docs/TDD.md`.

## [2.2.0] - 2026-07-31

### Added

- **Context accounting and `/context`** (`src/context.ts`): a pure, deterministic
  module in the pricing.ts idiom. `contextWindowFor` matches model families
  (Sonnet 4.6+/Opus 4.6+/5-series = 1M tokens; Haiku and older revisions = 200K;
  unknown models fall back to a conservative 200K flagged `known:false`);
  `analyzeContext` breaks usage into system prompt / tool definitions / messages
  (~4 chars/token heuristic plus a flat per-message overhead), prefers the API's
  own measured usage from the most recent call (input + cache read + cache write
  + output) when a turn has run, and decides the auto-compact trigger against
  the usable window (window minus the `maxTokens` output reservation).
  `/context` renders it as a meter plus breakdown, always labelling estimates as
  estimates. Edge-honest percentages: a tiny nonzero fraction reads `<1%`, just
  under full reads `>99%`.
- **Conversation compaction and `/compact`** (`src/compact.ts`): the history is
  rendered to a plain transcript (sidestepping tool_use/tool_result pairing
  rules; oversized blocks truncated) and summarized through the same injected
  LlmClient seam the agentic loop uses, then replaced in place by a single
  marked summary message. A transcript too large for one call — including one
  that has outgrown the current model's entire window — is split at line
  boundaries under a conservative 2 chars/token budget and rolled through
  chunked summarization, so a heavily overflowed session is always recoverable.
  Every failure path (API error, empty summary, mid-chunk failure) leaves the
  history untouched; the summary is only spliced in after the final non-empty
  result.
- **Auto-compact** with a new `.mentorrc.json` key `autoCompactThreshold`
  (fraction of the usable window, default 0.8, 0 disables, fail-loud validation
  like every other key): after each completed turn, Mentor compacts
  automatically once measured usage crosses the threshold, and says so first.
  `/model` now warns when the current conversation exceeds the new model's
  usable window, and a context-overflow API error (400 "prompt is too long")
  prints a pointer to `/compact`. One-shot print mode never auto-compacts.
- 48 new offline deterministic tests (context table and estimators, analysis
  edge cases, meter rendering, transcript rendering, single and chunked
  compaction, failure paths, usage reporting, config validation, hostile
  sweeps): 198 total, up from 150 at v2.1.0.

### Fixed

Findings from the adversarial review of this feature, fixed before release:

- **Compaction spend is counted in `/cost`**: `compactHistory` reports each
  summarization call's usage through a new `onUsage` hook (even when the
  summary is rejected as empty — the tokens were spent either way), and the
  REPL feeds it into the same per-model ledger as agent turns. Without this,
  every `/compact` and auto-compact was a real API call invisible to `/cost`.
  The compaction call's usage deliberately does not touch the measured context
  figure, which describes the conversation, not the summarization request.
- **`/compact` no longer sends the whole transcript as one request**: the
  chunked rolling path above replaced a single-request design that could not
  compact a history larger than the current model's window (e.g. a large
  1M-window session after `/model` to a 200K model) — precisely the state
  `/compact` exists to fix.
- **A measured figure of exactly 0 no longer suppresses the estimate**: offline
  harnesses report all-zero usage; `analyzeContext` now treats 0 as "nothing
  measured" so the estimate stays in force.
- **Degenerate `maxTokens` cannot fake an auto-compact trigger**: when
  `maxTokens` meets or exceeds the model's window, `/context` and the
  auto-compact path warn that there is no room for input instead of firing a
  meaningless compaction (the trigger is also floored at one token, so an empty
  session never trips it).

## [2.1.0] - 2026-07-30

### Added

- **Turn-level checkpoints with `/undo` and `/changes`** (`src/checkpoints.ts`):
  before each approved `write_file` / `edit_file` is applied, the pre-image (the
  file's full prior content, or an explicit did-not-exist marker) and a sha256 of
  the post-image are recorded, grouped per user turn, under
  `.mentor/checkpoints/` — made self-ignoring exactly the way
  `.mentor/sessions/` already is. `/changes` lists every file Mentor changed this
  session, grouped by turn, with colored diffs from the existing diff renderer.
  `/undo` reverts the most recent change and `/undo turn` the whole last turn;
  a revert is refused with a diff whenever the file's current content no longer
  hashes to the recorded post-image (the user edited it since), so user edits are
  never clobbered. Old checkpoints are pruned to the last `checkpointTurns` turns
  (a new `.mentorrc.json` key, positive integer, default 20). Everything sits
  behind the existing dependency-injected execute seam and is unit-tested with
  temp dirs and a fake client — no new runtime dependencies, no network.
- **Windows-aware dangerous-command classifier** (`src/safety.ts`): the bash tool
  runs cmd.exe on win32, so the rule table now also recognises
  `del`/`erase`/`rd`/`rmdir` with `/s /q` (caution locally, danger on a drive
  root or the Windows directory), `format <drive>`, `diskpart`,
  `reg delete HKLM|HKCU`, PowerShell `Remove-Item -Recurse -Force`,
  `vssadmin delete shadows`, `taskkill /f` on system-critical processes
  (csrss, lsass, winlogon, …), and download-and-execute shapes (`iwr … | iex`,
  `Invoke-Expression` wrapped around a web request or WebClient, downloads piped
  into cmd/powershell). Keywords are matched at command position only, so benign
  strings that merely contain one (filenames, echoed messages) do not trip a
  rule, and ambiguous shapes (bare `Invoke-Expression`, local-path recursive
  deletes) rate caution rather than danger. Every POSIX rule is unchanged, with
  table-driven tests in both directions.
- **Runnable doc scripts** (`examples/`): the README's `/undo` transcript and
  classifier table are pasted output of scripts run against the real code.
  `capture-transcript.mjs` drives the real built binary through a scripted
  session — a local Messages-API replay on 127.0.0.1 stands in for the model
  (the SDK honours `ANTHROPIC_BASE_URL`), so no API key is needed and nothing
  leaves the machine — and `classifier-table.mjs` prints the table straight
  from `classifyCommand`. Regenerate either and diff against the README to
  check the docs have not drifted.

### Fixed

- **Wrapper prefixes no longer defeat the Windows rules**: `cmd /c` / `cmd /k`
  (and `cmd.exe`, including flag runs like `/d /s /c`) and unquoted
  `powershell`/`pwsh` `-Command` / `-c` prefixes found at a command position are
  stripped before matching, and every unwrapping stage is classified with the
  worst rating kept — so `cmd /c del /s /q C:\` or
  `powershell -Command Remove-Item -Recurse -Force C:\` now rate danger exactly
  like their payloads instead of slipping through as normal.
- The cmd.exe recursive-delete rule recognises concatenated switches
  (`del /s/q`, `rd/s/q`), and the vssadmin rule also flags
  `vssadmin delete shadowstorage`.
- `/changes` scopes its this-session filter per directory, so after `/cwd` a
  turn id allocated here can no longer surface an identically numbered turn a
  previous session recorded in the new directory.
- `/undo` rejects an unrecognised argument (for example `/undo 3`) instead of
  silently performing a single-change undo.

## [2.0.0] - 2026-07-12

A major, backward-compatible expansion turning the compact v1 clone into a safe,
transparent, testable, project-aware terminal coding assistant. The seven tools
and their contracts are unchanged; every addition is built test-first and is
either a pure deterministic function or driven through a dependency-injected core.

### Added

- **Dependency-injected agentic core** (`src/agent.ts`): the loop is extracted
  behind an injected `LlmClient` and `AgentIO` seam and unit-tested with a fake
  client — tool execution, confirm approve/deny, error feedback, multi-turn,
  and per-turn usage — with no network.
- **Real diff previews** (`src/diff.ts`): a pure line diff (prefix/suffix trim +
  LCS, block-replace fallback) renders a colored, context-folded `+/-` diff before
  any `edit_file` / `write_file`.
- **Dangerous-command classifier** (`src/safety.ts`): `bash` commands are rated
  normal / caution / danger (`rm -rf /`, `curl | sh`, `dd`/`mkfs` to a device,
  fork bombs, force-push, `sudo`, recursive `chmod 777`, shutdown) and flagged
  loudly; the approval gate is unchanged and still required.
- **Project memory + config** (`src/config.ts`): `.mentorrc.json` (model,
  maxTokens, autoApprove, extraDenylist) merged with env vars (env wins,
  fail-loud on malformed input), and a `MENTOR.md` / `AGENTS.md` folded into the
  cached system prompt. `extraDenylist` can only grow the sensitive-path guard.
- **Non-interactive print mode**: `mentor -p "…"` or piped stdin answers one
  prompt and exits with a status code (answer to stdout, tool activity to stderr).
  Powered by a pure argv parser (`src/cli-args.ts`) and a tested `runOnce`.
- **Session persistence** (`src/session.ts`): `/save`, `/resume`, `/sessions`, and
  `--resume` store schema-versioned transcripts under `.mentor/sessions/`, which
  is made self-ignoring so transcripts never land in git. Session names are
  validated against path traversal; parsing fails loud.
- **Accurate multi-model cost + `/model`** (`src/pricing.ts`): usage is tracked
  per model and `/cost` prices each with its own family rates; unknown models are
  labelled estimates. `/model <id>` switches the model mid-session.
- **Resilient API calls**: each model turn retries transient failures
  (429 / 5xx / 529 / network) with exponential backoff and an injected sleep,
  only when nothing has streamed yet, so text is never double-printed.
- **Tooling**: ESLint (flat config) + `npm run lint`, a Node 22/24 CI matrix with
  a lint step, a version-lockstep test, and a hostile-input sweep over the pure
  modules.

### Changed

- **Honest identity**: the system prompt now says Mentor is Mentor, an assistant
  built on the Anthropic API, instead of claiming to be Claude Code.
- `npm test` builds and runs all `dist/**/*.test.js`, so new test files are picked
  up automatically.
- The version string lives in `src/version.ts` as the single source of truth, kept
  in lockstep with `package.json` and the README by a test.

## [1.0.0]

- Initial release: a terminal Claude Code–style agent over the Anthropic Messages
  API — a streaming agentic loop with a cached system prompt, seven tools
  (read/write/edit/bash/glob/grep/ask_user), a destructive-action confirmation
  gate, a sensitive-path denylist, and a ReDoS guard, with the tool layer tested.
