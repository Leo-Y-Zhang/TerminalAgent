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
