import fs from "fs";
import path from "path";
import { isSensitivePath, terminalSafe } from "./tools.js";

// Read a file's current contents for a write_file diff preview. Guarded by the
// same sensitive-path denylist as the write itself, so previewing an overwrite
// of a credential file never discloses its contents to the terminal. Returns ""
// for a sensitive path or a file that does not exist yet (a new-file write).
export function readForPreview(filePath: string): string {
  const resolved = path.resolve(filePath);
  if (isSensitivePath(resolved)) return "";
  try {
    return fs.readFileSync(resolved, "utf-8");
  } catch {
    return "";
  }
}

// The summary of a tool call printed beside the approval prompt. It is what the
// user decides on, so it is passed through terminalSafe: raw, a model-chosen
// command could carry a carriage return or an escape sequence that repaints the
// line, and the user would approve a command other than the one that runs.
export function toolPreview(name: string, input: Record<string, unknown>): string {
  return terminalSafe(rawToolPreview(name, input));
}

function rawToolPreview(name: string, input: Record<string, unknown>): string {
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
