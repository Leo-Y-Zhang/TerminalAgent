import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { readForPreview, toolPreview } from "./preview.js";
import { isSensitivePath, terminalSafe } from "./tools.js";

test("readForPreview returns file contents for an ordinary file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminalagent-prev-"));
  const file = path.join(dir, "notes.txt");
  fs.writeFileSync(file, "hello\nworld");
  assert.equal(readForPreview(file), "hello\nworld");
});

test("readForPreview never reads a sensitive path (no secret disclosure in the diff)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminalagent-prev-"));
  const secret = path.join(dir, ".env.production");
  fs.writeFileSync(secret, "DB_PASSWORD=hunter2\nAPI_KEY=sk-secret");
  assert.equal(isSensitivePath(secret), true);
  assert.equal(readForPreview(secret), ""); // suppressed — its contents are never returned
});

test("readForPreview returns empty for a nonexistent file (new-file write)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminalagent-prev-"));
  assert.equal(readForPreview(path.join(dir, "does-not-exist.ts")), "");
});

// ─── toolPreview: what the user approves is what runs ─────────────────────────
// The preview is written raw to a terminal. A command carrying a carriage
// return or an escape sequence can repaint the line, so the user reads a
// harmless command while approving a different one.

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;

test("toolPreview cannot be repainted by a carriage return or an escape sequence", () => {
  const cmd = "rm -rf ~/project\r\u001b[2Kls -la";
  const shown = toolPreview("bash", { command: cmd });
  assert.doesNotMatch(shown, CONTROL);
  assert.match(shown, /rm -rf ~\/project/);
  assert.match(shown, /\\r/);
  assert.match(shown, /\\x1b\[2K/);
});

test("toolPreview makes bidi overrides visible (Trojan Source in a command or path)", () => {
  const shown = toolPreview("bash", { command: "echo \u202eftp.sh; bash evil" });
  assert.doesNotMatch(shown, CONTROL);
  assert.match(shown, /\\u202e/);
  assert.doesNotMatch(toolPreview("write_file", { file_path: "src/\u202egnp.sh" }), CONTROL);
  assert.doesNotMatch(toolPreview("bash", { command: "ls", cwd: "/tmp\u001b[8m" }), CONTROL);
});

test("toolPreview keeps a multi-line command on separate, visible lines", () => {
  // A newline is a command separator, so the second command must be SHOWN as
  // a second line rather than hidden or merged into the first.
  const shown = toolPreview("bash", { command: "ls\nrm -rf build\tx" });
  assert.equal(shown, "ls\nrm -rf build\tx");
});

test("toolPreview leaves ordinary text, including non-ASCII, untouched", () => {
  assert.equal(toolPreview("bash", { command: "echo 'héllo 𝕦 💥'" }), "echo 'héllo 𝕦 💥'");
  assert.equal(toolPreview("read_file", { file_path: "src/app.ts" }), "src/app.ts");
});

test("terminalSafe escapes C1 controls and DEL but keeps newline and tab", () => {
  assert.equal(terminalSafe("a\u009bb\u007fc\n\td"), "a\\x9bb\\x7fc\n\td");
  assert.equal(terminalSafe("x\u0007y", { keepNewlines: false }), "x\\x07y");
  assert.equal(terminalSafe("x\ny", { keepNewlines: false }), "x\\ny");
});

test("terminalSafe reads a CRLF line ending as a newline but escapes a bare CR", () => {
  assert.equal(terminalSafe("a\r\nb\r\n"), "a\nb\n");
  assert.equal(terminalSafe("safe\rrm -rf ~"), "safe\\rrm -rf ~");
  assert.equal(terminalSafe("a\r\nb", { keepNewlines: false }), "a\\r\\nb");
});

// A repository can ship a symlink. Approving a write to "docs/notes.md" must not
// silently mean writing to wherever that link points, such as a shell rc file.
test("toolPreview names the real target of a write through a symlink", { skip: process.platform === "win32" }, () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "terminalagent-prev-")));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "terminalagent-outside-")));
  fs.writeFileSync(path.join(outside, "rcfile"), "x");
  fs.symlinkSync(path.join(outside, "rcfile"), path.join(dir, "notes.md"));
  fs.symlinkSync(outside, path.join(dir, "docs"));

  const viaFile = toolPreview("write_file", { file_path: path.join(dir, "notes.md"), content: "" });
  assert.match(viaFile, new RegExp(`resolves to ${path.join(outside, "rcfile").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  // A new file under a symlinked directory: the link is in the parent.
  const viaDir = toolPreview("edit_file", { file_path: path.join(dir, "docs", "new.txt") });
  assert.match(viaDir, /resolves to /);
  assert.ok(viaDir.includes(path.join(outside, "new.txt")));
  // A dangling link: the write would create its target.
  fs.symlinkSync(path.join(outside, "autostart.desktop"), path.join(dir, "readme.txt"));
  assert.ok(toolPreview("write_file", { file_path: path.join(dir, "readme.txt") }).includes(`resolves to ${path.join(outside, "autostart.desktop")}`));
  // No link, no note.
  assert.equal(toolPreview("write_file", { file_path: path.join(dir, "plain.txt") }), path.join(dir, "plain.txt"));
});

test("toolPreview names where a relative link climbing out of a linked directory lands", { skip: process.platform === "win32" }, () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "terminalagent-prev-")));
  try {
    fs.mkdirSync(path.join(dir, "outside", "inner"), { recursive: true });
    fs.mkdirSync(path.join(dir, "repo"));
    fs.symlinkSync(path.join(dir, "outside", "inner"), path.join(dir, "repo", "d"));
    fs.symlinkSync("d/../rcfile", path.join(dir, "repo", "notes.md"));
    const shown = toolPreview("write_file", { file_path: path.join(dir, "repo", "notes.md") });
    assert.ok(shown.endsWith(`(resolves to ${path.join(dir, "outside", "rcfile")})`), shown);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("terminalSafe escapes every invisible format character, not only a listed few", () => {
  // Soft hyphen, Mongolian vowel separator, deprecated format controls, line and
  // paragraph separators, and tag characters (invisible ASCII look-alikes).
  assert.equal(
    terminalSafe("a­b᠎c⁪d e f\u{E0041}\u{E0042}g"),
    "a\\xadb\\u180ec\\u206ad\\u2028e\\u2029f\\u{e0041}\\u{e0042}g"
  );
  assert.equal(terminalSafe("tab\tstays"), "tab\tstays");
  assert.equal(terminalSafe("tab\tstays", { keepNewlines: false }), "tab\tstays");
});
