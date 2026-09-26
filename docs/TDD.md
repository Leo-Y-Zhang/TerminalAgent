# TerminalAgent — technical design

v2.2.0, derived by reading `src/` rather than the README. Where the two
disagreed the code won and the README was corrected in the same pass.
Requirements: [PRD.md](PRD.md).

## Everything impure lives in one file

`src/index.ts` (797 lines) is the only impure module. It owns the readline REPL,
the slash commands, the chalk output, `process.exit`, and the real Anthropic
client. Everything else is either a pure function or is driven through an
injected seam.

The agentic loop in `src/agent.ts` never constructs a client, never prints, and
never asks a question. It receives an `AgentContext` carrying an `LlmClient`, an
`AgentIO` and an `execute` function — which is why 234 tests can cover the loop,
the tools, the classifier, checkpoints, sessions, pricing, context accounting and
compaction without a single network call or an API key.

**`LlmClient`** is a three-field interface over `client.messages.stream(...)`.
The real SDK stream is structurally assignable to it; tests pass a scripted fake.

**`execute`** is `(name, input) => Promise<ToolResult>`. `withCheckpoints()`
wraps it, so checkpointing is a decorator on the same seam rather than a branch
inside the loop. The loop only ever hands `execute` *approved* calls, which is
what makes "checkpoint everything that reaches execute" correct.

```
index.ts (impure shell)
  ├─ config.ts     defaults < .mentorrc.json < env
  ├─ env.ts        cwd .env loader; gate-controlling keys shell-only
  ├─ cli-args.ts   pure argv parser
  ├─ agent.ts      runAgenticLoop / runOnce  ── LlmClient seam ──> Anthropic SDK
  │                                          └─ execute seam ──> checkpoints.ts ──> tools.ts
  ├─ tools.ts      7 tools + denylist + ReDoS guard
  ├─ safety.ts     classifyCommand (pure)
  ├─ diff.ts       formatDiff (pure)
  ├─ preview.ts    denylisted read for write previews; terminal-safe toolPreview
  ├─ context.ts    window table, estimates, auto-compact decision (pure)
  ├─ compact.ts    transcript render + chunked summarisation ── LlmClient seam ──>
  ├─ pricing.ts    per-family price table (pure)
  ├─ session.ts    .mentor/sessions/<name>.json
  └─ version.ts    VERSION, pinned to package.json + README by a test
```

## What is a boundary, and what only looks like one

There is no access control, and that is the design: a single-user local process,
no accounts, no server, no database, no RLS, no `anon` role, nothing granted to
anyone. The process runs with the invoking user's own permissions and can reach
anything that user can reach.

Six things stand in its place, and they are not equally strong.

| Control | Enforces | Is it a boundary? |
|---|---|---|
| Confirmation gate on `bash` / `write_file` / `edit_file` | Nothing runs without an explicit `y` | **Yes** — the loop cannot reach `execute` for these tools without it, unless auto-approve is on |
| Sensitive-path denylist | Credential files are not read, written, edited, grepped, or shown in a write preview | Partly — deny-by-shape, so an unusual credential filename is not covered. It can only grow (config adds, never removes) |
| Command classifier | Louder warning on irreversible / fetch-and-execute commands | **No.** Heuristic. It never blocks; the README and the module header both say so |
| ReDoS guard | `grep` patterns > 500 chars and four catastrophic-backtracking shapes rejected; 10s wall-clock budget; 1000-match cap | Yes, for the denial-of-service it targets |
| `.mentor/.gitignore` = `*` | Transcripts and snapshots stay out of git | Yes, unless someone force-adds |
| Session name regex | No path traversal via `/save ../../x` | Yes |

The one credential in existence is `ANTHROPIC_API_KEY`, read from the environment
or a gitignored `.env`. It is never persisted to a session, a checkpoint or a
log. Revoking it in the console is the only revocation there is, and it takes
effect on the next API call, because nothing is cached.

Auto-approve is the one control that can be switched off, and it is loud about
it: the banner prints `AUTO-APPROVE is ON — destructive actions run without
confirmation` in yellow at startup. One-shot print mode has no interactive
approval at all, so destructive tools are simply skipped there unless `--yes` is
passed — which fails closed.

## On-disk artefacts

No database. Three local files, all schema-versioned, all parsed fail-loud.

**`.mentor/checkpoints/turn-NNNNNN.json`** —
`{ version: 1, turn: number, changes: FileChange[] }`

| Field | Type | Notes |
|---|---|---|
| `file` | string | Absolute path, resolved at write time |
| `tool` | string | `write_file` \| `edit_file` |
| `existedBefore` | boolean | `false` is the did-not-exist marker; undo *deletes* rather than restores |
| `before` | string | Full pre-image, `""` when `existedBefore` is false |
| `afterHash` | string | sha256 hex of what the tool left on disk — the entire safety mechanism of `/undo` |

Turn ids are allocated as `max(existing) + 1`, so a restart never collides with a
previous session's store. Files with zero changes are filtered out of
`listTurns`, and pruning keeps the newest `checkpointTurns` turns, 20 by default.

**`.mentor/sessions/<name>.json`** — `{ version: 1, name, model, messages }`. The
name must match `^[A-Za-z0-9._-]+$` and is rejected if it is `.` or `..`, so a
session name can never escape the directory.

**`.mentor/.gitignore`** — written as `*` the first time either store is created,
independently by both `session.ts` and `checkpoints.ts`. Transcripts and file
snapshots cannot reach a commit by accident.

There are no migrations and no migrations table, and neither store has ever had a
schema change, so there are no null-on-old-rows columns either. The version field
exists precisely so the first change fails loud: `parseTurnCheckpoint` and
`parseSession` throw on any version other than `1` rather than half-loading. A
`.mentor/` directory written by a newer build is refused by an older one, which is
the correct direction for a rollback.

Configuration resolves in three layers of increasing precedence: built-in
`DEFAULT_CONFIG`, then `.mentorrc.json` in cwd, then the environment (`MODEL`,
`MAX_TOKENS`, `AUTO_APPROVE`). Every key is type-checked on the way in and throws
a named error, so a malformed config exits 1 at startup rather than being
ignored. `AUTO_APPROVE` is honoured in **both** directions when explicitly set;
unset or empty leaves the file's value alone. The file itself may only say
`autoApprove: false`: it lives in the project, which is often a repository
somebody else wrote, so `true` throws instead of turning the gate off. For the
same reason `src/env.ts` loads cwd's `.env` without `AUTO_APPROVE` or
`ANTHROPIC_BASE_URL` (the second would send the key and the conversation to a
server the project chose); those two are read only from the real environment.

> **NAMING.** `.mentorrc.json`, `MENTOR.md` and `.mentor/` predate the 2026-08
> rename from Mentor and are deliberately unchanged. They are a data contract:
> renaming them orphans every existing config, memory file, session and checkpoint
> store on disk. A rename belongs in a major version that reads the old names
> first. Everything that is only a name — package, command, banner, system prompt
> — has moved.

## Interfaces

```ts
// agent.ts — the injected core
runAgenticLoop(messages: Message[], ctx: AgentContext): Promise<void>   // mutates messages in place
runOnce(prompt: string, ctx: AgentContext): Promise<number>             // 0 ok, 1 on any throw

// tools.ts
executeTool(name: string, input: Record<string, unknown>): Promise<ToolResult>
isSensitivePath(resolved: string): boolean        // symlink-resolved, case-insensitive
safeRegExp(pattern: string): RegExp | null        // null = rejected, never throws

// safety.ts — pure, no I/O
classifyCommand(command: string): { level: "normal"|"caution"|"danger", reason: string }

// checkpoints.ts — decorator over the execute seam
withCheckpoints(inner, opts): { execute, beginTurn(), sessionTurns(dir?) }
undoLastChange(cwd): UndoResult | null            // UndoResult.refused is the important half
undoLastTurn(cwd): UndoResult | null

// context.ts — pure
analyzeContext(opts): ContextBreakdown             // throws on invalid maxTokens/threshold
applyCacheBreakpoint(messages): void               // clears all, sets exactly one
isContextOverflowError(err): boolean

// compact.ts
compactHistory(messages, deps): Promise<CompactResult | null>  // throws => history untouched
```

Four contracts a caller could get wrong.

`executeTool` **returns errors, it does not throw them.** Every tool wraps its own
body in `try/catch` and reports `{ output, isError: true }`, and an unknown tool
name returns `Unknown tool: <name>` the same way — so a tool failure is fed back
to the model as a `tool_result` and the loop continues instead of the REPL dying.
The one unguarded line is `askUser`'s `readline.createInterface` call; a throw
there would propagate, which is untested and worth closing.

`classifyCommand` can only ever *raise* a rating. It unwraps `cmd /c` and
`powershell -Command` prefixes stage by stage, capped at eight, classifies every
intermediate string *and* every `&&`/`;`/`|`-separated segment, and keeps the
worst. Adding an unwrap stage is therefore strictly additive: it can surface a
threat, never hide one. The deliberate cost is a false banner when a separator
appears inside a quoted argument, such as a commit message.

`withCheckpoints` snapshots the pre-image **before** calling `inner`, and records
nothing when `inner` returns `isError`. If the pre-image could not be read for
any reason other than "file does not exist", the write still happens and the
result string is appended with an explicit warning that `/undo` will not cover
it. It never fails the tool call to protect its own bookkeeping.

`compactHistory` mutates `messages` only after the final non-empty summary has
arrived. Every failure path leaves the history byte-identical.

## What breaks, and how far the undo reaches

| What breaks | Who notices | How we detect it | How we undo it |
|---|---|---|---|
| Context window overflow (400 "prompt is too long") | User, immediately | `isContextOverflowError` matches the API phrasings; the failed message is popped so the prompt can be retried | `/compact` — chunked, so it works however far over the limit the session is |
| Cache breakpoints accumulate past the API cap | Every session, on the 4th prompt, as a hard 400 | **Shipped once.** Fixed by `applyCacheBreakpoint`, which clears every existing breakpoint before setting one. No test caught it because none drove the REPL to a fourth turn; `countCacheBreakpoints` now pins the invariant | `git revert`; the fix is 20 lines in `context.ts` |
| Checkpoint cannot be recorded (unreadable pre-image, full disk) | User, in the tool result | The write succeeds and the output carries `(warning: checkpoint not recorded - /undo will not cover this change: …)` | Nothing to undo — the point is that it says so rather than pretending coverage |
| File edited outside the tool between write and `/undo` | User, at `/undo` | sha256 of current content vs recorded `afterHash` | **Not applicable — the undo is refused**, and the diff (current vs what would be restored) is printed. Failing closed is the feature |
| `bash` changes files | Nobody, until `/undo` is expected to work | Not detected | Not covered. Documented limitation, not a bug |
| Compaction fails (API error, empty summary, mid-chunk failure) | User, in red | Exception from `summarizeOnce` | Automatic: history is only spliced after success, so it is already untouched. Message says "History unchanged" |
| `maxTokens` >= the model's whole window | User, at `/context` or the next turn | `maxTokensExceedsWindow` | Warned, and auto-compact is **skipped** rather than burning a large API call on a config compaction cannot fix |
| Unknown model id | User, in `/cost` and `/context` | Family regexes miss | Falls back to Sonnet-class pricing and a conservative 200K window, both explicitly labelled. Never a silent wrong number |
| `bash` command exceeds 30s | User, as a tool error | `execSync` timeout | Command is killed; stdout+stderr are returned to the model as `isError` |
| `grep` exceeds its 10s budget | User, in the output | Deadline check in the walker | Partial results returned with `(search timed out — partial results)` appended |
| Turn ids collide across directories after `/cwd` | Would show another directory's turns in `/changes` | `sessionTurns(dir)` scopes the id list to the directory it was allocated in | Already handled |
| **Two prompts submitted while a turn is in flight** | Rarely, as a confusing history or an API 400 | **Not detected.** `rl.on("line", async …)` is not awaited by readline and nothing pauses input, so a second `runAgenticLoop` can run concurrently on the same `messages` array | Not handled — see the PRD's out-of-scope section. Recorded, not fixed |
| **`ask_user` opens a second readline on the same stdin** | Rarely, as a swallowed or misrouted keystroke | Not detected. `tools.ts:askUser` creates its own interface while the REPL's is still open | Not handled. Recorded, not fixed |

The last two rows stay open on purpose. Serialising `rl.on("line")` is a
behaviour change: it needs its own PRD entry, a failing test first, and a
decision on what happens to input typed mid-turn — queue it, or discard it with a
message. `ask_user` competing for stdin wants the same treatment, by passing the
existing interface in rather than opening a second one.

Rolling the whole build back is the cheapest undo of all. Nothing is deployed,
so it is `git revert <sha> && npm run build`, about ten seconds: no server to
drain, no schema to migrate back, no user data shape that changes.

The one thing a rollback can strand is on-disk state written by a newer build.
Both stores are version-gated: an older build reading a `version: 2` checkpoint
or session throws `Unsupported checkpoint version: 2 (expected 1)` and refuses
rather than parsing it partially. That is the correct failure. A stranded store
is recovered by deleting `.mentor/`, which loses undo history and saved sessions
but never source files, since checkpoints only ever *hold* copies.

Irreversible by nature: anything an approved `bash` command did. No checkpoint
covers it, and no rollback of this repo brings it back. Accepted, because
sandboxing `bash` would remove the tool's reason to exist. The mitigation is the
approval gate plus the classifier banner, and the limitation is stated in the
README rather than glossed.

## What 234 tests without a network call can cover

234 tests, `node --test` over the compiled `dist/**/*.test.js`, run in CI on
every push alongside `tsc` and `eslint`. None touches the network.

**Positive — legitimate use still works.** Agentic loop: single-turn text,
multi-turn tool execution, approval running the tool, per-turn usage reported,
correct stop-reason termination, all against a fake `LlmClient`. `/undo` restores
an intact file, and `/undo turn` walks a file changed twice in one turn back to
its original content. Config: file read, env override, and `AUTO_APPROVE`
switching the gate in both directions. And two proofs the
classifier does not over-fire — `taskkill /f /im node.exe` and
`echo del /s /q is dangerous` both rate `normal`.

**Negative — the thing we prevent is prevented.** Denial of a destructive tool
feeds `is_error` back to the model and the file is untouched. `write_file`,
`edit_file` and `read_file` refuse sensitive paths including symlinked and
case-variant ones; the `grep` walker skips them; `readForPreview` returns `""` so
an overwritten credential file's contents never reach the terminal. `/undo`
refuses a file edited since — `refused[0].reason` matches `/edited/i` — and
leaves it byte-identical. Chained commands take their rating from the worst
segment rather than the first: `rm build/tmp && rm -rf ~` and
`del temp.txt & del /s /q C:\` both rate on their dangerous half, which is a
regression test for a real defect where the mitigation the user relies on was the
thing that failed. `approval-gate.test.ts` drives the real built CLI in one-shot
mode against a local fake of the Messages API whose model asks to run a shell
command: the command runs with `--yes` or a shell `AUTO_APPROVE=1` (the controls)
and does not run when the only opt-in is an `autoApprove: true` in the project's
`.mentorrc.json` or an `AUTO_APPROVE=1` in its `.env`, both regression tests for
a real bypass. `toolPreview` shows `rm -rf ~/project\r\x1b[2Kls -la` with the
carriage return and escape made visible rather than letting the terminal repaint
it as `ls -la`, and likewise for bidi overrides in commands and paths. And `safeRegExp` rejects over-long and catastrophic patterns.

**Boundary — the cases that reach production.** `hostile.test.ts` covers
malformed JSON, wrong schema version, unserialisable content blocks and
non-finite usage numbers, each failing loud rather than computing a confidently
wrong result. `formatPercent` renders a tiny nonzero fraction as `<1%` rather
than `0%`, and just-under-full as `>99%` rather than `100%`. `analyzeContext`
treats a measured `0` as "nothing measured", so an offline harness's all-zero
usage cannot suppress the estimate, and floors `autoCompactAt` at 1 so a tiny
threshold cannot fire on an empty session. `countCacheBreakpoints` pins exactly
one breakpoint after any number of turns, including on a history restored from
disk. `version.test.ts` pins `VERSION` equal to `package.json` and to a `vX.Y.Z`
string in the README, so a release cannot ship three different version numbers.
And `identity.test.ts` is an honesty tripwire: it asserts the system prompt says
`You are TerminalAgent` and *not* `You are Claude Code`, and that the speaker
label is not `Claude:`. It fails if a future edit makes the product lie about
what it is.

**Not covered by tests:** the interactive glue in `src/index.ts` — readline
wiring, slash-command dispatch, chalk formatting. It is exercised by
`examples/capture-transcript.mjs`, which drives the **real built binary** end to
end against a local replay of the Messages API on `127.0.0.1`, since the SDK
honours `ANTHROPIC_BASE_URL`. The SDK parser, loop, gate, tools, checkpoint store
and slash commands are therefore all the production path, with no key and nothing
leaving the machine. That is coverage of a happy path rather than a substitute
for unit tests, and the two concurrency defects above are exactly what it does
not reach.

## The order it shipped in, and why it was not arbitrary

As shipped: tooling and the version seam → the injected agentic core → diff
preview and command classifier → project memory, config and honest identity →
print mode → session persistence → per-model pricing and `/model` → retry with
injected sleep → docs and a hostile-input sweep. v2.1.0 added checkpoints and the
Windows classifier rules; v2.2.0 added context accounting and compaction.

The order was not arbitrary. The DI seam came third because nothing downstream of
it could be tested until it existed.
