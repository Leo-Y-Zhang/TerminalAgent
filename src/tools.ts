import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { glob } from "fs/promises";
import readline from "readline";

export interface ToolResult {
  output: string;
  isError?: boolean;
}

// ─── Sensitive-path denylist ──────────────────────────────────────────────────
// Prevent the model from silently reading credentials and secret files.
// Applied to readFile and the grep walker.

const HOME = os.homedir();
const DENYLIST_PREFIXES: string[] = [
  path.join(HOME, ".ssh"),
  path.join(HOME, ".aws"),
  path.join(HOME, ".config", "gh"),
  path.join(HOME, ".gnupg"),
  path.join(HOME, ".netrc"),
  path.join(HOME, ".npmrc"),
  path.join(HOME, ".pypirc"),
];
const DENYLIST_NAMES = new Set([
  "credentials",
  "credentials.json",
  "service-account.json",
  "service_account.json",
  "id_rsa",
  "id_ed25519",
  "id_dsa",
  "id_ecdsa",
  ".git-credentials",
  ".npmrc",
  ".pgpass",
  ".pypirc",
  ".netrc",
]);

// Extra denied basenames, configured once at startup from .mentorrc.json. The
// denylist can only ever grow — config cannot remove a built-in protection.
let EXTRA_DENYLIST_NAMES = new Set<string>();

export function configureExtraDenylist(names: string[]): void {
  EXTRA_DENYLIST_NAMES = new Set(names.map((n) => n.toLowerCase()));
}

/** The path with every symlink resolved, including in the parents of a file
 *  that does not exist yet (a new file under a symlinked directory) and a
 *  dangling link, which a write follows to create its target.
 *
 *  Where realpath fails, the path is walked one component at a time, as the
 *  kernel does. A link's target is spliced in front of the components still to
 *  walk, so a ".." in it steps out of the directory the link REALLY points
 *  into. Resolving the target text against the link's own directory with
 *  path.resolve would drop "d/.." lexically, and a link "L -> d/../new" with
 *  "d" linked elsewhere would be checked, and previewed, as a harmless
 *  sibling of L while the write lands next to d's real target. */
export function realTarget(resolved: string): string {
  try {
    return fs.realpathSync(resolved);
  } catch {
    /* a dangling link or a path that does not exist yet: walk it */
  }
  const root = path.parse(resolved).root;
  let done = root;
  let todo = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let hops = 0;
  while (todo.length > 0) {
    const part = todo.shift() as string;
    if (part === ".") continue;
    if (part === "..") {
      done = path.dirname(done); // `done` is already free of links
      continue;
    }
    const next = path.join(done, part);
    let isLink: boolean;
    try {
      isLink = fs.lstatSync(next).isSymbolicLink();
    } catch {
      return path.join(next, ...todo); // does not exist: nothing below it can redirect
    }
    if (!isLink) {
      done = next;
      continue;
    }
    try {
      done = fs.realpathSync(next); // a live link (including /proc's magic ones)
      continue;
    } catch {
      /* dangling: follow its text */
    }
    if (++hops > 40) return path.join(next, ...todo); // a loop; the write fails with ELOOP
    const target = fs.readlinkSync(next);
    const targetRoot = path.parse(target).root;
    if (targetRoot) done = targetRoot;
    todo = [...target.slice(targetRoot.length).split(process.platform === "win32" ? /[\\/]/ : "/").filter(Boolean), ...todo];
  }
  return done;
}

export function isSensitivePath(resolved: string): boolean {
  // Resolve symlinks so a link pointing at a sensitive file cannot bypass the
  // check. That includes a dangling link and a new file under a linked
  // directory: a write follows both, and plain realpath fails on both, which
  // once left only the link's own harmless name to be checked.
  const target = realTarget(resolved);
  for (const candidate of target === resolved ? [resolved] : [resolved, target]) {
    // Compare case-insensitively: Windows and macOS filesystems are
    // case-insensitive, so ".ENV" or "SECRET.PEM" must also be denied.
    const lower = candidate.toLowerCase();
    const base = path.basename(lower);
    if (DENYLIST_NAMES.has(base)) return true;
    if (EXTRA_DENYLIST_NAMES.has(base)) return true;
    // Every dotenv variant (.env, .env.local, .env.production, .env.*.local, …).
    if (base === ".env" || base.startsWith(".env.")) return true;
    if (base.endsWith(".pem") || base.endsWith(".key") || base.endsWith(".p12") || base.endsWith(".pfx")) return true;
    // Cloud credential files and their common real-world naming variants: any
    // "*credentials.json" bundle (gcp-credentials.json, oauth_credentials.json, …),
    // any GCP/Firebase service-account key (service-account.json,
    // gcloud-service-account-prod.json, my-serviceAccountKey.json — already
    // lower-cased above so the separator-optional match also covers camelCase),
    // and Firebase Admin SDK keys (firebase-adminsdk-<id>-<hash>.json).
    if (/credentials\.json$/.test(base)) return true;
    if (/service[-_]?account/.test(base) && base.endsWith(".json")) return true;
    if (base.includes("firebase-adminsdk") && base.endsWith(".json")) return true;
    // A process's environment (/proc/<pid>/environ, and per thread under
    // task/) holds ANTHROPIC_API_KEY and every other exported secret.
    if (/^\/proc\/[^/]+\/(task\/[^/]+\/)?environ$/.test(lower)) return true;
    if (DENYLIST_PREFIXES.some(p => lower === p.toLowerCase() || lower.startsWith(p.toLowerCase() + path.sep))) return true;
  }
  return false;
}

// ─── Regex safety guard ───────────────────────────────────────────────────────
// Reject patterns that are likely to cause catastrophic backtracking (ReDoS).

const REDOS_PATTERNS = [/\(\?.*\)\*/, /\(\.\+\)\+/, /\(.*\+.*\)\+/, /\(\.\*\)\*/];

export function safeRegExp(pattern: string): RegExp | null {
  if (pattern.length > 500) return null;
  if (REDOS_PATTERNS.some(r => r.test(pattern))) return null;
  try { return new RegExp(pattern); } catch { return null; }
}

// ─── Terminal-safe display ───────────────────────────────────────────────────
// Model-chosen text (a command to approve, a file path, a diff, a question, a
// tool's output) is written to a terminal, and a terminal obeys what it is sent.
// A carriage return or an ANSI sequence such as ESC[2K can erase what came
// before it on the line, ESC[8m hides what follows, and a Unicode bidi override
// displays characters in a different order from the one they run in. Any of
// those lets the approval prompt show one command while another runs.
//
// terminalSafe renders every such character as a visible escape (\r, \x1b,
// \u202e) and leaves all other text alone. Newline and tab are kept by default,
// since a multi-line command must still read as several lines.

// Every control character (C0 except tab, DEL, C1), every invisible format
// character (Unicode category Cf: zero-width spaces and joiners, bidi marks,
// embeddings, overrides and isolates, word joiner, BOM, soft hyphen, the tag
// characters U+E0000-E007F that can spell out hidden ASCII, ...), the line and
// paragraph separators U+2028/U+2029, and lone surrogates. Matching by Unicode
// category rather than by a list of ranges leaves none of these out.
const UNSAFE_DISPLAY = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu;

export function terminalSafe(text: string, opts: { keepNewlines?: boolean } = {}): string {
  const keepNewlines = opts.keepNewlines ?? true;
  // A CRLF line ending (Windows command output) cannot hide anything, so it
  // reads as a plain newline; only a \r with more text after it is escaped.
  const src = keepNewlines ? text.replace(/\r\n/g, "\n") : text;
  return src.replace(UNSAFE_DISPLAY, (c) => {
    if (c === "\t") return c;
    if (c === "\n") return keepNewlines ? c : "\\n";
    if (c === "\r") return "\\r";
    const code = c.codePointAt(0) as number;
    if (code <= 0xff) return "\\x" + code.toString(16).padStart(2, "0");
    if (code <= 0xffff) return "\\u" + code.toString(16).padStart(4, "0");
    return "\\u{" + code.toString(16) + "}";
  });
}

// ─── Read File ────────────────────────────────────────────────────────────────

export function readFile(filePath: string, offset?: number, limit?: number): ToolResult {
  try {
    const resolved = path.resolve(filePath);
    if (isSensitivePath(resolved)) {
      return { output: `Error: reading ${path.basename(resolved)} is not permitted (sensitive path).`, isError: true };
    }
    // offset is 1-based and limit is a count, so anything below 1 is outside
    // this tool's domain. Left unchecked they reached Array.slice, where a
    // negative start indexes backwards from the end: read_file(f, -2) returned
    // the LAST lines of the file labelled "-2", "-1", "0" — a confident answer
    // to a question that has none. Refuse instead.
    if (offset != null && (!Number.isInteger(offset) || offset < 1)) {
      return { output: `Error: offset must be an integer >= 1 (lines are 1-based), got ${String(offset)}.`, isError: true };
    }
    if (limit != null && (!Number.isInteger(limit) || limit < 1)) {
      return { output: `Error: limit must be an integer >= 1, got ${String(limit)}.`, isError: true };
    }

    const content = fs.readFileSync(resolved, "utf-8");
    const lines = content.split("\n");

    const start = (offset ?? 1) - 1;
    // An offset past the last line produced an empty output with no error: the
    // model could not tell "there is nothing there" from "the read produced
    // nothing", and an empty string is not a valid tool_result content block.
    if (start >= lines.length) {
      return {
        output: `Error: offset ${start + 1} is past the end of ${path.basename(resolved)} (${lines.length} lines).`,
        isError: true,
      };
    }
    const end = limit != null ? start + limit : lines.length;
    const slice = lines.slice(start, end);

    const numbered = slice
      .map((line, i) => `${String(start + i + 1).padStart(4)}\t${line}`)
      .join("\n");

    return { output: numbered };
  } catch (err) {
    return { output: String(err), isError: true };
  }
}

// ─── Write File ───────────────────────────────────────────────────────────────

export function writeFile(filePath: string, content: string): ToolResult {
  try {
    const resolved = path.resolve(filePath);
    if (isSensitivePath(resolved)) {
      return { output: `Error: writing ${path.basename(resolved)} is not permitted (sensitive path).`, isError: true };
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, "utf-8");
    return { output: `File written: ${resolved}` };
  } catch (err) {
    return { output: String(err), isError: true };
  }
}

// ─── Edit File (string replacement) ──────────────────────────────────────────

export function editFile(
  filePath: string,
  oldString: string,
  newString: string
): ToolResult {
  try {
    const resolved = path.resolve(filePath);
    if (isSensitivePath(resolved)) {
      return { output: `Error: editing ${path.basename(resolved)} is not permitted (sensitive path).`, isError: true };
    }
    const original = fs.readFileSync(resolved, "utf-8");

    if (!original.includes(oldString)) {
      return {
        output: `Error: old_string not found in ${filePath}. Make sure it is unique and exact.`,
        isError: true,
      };
    }

    const count = original.split(oldString).length - 1;
    if (count > 1) {
      return {
        output: `Error: old_string appears ${count} times in ${filePath}. Provide more context to make it unique.`,
        isError: true,
      };
    }

    const updated = original.replace(oldString, newString);
    fs.writeFileSync(resolved, updated, "utf-8");
    return { output: `File edited: ${resolved}` };
  } catch (err) {
    return { output: String(err), isError: true };
  }
}

// ─── Bash ─────────────────────────────────────────────────────────────────────
// Note: execSync with shell: true is intentional here — this tool explicitly
// lets Claude run arbitrary shell commands, which is the point of the bash tool.
// Commands are generated by Claude, not taken directly from user input.

export function runBash(command: string, cwd?: string): ToolResult {
  try {
    const output = execSync(command, {
      cwd: cwd ? path.resolve(cwd) : process.cwd(),
      encoding: "utf-8",
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
    });
    return { output: output.trimEnd() || "(no output)" };
  } catch (err: unknown) {
    if (err && typeof err === "object" && "stdout" in err && "stderr" in err) {
      const e = err as { stdout: string; stderr: string };
      const combined = [e.stdout, e.stderr].filter(Boolean).join("\n");
      return { output: combined || String(err), isError: true };
    }
    return { output: String(err), isError: true };
  }
}

// ─── Glob ─────────────────────────────────────────────────────────────────────

export async function globFiles(
  pattern: string,
  cwd?: string
): Promise<ToolResult> {
  try {
    const base = cwd ? path.resolve(cwd) : process.cwd();
    const entries: string[] = [];

    for await (const entry of glob(pattern, { cwd: base })) {
      entries.push(String(entry));
    }

    entries.sort((a, b) => {
      try {
        const ta = fs.statSync(path.join(base, a)).mtimeMs;
        const tb = fs.statSync(path.join(base, b)).mtimeMs;
        return tb - ta;
      } catch {
        return a.localeCompare(b);
      }
    });

    if (entries.length === 0) return { output: "(no matches)" };
    return { output: entries.join("\n") };
  } catch (err) {
    return { output: String(err), isError: true };
  }
}

// ─── Grep ─────────────────────────────────────────────────────────────────────
// Uses spawnSync to avoid shell injection — pattern and include are passed as
// distinct argv elements rather than interpolated into a shell string.

const GREP_SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".cache", "coverage"]);

export function includeToRegExp(include?: string): RegExp | null {
  if (!include) return null;
  // Translate a simple glob (*.ts, *.{ts,tsx}) into a RegExp over the basename.
  let re = "";
  for (const c of include) {
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "{") re += "(";
    else if (c === "}") re += ")";
    else if (c === ",") re += "|";
    else if (".+^$()|[]\\".includes(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp(`^${re}$`, "i");
}

export function grepFiles(
  pattern: string,
  include?: string,
  cwd?: string
): ToolResult {
  try {
    const base = cwd ? path.resolve(cwd) : process.cwd();
    const re = safeRegExp(pattern);
    if (!re) return { output: "Error: pattern rejected — too long or contains unsafe quantifiers.", isError: true };
    const includeRe = includeToRegExp(include);
    const matches: string[] = [];
    const MAX_MATCHES = 1000;

    const deadline = Date.now() + 10_000; // 10-second wall-clock budget

    const walk = (dir: string): void => {
      if (matches.length >= MAX_MATCHES || Date.now() > deadline) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (matches.length >= MAX_MATCHES || Date.now() > deadline) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (GREP_SKIP_DIRS.has(entry.name)) continue;
          walk(full);
        } else if (entry.isFile()) {
          if (isSensitivePath(full)) continue; // never grep through secrets
          if (includeRe && !includeRe.test(entry.name)) continue;
          let content: string;
          try {
            content = fs.readFileSync(full, "utf-8");
          } catch {
            continue; // unreadable / binary
          }
          const rel = path.relative(base, full) || entry.name;
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              matches.push(`${rel}:${i + 1}:${lines[i]}`);
              if (matches.length >= MAX_MATCHES) break;
            }
          }
        }
      }
    };

    walk(base);
    const timedOut = Date.now() > deadline;
    const suffix = timedOut ? "\n(search timed out — partial results)" : "";
    return { output: matches.length ? matches.join("\n") + suffix : "(no matches)" };
  } catch (err) {
    return { output: String(err), isError: true };
  }
}

// ─── Ask User (human-in-the-loop) ────────────────────────────────────────────

export async function askUser(prompt: string): Promise<ToolResult> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`\n[?] ${terminalSafe(prompt)}\n> `, (answer) => {
      rl.close();
      resolve({ output: answer });
    });
  });
}

// ─── Tool definitions (passed to Claude) ─────────────────────────────────────

export const TOOL_DEFINITIONS = [
  {
    name: "read_file",
    description:
      "Read the contents of a file from the local filesystem, with line numbers. " +
      "Supports offset and limit for large files.",
    input_schema: {
      type: "object" as const,
      properties: {
        file_path: {
          type: "string",
          description: "Absolute or relative path to the file",
        },
        offset: {
          type: "number",
          description: "Line number to start reading from (1-based)",
        },
        limit: {
          type: "number",
          description: "Maximum number of lines to read",
        },
      },
      required: ["file_path"],
    },
  },
  {
    name: "write_file",
    description:
      "Write content to a file, creating it and any missing parent directories. " +
      "Overwrites the file if it already exists.",
    input_schema: {
      type: "object" as const,
      properties: {
        file_path: {
          type: "string",
          description: "Absolute or relative path to the file",
        },
        content: {
          type: "string",
          description: "The full content to write",
        },
      },
      required: ["file_path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Perform an exact string replacement in a file. " +
      "old_string must be unique within the file. " +
      "Use read_file first to find the exact text to replace.",
    input_schema: {
      type: "object" as const,
      properties: {
        file_path: {
          type: "string",
          description: "Absolute or relative path to the file",
        },
        old_string: {
          type: "string",
          description: "The exact text to find (must be unique in the file)",
        },
        new_string: {
          type: "string",
          description: "The text to replace it with",
        },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
  {
    name: "bash",
    description:
      "Execute a shell command. Returns stdout/stderr. " +
      "Timeout is 30 seconds. Prefer non-interactive commands.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description: "The shell command to run",
        },
        cwd: {
          type: "string",
          description: "Working directory for the command (defaults to process cwd)",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "glob",
    description:
      "Find files matching a glob pattern (e.g. **/*.ts, src/**/*.tsx). " +
      "Results are sorted by modification time.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern (e.g. **/*.ts)",
        },
        cwd: {
          type: "string",
          description: "Directory to search in (defaults to process cwd)",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "grep",
    description:
      "Search file contents using a regex pattern. Returns matching lines with file paths and line numbers.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string",
          description: "Regex pattern to search for",
        },
        include: {
          type: "string",
          description: "File glob filter (e.g. *.ts, *.py)",
        },
        cwd: {
          type: "string",
          description: "Directory to search in (defaults to process cwd)",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "ask_user",
    description:
      "Ask the user a question and wait for their response. " +
      "Use this when you need clarification, confirmation before a destructive action, or additional context.",
    input_schema: {
      type: "object" as const,
      properties: {
        prompt: {
          type: "string",
          description: "The question or prompt to show the user",
        },
      },
      required: ["prompt"],
    },
  },
] as const;

// ─── Tool dispatcher ──────────────────────────────────────────────────────────

export async function executeTool(
  name: string,
  input: Record<string, unknown>
): Promise<ToolResult> {
  switch (name) {
    case "read_file":
      return readFile(
        input.file_path as string,
        input.offset as number | undefined,
        input.limit as number | undefined
      );

    case "write_file":
      return writeFile(input.file_path as string, input.content as string);

    case "edit_file":
      return editFile(
        input.file_path as string,
        input.old_string as string,
        input.new_string as string
      );

    case "bash":
      return runBash(input.command as string, input.cwd as string | undefined);

    case "glob":
      return await globFiles(
        input.pattern as string,
        input.cwd as string | undefined
      );

    case "grep":
      return grepFiles(
        input.pattern as string,
        input.include as string | undefined,
        input.cwd as string | undefined
      );

    case "ask_user":
      return await askUser(input.prompt as string);

    default:
      return { output: `Unknown tool: ${name}`, isError: true };
  }
}
