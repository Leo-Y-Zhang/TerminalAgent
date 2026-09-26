import fs from "fs";
import path from "path";

// Configuration for a TerminalAgent session, resolved from (in increasing precedence)
// built-in defaults, a project-local .mentorrc.json, and environment variables.
//
// NAMING: the on-disk names `.mentorrc.json`, `MENTOR.md` and `.mentor/` predate
// the project's rename from Mentor to TerminalAgent and are deliberately KEPT.
// They are a data contract, not a label: changing them would silently orphan
// every existing config file, project-memory file, saved session and checkpoint
// store in every directory this tool has ever run in. That is a breaking change
// that belongs in a major release with a read-the-old-name fallback, not in a
// documentation pass. See docs/TDD.md.

export interface TerminalAgentConfig {
  model: string;
  maxTokens: number;
  autoApprove: boolean;
  /** Extra filenames (basename match) to add to the sensitive-path denylist. */
  extraDenylist: string[];
  /** How many turns of file checkpoints to keep for /undo and /changes. */
  checkpointTurns: number;
  /** Auto-compact when context reaches this fraction of the usable window (0 disables). */
  autoCompactThreshold: number;
}

export const DEFAULT_MODEL = "claude-sonnet-4-6";

export const DEFAULT_CONFIG: TerminalAgentConfig = {
  model: DEFAULT_MODEL,
  maxTokens: 64_000,
  autoApprove: false,
  extraDenylist: [],
  checkpointTurns: 20,
  autoCompactThreshold: 0.8,
};

// Cap on project-context size injected into the system prompt.
const MAX_PROJECT_CONTEXT = 16_000;

/** Parse the raw text of a .mentorrc.json into a partial config, fail-loud. */
export function parseConfigFile(text: string): Partial<TerminalAgentConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid .mentorrc.json: not valid JSON (${String(err)})`, { cause: err });
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid .mentorrc.json: expected a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const out: Partial<TerminalAgentConfig> = {};

  if ("model" in obj) {
    if (typeof obj.model !== "string") throw new Error("Invalid config: model must be a string");
    out.model = obj.model;
  }
  if ("maxTokens" in obj) {
    if (typeof obj.maxTokens !== "number" || !Number.isFinite(obj.maxTokens) || obj.maxTokens <= 0) {
      throw new Error("Invalid config: maxTokens must be a positive number");
    }
    out.maxTokens = obj.maxTokens;
  }
  if ("autoApprove" in obj) {
    if (typeof obj.autoApprove !== "boolean") throw new Error("Invalid config: autoApprove must be a boolean");
    // .mentorrc.json lives in the project directory, which is often a
    // repository somebody else wrote. Honouring `true` here let a cloned repo
    // switch off the confirmation gate for every shell command and file write
    // the model proposes, and in one-shot mode without so much as a banner.
    // Only the user can opt out of confirmation, from their own shell (--yes or
    // AUTO_APPROVE=1). `false` is harmless and still accepted.
    if (obj.autoApprove) {
      throw new Error(
        "Invalid config: autoApprove: true is not accepted from .mentorrc.json, because a file in the " +
          "project must not be able to switch off confirmation. Pass --yes or set AUTO_APPROVE=1 in your shell instead."
      );
    }
    out.autoApprove = obj.autoApprove;
  }
  if ("extraDenylist" in obj) {
    if (!Array.isArray(obj.extraDenylist) || obj.extraDenylist.some((e) => typeof e !== "string")) {
      throw new Error("Invalid config: extraDenylist must be an array of strings");
    }
    out.extraDenylist = obj.extraDenylist as string[];
  }
  if ("checkpointTurns" in obj) {
    if (typeof obj.checkpointTurns !== "number" || !Number.isInteger(obj.checkpointTurns) || obj.checkpointTurns <= 0) {
      throw new Error("Invalid config: checkpointTurns must be a positive integer");
    }
    out.checkpointTurns = obj.checkpointTurns;
  }
  if ("autoCompactThreshold" in obj) {
    if (
      typeof obj.autoCompactThreshold !== "number" ||
      !Number.isFinite(obj.autoCompactThreshold) ||
      obj.autoCompactThreshold < 0 ||
      obj.autoCompactThreshold >= 1
    ) {
      throw new Error(
        "Invalid config: autoCompactThreshold must be a number >= 0 and < 1 (0 disables auto-compact)"
      );
    }
    out.autoCompactThreshold = obj.autoCompactThreshold;
  }
  return out;
}

/** Resolve the effective config from a config file (if present) and env vars. */
export function loadConfig(cwd: string, env: Record<string, string | undefined>): TerminalAgentConfig {
  const cfg: TerminalAgentConfig = { ...DEFAULT_CONFIG };

  // Layer 1: the config file.
  const file = path.join(cwd, ".mentorrc.json");
  if (fs.existsSync(file)) {
    const parsed = parseConfigFile(fs.readFileSync(file, "utf-8"));
    Object.assign(cfg, parsed);
  }

  // Layer 2: environment variables (highest precedence).
  if (env.MODEL) cfg.model = env.MODEL;
  if (env.MAX_TOKENS != null && env.MAX_TOKENS !== "") {
    const n = Number(env.MAX_TOKENS);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`Invalid MAX_TOKENS environment variable: ${env.MAX_TOKENS}`);
    }
    cfg.maxTokens = n;
  }
  // Explicitly-set AUTO_APPROVE wins in BOTH directions, so a user can re-enable
  // the confirmation gate over a config-file autoApprove:true. Unset/empty keeps
  // the file value.
  if (env.AUTO_APPROVE != null && env.AUTO_APPROVE !== "") {
    const v = env.AUTO_APPROVE.trim().toLowerCase();
    cfg.autoApprove = v === "1" || v === "true" || v === "yes";
  }

  return cfg;
}

/** Load project memory (MENTOR.md, else AGENTS.md) from cwd, bounded in size. */
export function loadProjectContext(cwd: string): string | null {
  for (const name of ["MENTOR.md", "AGENTS.md"]) {
    const file = path.join(cwd, name);
    let content: string;
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch {
      continue; // not present / unreadable — try the next candidate
    }
    if (content.length > MAX_PROJECT_CONTEXT) {
      content =
        content.slice(0, MAX_PROJECT_CONTEXT) +
        `\n\n… (${name} truncated at ${MAX_PROJECT_CONTEXT} characters)`;
    }
    return content;
  }
  return null;
}
