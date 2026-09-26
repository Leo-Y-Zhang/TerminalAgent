#!/usr/bin/env node
import readline from "readline";
import Anthropic from "@anthropic-ai/sdk";
import chalk from "chalk";
import path from "path";
import { TOOL_DEFINITIONS, executeTool, configureExtraDenylist } from "./tools.js";
import { formatDiff } from "./diff.js";
import { classifyCommand } from "./safety.js";
import { readForPreview } from "./preview.js";
import { loadConfig, loadProjectContext, type TerminalAgentConfig } from "./config.js";
import { parseArgs } from "./cli-args.js";
import { saveSession, loadSession, listSessions } from "./session.js";
import { withCheckpoints, viewChanges, undoLastChange, undoLastTurn } from "./checkpoints.js";
import { estimateCost, type ModelUsage } from "./pricing.js";
import {
  analyzeContext,
  renderContextMeter,
  formatPercent,
  isContextOverflowError,
  type ContextBreakdown,
  applyCacheBreakpoint,
} from "./context.js";
import { compactHistory } from "./compact.js";
import {
  runAgenticLoop,
  runOnce,
  rollbackFailedTurn,
  type AgentContext,
  type LlmClient,
  type LlmStream,
  type Message,
} from "./agent.js";
import { VERSION } from "./version.js";
import { loadDotenv } from "./env.js";

// ─── Constants ────────────────────────────────────────────────────────────────

// Tools that modify the system require explicit confirmation before running,
// unless autoApprove is set (via config, AUTO_APPROVE=1, or --yes).
const DESTRUCTIVE_TOOLS = new Set(["bash", "write_file", "edit_file"]);

// ─── System prompt (cached — never changes, so stays at the front of the prefix) ──
// TerminalAgent is honest about being TerminalAgent (an assistant built on the Anthropic API),
// not the Claude Code product it is modelled on.

const SYSTEM_PROMPT_BASE = `You are TerminalAgent, an expert AI coding assistant running in the user's terminal, built on the Anthropic API.

You have access to the following tools to help you work with their codebase:
- read_file: Read file contents with line numbers
- write_file: Create or overwrite files
- edit_file: Make exact string replacements in files (read first to get exact content)
- bash: Execute shell commands
- glob: Find files by pattern
- grep: Search file contents
- ask_user: Ask the user a clarifying question when needed

Working directory: ${process.cwd()}

Guidelines:
- Always read files before editing them to ensure you have the current content
- Use edit_file for small targeted changes, write_file for new files or full rewrites
- Ask the user before taking any destructive or irreversible actions
- Be concise in your explanations — show code, not walls of prose
- When exploring an unfamiliar codebase, start with glob/grep to understand the structure
- Prefer making atomic, focused changes over large sweeping rewrites`;

// ─── CLI args (parsed before anything that needs an API key) ──────────────────

const cliArgs = parseArgs(process.argv.slice(2));

if (cliArgs.help) {
  printCliHelp();
  process.exit(0);
}
if (cliArgs.version) {
  console.log(VERSION);
  process.exit(0);
}
if (cliArgs.errors.length > 0) {
  for (const e of cliArgs.errors) console.error(chalk.red(e));
  console.error(chalk.dim("Run with --help for usage."));
  process.exit(2);
}

// ─── Environment (.env in cwd; never the keys that gate what the tool may do) ─

for (const key of loadDotenv(process.cwd(), process.env).refused) {
  console.error(
    chalk.yellow(`Ignoring ${key} from .env: it is honoured only from your shell environment, `) +
      chalk.yellow("since a project's .env must not be able to change what this tool is allowed to do."),
  );
}

// ─── Client ───────────────────────────────────────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    chalk.red("Error: ANTHROPIC_API_KEY is not set.\n") +
      chalk.dim("Create a .env file with ANTHROPIC_API_KEY=sk-ant-... or set the environment variable.")
  );
  process.exit(1);
}

const client = new Anthropic();

// ─── Resolved configuration and system prompt ─────────────────────────────────

function loadConfigOrExit(): TerminalAgentConfig {
  try {
    return loadConfig(process.cwd(), process.env);
  } catch (err) {
    console.error(chalk.red("Configuration error: " + (err instanceof Error ? err.message : String(err))));
    process.exit(1);
  }
}

const config = loadConfigOrExit();
configureExtraDenylist(config.extraDenylist);

// Checkpoint every approved write_file / edit_file so /undo and /changes work.
// The wrapper sits on the execute seam; all the logic lives in checkpoints.ts.
const checkpointer = withCheckpoints(executeTool, { keepTurns: config.checkpointTurns });

// Fold project memory (MENTOR.md / AGENTS.md) into the cached system prompt.
const projectContext = loadProjectContext(process.cwd());
const SYSTEM_TEXT = projectContext
  ? `${SYSTEM_PROMPT_BASE}\n\n# Project context (from MENTOR.md / AGENTS.md)\n\n${projectContext}`
  : SYSTEM_PROMPT_BASE;

// Adapter over the real streaming API — the loop lives in agent.ts and is driven
// through this seam (a fake replaces it in the tests).
const llm: LlmClient = {
  // The SDK's event union is wider than the loop needs; cast at this one seam.
  stream: (params) => client.messages.stream(params) as unknown as LlmStream,
};

// ─── UI helpers ───────────────────────────────────────────────────────────────

function printBanner() {
  console.log(chalk.cyan.bold(`\n  TerminalAgent v${VERSION}`));
  console.log(chalk.dim(`  Model: ${config.model}`));
  console.log(chalk.dim(`  CWD: ${process.cwd()}`));
  if (projectContext) console.log(chalk.dim("  Loaded project memory (MENTOR.md / AGENTS.md)"));
  if (config.autoApprove) console.log(chalk.yellow("  AUTO-APPROVE is ON — destructive actions run without confirmation"));
  console.log(chalk.dim("  Type /help for commands, Ctrl+C to exit\n"));
}

function printHelp() {
  console.log(chalk.bold("\nCommands:"));
  console.log(chalk.cyan("  /help         ") + "Show this help");
  console.log(chalk.cyan("  /clear        ") + "Clear conversation history");
  console.log(chalk.cyan("  /cost         ") + "Show token usage and estimated cost per model");
  console.log(chalk.cyan("  /context      ") + "Show a context-usage meter and breakdown");
  console.log(chalk.cyan("  /compact      ") + "Summarize the conversation to free context");
  console.log(chalk.cyan("  /cwd <path>   ") + "Change the working directory");
  console.log(chalk.cyan("  /model [id]   ") + "Show or switch the model for later turns");
  console.log(chalk.cyan("  /save [name]  ") + "Save this conversation to .mentor/sessions");
  console.log(chalk.cyan("  /resume [name]") + " Load a saved conversation");
  console.log(chalk.cyan("  /sessions     ") + "List saved sessions");
  console.log(chalk.cyan("  /changes      ") + "List files TerminalAgent changed this session, with diffs");
  console.log(chalk.cyan("  /undo [turn]  ") + "Revert the last file change (or the whole last turn)");
  console.log(chalk.cyan("  /exit         ") + "Exit the program\n");
}

function printToolCall(name: string, input: Record<string, unknown>) {
  const label = chalk.yellow(`[tool: ${name}]`);
  const preview = getToolPreview(name, input);
  process.stdout.write(`\n${label} ${chalk.dim(preview)}\n`);

  // Rich, colored diff preview before the user approves a file change.
  if (name === "edit_file") {
    printDiffPreview(String(input.old_string ?? ""), String(input.new_string ?? ""));
  } else if (name === "write_file") {
    // readForPreview applies the sensitive-path denylist, so overwriting a
    // credential file never streams its contents to the terminal.
    const existing = readForPreview(String(input.file_path));
    printDiffPreview(existing, String(input.content ?? ""));
  } else if (name === "bash") {
    const risk = classifyCommand(String(input.command ?? ""));
    if (risk.level !== "normal") {
      const paint = risk.level === "danger" ? chalk.red.bold : chalk.yellow;
      process.stdout.write("  " + paint(`⚠ ${risk.level.toUpperCase()}: ${risk.reason}`) + "\n");
    }
  }
}

// Print a colored, context-folded unified diff (green additions, red removals).
function printDiffPreview(oldText: string, newText: string) {
  const diff = formatDiff(oldText, newText, { context: 2 });
  if (!diff) return;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+")) process.stdout.write("  " + chalk.green(line) + "\n");
    else if (line.startsWith("-")) process.stdout.write("  " + chalk.red(line) + "\n");
    else process.stdout.write("  " + chalk.dim(line) + "\n");
  }
}

function getToolPreview(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "read_file":
      return String(input.file_path);
    case "write_file":
      return String(input.file_path);
    case "edit_file":
      return String(input.file_path);
    case "bash": {
      // Show the full command — never truncate, so the user sees what they're approving.
      const cmd = String(input.command ?? "");
      const cwd = input.cwd ? `  cwd: ${input.cwd}` : "";
      return cmd + (cwd ? `\n${cwd}` : "");
    }
    case "glob":
      return String(input.pattern);
    case "grep":
      return `/${input.pattern}/${input.include ? ` in ${input.include}` : ""}`;
    case "ask_user":
      return String(input.prompt).slice(0, 60);
    default:
      return JSON.stringify(input).slice(0, 60);
  }
}

function printToolResult(result: { output: string; isError?: boolean }) {
  if (result.isError) {
    const lines = result.output.split("\n").slice(0, 5).join("\n");
    process.stdout.write(chalk.red(`  ✗ ${lines}\n`));
  } else {
    const lines = result.output.split("\n");
    const preview = lines.slice(0, 3).join("\n");
    const suffix = lines.length > 3 ? chalk.dim(`\n  … (${lines.length} lines)`) : "";
    process.stdout.write(chalk.dim(`  ✓ ${preview}${suffix}\n`));
  }
}

// ─── Token tracking (per model, so /cost is accurate across model switches) ────

const usageByModel: Record<string, ModelUsage> = {};

// The API-reported size of the most recent call (prompt + output tokens): the
// authoritative context measure behind /context and auto-compact. Reset to null
// whenever the history is replaced (/clear, /resume, /compact, auto-compact).
let lastPromptTokens: number | null = null;

// Accumulate one API call's usage into the per-model /cost ledger. EVERY real
// call goes through here — agent turns and compaction calls alike, so /cost
// never under-reports the session's actual spend.
function recordUsage(model: string, usage: Anthropic.Usage) {
  const u = (usageByModel[model] ??= {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  u.inputTokens += usage.input_tokens;
  u.outputTokens += usage.output_tokens;
  u.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  u.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
}

// An agent turn additionally updates the measured context figure. Compaction
// calls must NOT come through here: their usage describes the summarization
// request, not the conversation that remains afterwards.
function trackTurnUsage(model: string, usage: Anthropic.Usage) {
  recordUsage(model, usage);
  // input + cache read + cache write is the full prompt actually processed;
  // the output tokens become part of the next request's prompt.
  lastPromptTokens =
    usage.input_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    usage.output_tokens;
}

function printCost() {
  const est = estimateCost(usageByModel);
  if (est.lines.length === 0) {
    console.log(chalk.dim("\nNo usage yet this session.\n"));
    return;
  }
  console.log(chalk.bold("\nSession usage:"));
  for (const line of est.lines) {
    const label = line.known ? line.model : `${line.model}${chalk.yellow(" (est.)")}`;
    console.log(`  ${label}`);
    console.log(
      chalk.dim(
        `    in ${line.usage.inputTokens.toLocaleString()}  out ${line.usage.outputTokens.toLocaleString()}` +
          `  cache-read ${line.usage.cacheReadTokens.toLocaleString()}  cache-write ${line.usage.cacheWriteTokens.toLocaleString()}`,
      ),
    );
    console.log(`    cost $${line.cost.toFixed(4)}`);
  }
  console.log(chalk.cyan(`  Total estimated cost: $${est.total.toFixed(4)}`));
  if (est.anyUnknown) {
    console.log(chalk.dim("  (est.) = model not in the price table; Sonnet-class rates assumed"));
  }
  console.log("");
}

// ─── Context meter + compaction (/context, /compact, auto-compact) ────────────

function currentBreakdown(messages: Message[]): ContextBreakdown {
  return analyzeContext({
    model: config.model,
    maxTokens: config.maxTokens,
    systemText: SYSTEM_TEXT,
    tools: TOOL_DEFINITIONS,
    messages,
    measuredTokens: lastPromptTokens,
    autoCompactThreshold: config.autoCompactThreshold,
  });
}

function printContext(b: ContextBreakdown) {
  console.log(chalk.bold("\nContext usage:"));
  console.log(
    chalk.dim(
      `  Model ${b.model} — context window ${b.contextWindow.toLocaleString()} tokens` +
        (b.windowKnown ? "" : " (unknown model; conservative default)"),
    ),
  );
  console.log(
    chalk.dim(
      `  Usable for input: ${b.usableWindow.toLocaleString()} tokens` +
        ` (window minus the ${config.maxTokens.toLocaleString()}-token output reservation)`,
    ),
  );
  if (b.maxTokensExceedsWindow) {
    console.log(
      chalk.yellow(
        `  ⚠ maxTokens (${config.maxTokens.toLocaleString()}) meets or exceeds this model's` +
          ` ${b.contextWindow.toLocaleString()}-token window — no room for input;` +
          " lower maxTokens or switch models",
      ),
    );
  }
  console.log(
    "  " +
      renderContextMeter(b.usedFraction) +
      chalk.dim(`  ${b.effectiveTokens.toLocaleString()} / ${b.usableWindow.toLocaleString()} tokens`),
  );
  if (b.measuredTokens != null) {
    console.log(chalk.dim(`  Measured (last API call): ${b.measuredTokens.toLocaleString()} tokens`));
  } else {
    console.log(chalk.dim("  No API call yet this session — figures below are estimates."));
  }
  console.log(chalk.dim("  Estimated composition (~4 chars/token heuristic):"));
  console.log(chalk.dim(`    system prompt     ~${b.systemTokens.toLocaleString()}`));
  console.log(chalk.dim(`    tool definitions  ~${b.toolTokens.toLocaleString()}`));
  console.log(
    chalk.dim(
      `    messages          ~${b.messageTokens.toLocaleString()}` +
        ` (${b.messageCount} message${b.messageCount === 1 ? "" : "s"})`,
    ),
  );
  if (b.autoCompactAt != null) {
    const note = b.willAutoCompact ? chalk.yellow("  — will auto-compact after the next turn") : "";
    console.log(
      chalk.dim(
        `  Auto-compact at ${Math.round(b.autoCompactThreshold * 100)}% of usable` +
          ` (${b.autoCompactAt.toLocaleString()} tokens)`,
      ) + note,
    );
  } else {
    console.log(chalk.dim("  Auto-compact: disabled (autoCompactThreshold 0)"));
  }
  console.log("");
}

// Run /compact (or the auto-compact path): summarize through the same DI seam
// the loop uses and replace the history in place. Failure leaves it untouched.
async function runCompact(messages: Message[], auto: boolean): Promise<void> {
  if (messages.length === 0) {
    console.log(chalk.dim("Nothing to compact."));
    return;
  }
  process.stdout.write(chalk.dim(auto ? "  Auto-compacting conversation…\n" : "Compacting conversation…\n"));
  try {
    const res = await compactHistory(messages, {
      client: llm,
      model: config.model,
      maxTokens: config.maxTokens,
      // Compaction calls are real API calls: count them in /cost. They do not
      // touch lastPromptTokens — that figure describes the conversation.
      onUsage: (usage) => recordUsage(config.model, usage),
    });
    if (!res) {
      console.log(chalk.dim("Nothing to compact."));
      return;
    }
    lastPromptTokens = null; // the old measurement described the old history
    const calls = res.chunksSummarized > 1 ? `, ${res.chunksSummarized} chunked summarization calls` : "";
    console.log(
      chalk.green(`  ✓ compacted ${res.messagesBefore} message${res.messagesBefore === 1 ? "" : "s"} → 1`) +
        chalk.dim(
          ` (~${res.estimatedTokensBefore.toLocaleString()} → ~${res.estimatedTokensAfter.toLocaleString()}` +
            ` estimated message tokens${calls})`,
        ),
    );
  } catch (err) {
    console.log(chalk.red("  ✗ compact failed: " + (err instanceof Error ? err.message : String(err))));
    console.log(chalk.dim("  History unchanged" + (auto ? "; /compact to retry." : ".")));
  }
}

async function maybeAutoCompact(messages: Message[]): Promise<void> {
  const b = currentBreakdown(messages);
  if (!b.willAutoCompact) return;
  if (b.maxTokensExceedsWindow) {
    // Degenerate config: the whole window is reserved for output, so the
    // trigger is meaningless and compaction cannot help. Warn, do not spend.
    console.log(
      chalk.yellow(
        `\n  ⚠ auto-compact skipped: maxTokens (${config.maxTokens.toLocaleString()}) meets or exceeds` +
          ` this model's ${b.contextWindow.toLocaleString()}-token window — lower maxTokens or switch models`,
      ),
    );
    return;
  }
  console.log(
    chalk.yellow(
      `\n  ⚠ context is at ${formatPercent(b.usedFraction)} of the usable window` +
        ` (threshold ${formatPercent(b.autoCompactThreshold)})`,
    ),
  );
  await runCompact(messages, true);
}

// ─── Agent context factory ────────────────────────────────────────────────────
// Builds the dependency-injected context that drives the loop in agent.ts.

function buildAgentContext(
  confirm: (name: string, input: Record<string, unknown>) => Promise<boolean>
): AgentContext {
  return {
    client: llm,
    io: {
      onText: (text) => process.stdout.write(text),
      onToolCall: (name, input) => printToolCall(name, input),
      onToolResult: (result) => printToolResult(result),
      confirm,
    },
    execute: checkpointer.execute,
    tools: TOOL_DEFINITIONS as unknown as Anthropic.Tool[],
    model: config.model,
    maxTokens: config.maxTokens,
    system: [
      {
        type: "text",
        text: SYSTEM_TEXT,
        // Cache the system prompt — it never changes between turns
        cache_control: { type: "ephemeral" },
      },
    ],
    autoApprove: config.autoApprove,
    destructiveTools: DESTRUCTIVE_TOOLS,
    onUsage: (usage) => trackTurnUsage(config.model, usage),
    retry: {
      maxRetries: 3,
      baseDelayMs: 500,
      onRetry: (attempt, delayMs, err) => {
        const reason = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          chalk.yellow(`\n  ⟳ transient API error (${reason}); retry ${attempt} in ${delayMs}ms…\n`),
        );
      },
    },
  };
}

// ─── Main REPL ────────────────────────────────────────────────────────────────

async function main() {
  printBanner();

  const messages: Message[] = [];

  // Seed from a saved session when --resume <name> was passed.
  if (cliArgs.resume) {
    try {
      const data = loadSession(process.cwd(), cliArgs.resume);
      messages.push(...data.messages);
      console.log(chalk.dim(`Resumed session "${cliArgs.resume}" (${messages.length} messages).`));
    } catch (err) {
      console.log(chalk.red(String(err instanceof Error ? err.message : err)));
    }
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const prompt = () => {
    process.stdout.write(chalk.green("\n> "));
  };

  // Ask the user to approve a destructive tool call before it runs.
  const confirmAction = (
    name: string,
    input: Record<string, unknown>
  ): Promise<boolean> =>
    new Promise((resolve) => {
      rl.question(
        chalk.yellow(`  ⚠ Run ${name}? `) +
          chalk.dim(getToolPreview(name, input)) +
          chalk.yellow("  [y/N] "),
        (ans) => resolve(/^y(es)?$/i.test(ans.trim()))
      );
    });

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      prompt();
      return;
    }

    // ── Slash commands ───────────────────────────────────────────────────────
    if (input.startsWith("/")) {
      const [cmd, ...args] = input.slice(1).split(" ");

      switch (cmd) {
        case "help":
          printHelp();
          break;

        case "clear":
          messages.length = 0;
          lastPromptTokens = null; // the old measurement described the old history
          console.log(chalk.dim("Conversation cleared."));
          break;

        case "cost":
          printCost();
          break;

        case "context":
          try {
            printContext(currentBreakdown(messages));
          } catch (err) {
            console.log(chalk.red(String(err instanceof Error ? err.message : err)));
          }
          break;

        case "compact":
          await runCompact(messages, false);
          break;

        case "cwd": {
          // Join the remaining args so directory paths that contain spaces
          // are not truncated at the first space.
          const dir = args.join(" ").trim();
          if (dir) {
            try {
              const target = path.resolve(dir);
              process.chdir(target);
              console.log(chalk.dim(`Working directory: ${process.cwd()}`));
            } catch (err) {
              console.log(chalk.red(String(err)));
            }
          } else {
            console.log(process.cwd());
          }
          break;
        }

        case "save": {
          const name = (args.join(" ").trim() || "last").replace(/\s+/g, "-");
          try {
            const file = saveSession(process.cwd(), name, config.model, messages);
            console.log(chalk.dim(`Saved session "${name}" (${messages.length} messages) → ${file}`));
          } catch (err) {
            console.log(chalk.red(String(err instanceof Error ? err.message : err)));
          }
          break;
        }

        case "resume": {
          const name = (args.join(" ").trim() || "last").replace(/\s+/g, "-");
          try {
            const data = loadSession(process.cwd(), name);
            messages.length = 0;
            messages.push(...data.messages);
            lastPromptTokens = null; // measurement belonged to the replaced history
            console.log(chalk.dim(`Resumed session "${name}" (${messages.length} messages).`));
          } catch (err) {
            console.log(chalk.red(String(err instanceof Error ? err.message : err)));
          }
          break;
        }

        case "sessions": {
          const names = listSessions(process.cwd());
          console.log(names.length ? "Saved sessions:\n  " + names.join("\n  ") : chalk.dim("No saved sessions."));
          break;
        }

        case "model": {
          const name = args.join(" ").trim();
          if (!name) {
            console.log(chalk.dim(`Current model: ${config.model}`));
          } else {
            config.model = name;
            console.log(chalk.dim(`Model set to ${name} for subsequent turns.`));
            // Switching to a smaller-window model can strand an oversized
            // conversation; say so now rather than letting the next turn 400.
            const b = currentBreakdown(messages);
            if (b.effectiveTokens > b.usableWindow) {
              console.log(
                chalk.yellow(
                  `  ⚠ current context (~${b.effectiveTokens.toLocaleString()} tokens) exceeds this model's` +
                    ` usable window (${b.usableWindow.toLocaleString()}) — run /compact before the next turn.`,
                ),
              );
            }
          }
          break;
        }

        case "changes": {
          try {
            // Scoped to the current directory: after /cwd, a turn id allocated
            // here must not surface another directory's identically numbered turn.
            const mine = new Set(checkpointer.sessionTurns(process.cwd()));
            const turns = viewChanges(process.cwd()).filter((t) => mine.has(t.turn));
            if (turns.length === 0) {
              console.log(chalk.dim("No files changed this session."));
              break;
            }
            for (const t of turns) {
              console.log(chalk.bold(`\nTurn ${t.turn}:`));
              for (const ch of t.changes) {
                const flags =
                  (ch.existedBefore ? "" : chalk.dim(" (new file)")) +
                  (ch.intact ? "" : chalk.yellow(" (edited outside TerminalAgent since)"));
                console.log(chalk.cyan(`  ${ch.file}`) + flags);
                printDiffPreview(ch.before, ch.current);
              }
            }
            console.log("");
          } catch (err) {
            console.log(chalk.red(String(err instanceof Error ? err.message : err)));
          }
          break;
        }

        case "undo": {
          // The only recognised argument is "turn" — anything else is rejected
          // rather than silently degrading to a single-change undo.
          const arg = args.join(" ").trim().toLowerCase();
          if (arg && arg !== "turn") {
            console.log(chalk.red(`Unknown /undo argument: ${arg}. Use /undo or /undo turn.`));
            break;
          }
          const wholeTurn = arg === "turn";
          try {
            const res = wholeTurn ? undoLastTurn(process.cwd()) : undoLastChange(process.cwd());
            if (!res) {
              console.log(chalk.dim("Nothing to undo."));
              break;
            }
            for (const u of res.undone) {
              console.log(chalk.green(`  ✓ ${u.action === "deleted" ? "removed" : "restored"} ${u.file}`));
            }
            for (const r of res.refused) {
              console.log(chalk.red(`  ✗ refused: ${r.file}`));
              console.log(chalk.red(`    ${r.reason}`));
              console.log(chalk.dim("    diff (current on disk -> what /undo would restore):"));
              printDiffPreview(r.current, r.before);
            }
          } catch (err) {
            console.log(chalk.red(String(err instanceof Error ? err.message : err)));
          }
          break;
        }

        case "exit":
        case "quit":
          printCost();
          process.exit(0);
          break;

        default:
          console.log(chalk.red(`Unknown command: /${cmd}. Type /help for help.`));
      }

      prompt();
      return;
    }

    // ── Send to the model ─────────────────────────────────────────────────────
    messages.push({ role: "user", content: input });

    // Exactly ONE cache breakpoint, on the newest message. Stamping one per
    // turn without removing the previous accumulated them until the request hit
    // the API's cap and every send failed with a hard 400 - on the fourth prompt
    // of every session. See applyCacheBreakpoint for why no test caught it.
    applyCacheBreakpoint(messages);

    process.stdout.write(chalk.cyan("\nTerminalAgent: "));

    try {
      checkpointer.beginTurn(); // group this prompt's file changes for /undo turn
      await runAgenticLoop(messages, buildAgentContext(confirmAction));
      process.stdout.write("\n");
      // Auto-compact once the measured context crosses the configured threshold.
      await maybeAutoCompact(messages);
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        console.error(chalk.red(`\nAPI Error ${err.status}: ${err.message}`));
        // Roll the whole partial turn back so the user can retry. Popping only
        // the last message left an unanswered tool_use on top of the history,
        // which the API rejects on every later send.
        rollbackFailedTurn(messages);
        if (isContextOverflowError(err)) {
          // The turn never succeeded, so auto-compact could not fire; point at
          // the recovery tool (chunked, so it works however far over we are).
          console.error(
            chalk.yellow(
              "  The conversation no longer fits this model's context window —" +
                " run /compact to summarize it, or /clear to start over.",
            ),
          );
        }
      } else {
        console.error(chalk.red("\nError: " + String(err)));
        rollbackFailedTurn(messages);
      }
    }

    prompt();
  });

  rl.on("close", () => {
    console.log(chalk.dim("\nGoodbye!"));
    printCost();
    process.exit(0);
  });

  prompt();
}

// ─── Non-interactive (print) mode ─────────────────────────────────────────────

function printCliHelp() {
  console.log(`TerminalAgent v${VERSION} — a terminal AI coding assistant on the Anthropic API

Usage:
  terminal-agent                     Start the interactive REPL
  terminal-agent -p "<prompt>"       Run a single prompt and print the result, then exit
  echo "<prompt>" | terminal-agent   Same, reading the prompt from stdin

Options:
  -p, --print <prompt>   One-shot mode: answer the prompt and exit
  --model <id>           Override the model for this run
  --resume <name>        Resume a saved session
  -y, --yes              Approve destructive actions without prompting
  -h, --help             Show this help
  -v, --version          Show the version

In one-shot mode the assistant's text goes to stdout and tool activity to
stderr, so you can pipe the answer. Destructive tools are skipped unless --yes.`);
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
  });
}

// One-shot context: assistant text to stdout, tool activity to stderr (so the
// answer can be piped cleanly), and no interactive confirmation.
function buildPrintContext(): AgentContext {
  return {
    ...buildAgentContext(async () => config.autoApprove),
    io: {
      onText: (text) => process.stdout.write(text),
      onToolCall: (name, input) =>
        process.stderr.write(chalk.yellow(`\n[tool: ${name}] `) + chalk.dim(getToolPreview(name, input)) + "\n"),
      onToolResult: (result) =>
        process.stderr.write(result.isError ? chalk.red("  ✗ tool error\n") : chalk.dim("  ✓\n")),
      confirm: async () => config.autoApprove,
    },
  };
}

async function bootstrap() {
  // CLI flags override the resolved config for this run (help/version/errors
  // were already handled at startup, before the API-key check).
  if (cliArgs.model) config.model = cliArgs.model;
  if (cliArgs.yes) config.autoApprove = true;

  // One-shot mode when -p is given or input is piped (not a TTY).
  const piped = !process.stdin.isTTY;
  if (cliArgs.print != null || piped) {
    const promptText = cliArgs.print != null ? cliArgs.print : await readStdin();
    if (!promptText.trim()) {
      console.error(chalk.red("No prompt provided. Use -p \"<prompt>\" or pipe input, or run with --help."));
      process.exit(2);
    }
    const code = await runOnce(promptText, buildPrintContext());
    process.stdout.write("\n");
    process.exit(code);
  }

  await main();
}

bootstrap().catch((err) => {
  console.error(chalk.red("Fatal: " + String(err)));
  process.exit(1);
});
