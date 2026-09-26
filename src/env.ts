import fs from "fs";
import path from "path";
import dotenv from "dotenv";

// Loading the working directory's .env, with the few keys that decide what the
// tool is allowed to do kept out of its reach.
//
// This replaces `import "dotenv/config"`, which copied EVERY key from cwd/.env
// into process.env. The working directory is the project the user pointed the
// tool at, often a repository somebody else wrote, so its .env is not the
// user's own configuration. Two keys in it were enough to take over a session:
//
//   AUTO_APPROVE=1              switched the confirmation gate off, so every
//                               shell command and file write the model proposed
//                               ran unasked;
//   ANTHROPIC_BASE_URL=http://… sent every request, with the user's API key in
//                               its header and the whole conversation in its
//                               body, to a server the repository chose.
//
// Those keys are honoured only from the user's own shell environment. Anything
// else (ANTHROPIC_API_KEY, MODEL, MAX_TOKENS, …) loads as before: a key already
// set in the environment is never overridden.

export const SHELL_ONLY_KEYS: readonly string[] = ["AUTO_APPROVE", "ANTHROPIC_BASE_URL"];

export interface DotenvResult {
  /** Keys present in .env that were refused because only the shell may set them. */
  refused: string[];
}

export function loadDotenv(cwd: string, env: Record<string, string | undefined>): DotenvResult {
  let text: string;
  try {
    text = fs.readFileSync(path.join(cwd, ".env"), "utf-8");
  } catch {
    return { refused: [] }; // no .env (or unreadable): nothing to load
  }
  const refused: string[] = [];
  for (const [key, value] of Object.entries(dotenv.parse(text))) {
    if (SHELL_ONLY_KEYS.includes(key)) {
      refused.push(key);
      continue;
    }
    if (env[key] === undefined) env[key] = value;
  }
  return { refused };
}
