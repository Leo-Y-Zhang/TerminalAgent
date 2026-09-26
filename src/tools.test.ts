import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  safeRegExp,
  includeToRegExp,
  isSensitivePath,
  configureExtraDenylist,
  readFile,
  writeFile,
  editFile,
  realTarget,
} from "./tools.js";

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ccc-test-"));
}

// ─── safeRegExp ───────────────────────────────────────────────────────────────

test("safeRegExp compiles a safe pattern", () => {
  const re = safeRegExp("foo\\d+");
  assert.ok(re instanceof RegExp);
  assert.ok(re!.test("foo123"));
  assert.ok(!re!.test("bar"));
});

test("safeRegExp rejects overly long patterns", () => {
  assert.equal(safeRegExp("a".repeat(501)), null);
});

test("safeRegExp rejects catastrophic-backtracking patterns", () => {
  assert.equal(safeRegExp("(.*)*"), null);
  assert.equal(safeRegExp("(.+)+"), null);
});

test("safeRegExp returns null for an invalid regex", () => {
  assert.equal(safeRegExp("("), null);
});

// ─── includeToRegExp ──────────────────────────────────────────────────────────

test("includeToRegExp returns null when no include is given", () => {
  assert.equal(includeToRegExp(undefined), null);
});

test("includeToRegExp translates a simple glob", () => {
  const re = includeToRegExp("*.ts")!;
  assert.ok(re.test("index.ts"));
  assert.ok(!re.test("index.js"));
});

test("includeToRegExp handles brace alternation", () => {
  const re = includeToRegExp("*.{ts,tsx}")!;
  assert.ok(re.test("app.ts"));
  assert.ok(re.test("app.tsx"));
  assert.ok(!re.test("app.js"));
});

// ─── isSensitivePath ──────────────────────────────────────────────────────────

test("isSensitivePath flags denylisted names, extensions and prefixes", () => {
  assert.equal(isSensitivePath(path.resolve(os.tmpdir(), ".env")), true);
  assert.equal(isSensitivePath(path.resolve(os.tmpdir(), "secret.pem")), true);
  assert.equal(isSensitivePath(path.resolve(os.tmpdir(), "server.key")), true);
  assert.equal(isSensitivePath(path.join(os.homedir(), ".ssh", "id_ed25519")), true);
});

test("isSensitivePath allows an ordinary file", () => {
  assert.equal(isSensitivePath(path.resolve(os.tmpdir(), "notes.txt")), false);
});

test("isSensitivePath flags credential-file siblings and variants", () => {
  for (const f of [
    ".env.development.local",
    ".env.staging",
    ".env.test",
    ".git-credentials",
    ".npmrc",
    ".pgpass",
    ".pypirc",
    ".netrc",
  ]) {
    assert.equal(isSensitivePath(path.resolve(os.tmpdir(), f)), true, f);
  }
});

test("isSensitivePath flags cloud credential files and their common naming variants", () => {
  for (const f of [
    "credentials.json",
    "service-account.json",
    "service_account.json",
    "gcp-credentials.json",
    "oauth_credentials.json",
    "gcloud-service-account-prod.json",
    "firebase-adminsdk-abc123-def456.json",
    "my-serviceAccountKey.json",
    "SERVICE-ACCOUNT.JSON", // case-insensitive, like the built-in denylist
  ]) {
    assert.equal(isSensitivePath(path.resolve(os.tmpdir(), f)), true, f);
  }
});

// A process's environment is a credential file in all but name: it holds
// ANTHROPIC_API_KEY and whatever else the shell exported. read_file needs no
// approval, so reading it put every one of those secrets into the conversation
// (and into any session saved from it) without the user being asked.
test("isSensitivePath flags process environment files under /proc", () => {
  for (const p of ["/proc/self/environ", "/proc/1/environ", "/proc/self/task/42/environ", "/PROC/SELF/ENVIRON"]) {
    assert.equal(isSensitivePath(p), true, p);
  }
  assert.equal(isSensitivePath("/proc/self/status"), false);
  assert.equal(isSensitivePath(path.resolve(os.tmpdir(), "environ")), false);
});

test("readFile refuses /proc/self/environ", { skip: process.platform !== "linux" }, () => {
  const r = readFile("/proc/self/environ");
  assert.equal(r.isError, true);
  assert.match(r.output, /not permitted/);
});

test("configureExtraDenylist extends the denied filenames", () => {
  const target = path.resolve(os.tmpdir(), "company-secrets.json");
  assert.equal(isSensitivePath(target), false);
  configureExtraDenylist(["company-secrets.json"]);
  try {
    assert.equal(isSensitivePath(target), true);
    // case-insensitive, like the built-in denylist
    assert.equal(isSensitivePath(path.resolve(os.tmpdir(), "COMPANY-SECRETS.JSON")), true);
  } finally {
    configureExtraDenylist([]); // reset so other tests are unaffected
  }
});

// ─── readFile offset/limit numbering ──────────────────────────────────────────

test("readFile numbers lines using offset and limit", () => {
  const dir = mkTmpDir();
  try {
    const file = path.join(dir, "sample.txt");
    fs.writeFileSync(file, "l1\nl2\nl3\nl4\nl5\n", "utf-8");
    const res = readFile(file, 2, 2);
    assert.equal(res.isError, undefined);
    const lines = res.output.split("\n");
    assert.equal(lines.length, 2);
    assert.equal(lines[0], "   2\tl2");
    assert.equal(lines[1], "   3\tl3");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readFile refuses an out-of-domain offset instead of renumbering the file", () => {
  const dir = mkTmpDir();
  try {
    const file = path.join(dir, "sample.txt");
    fs.writeFileSync(file, "l1\nl2\nl3\nl4\nl5\n", "utf-8");
    // offset is 1-based. A zero or negative offset used to index backwards from
    // the end of the array, so the last lines of the file came back labelled
    // "-2", "-1", "0" — a confident answer to a question that has none.
    for (const bad of [0, -2, 1.5]) {
      const res = readFile(file, bad);
      assert.equal(res.isError, true, `offset ${bad}`);
      assert.match(res.output, /offset/i);
      assert.doesNotMatch(res.output, /l4|l5/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readFile refuses a non-positive limit", () => {
  const dir = mkTmpDir();
  try {
    const file = path.join(dir, "sample.txt");
    fs.writeFileSync(file, "l1\nl2\nl3\n", "utf-8");
    for (const bad of [0, -1, 2.5]) {
      const res = readFile(file, 1, bad);
      assert.equal(res.isError, true, `limit ${bad}`);
      assert.match(res.output, /limit/i);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readFile says so when the offset is past the end of the file", () => {
  const dir = mkTmpDir();
  try {
    const file = path.join(dir, "sample.txt");
    fs.writeFileSync(file, "l1\nl2\nl3\n", "utf-8");
    // Silence is the worst answer here: the model cannot tell "there is nothing
    // there" from "the read produced nothing", and an empty tool_result is not
    // a valid content block.
    const res = readFile(file, 99);
    assert.equal(res.isError, true);
    assert.notEqual(res.output, "");
    assert.match(res.output, /past the end/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── editFile error paths ─────────────────────────────────────────────────────

test("editFile reports when old_string is not found", () => {
  const dir = mkTmpDir();
  try {
    const file = path.join(dir, "edit.txt");
    fs.writeFileSync(file, "hello world", "utf-8");
    const res = editFile(file, "goodbye", "hi");
    assert.equal(res.isError, true);
    assert.match(res.output, /not found/);
    assert.equal(fs.readFileSync(file, "utf-8"), "hello world");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("editFile refuses a non-unique old_string", () => {
  const dir = mkTmpDir();
  try {
    const file = path.join(dir, "edit.txt");
    fs.writeFileSync(file, "foo foo", "utf-8");
    const res = editFile(file, "foo", "bar");
    assert.equal(res.isError, true);
    assert.match(res.output, /appears 2 times/);
    assert.equal(fs.readFileSync(file, "utf-8"), "foo foo");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── write/edit security gap ──────────────────────────────────────────────────

test("writeFile refuses to write to a sensitive path", () => {
  const dir = mkTmpDir();
  try {
    const file = path.join(dir, "secret.pem");
    const res = writeFile(file, "-----BEGIN PRIVATE KEY-----");
    assert.equal(res.isError, true);
    assert.match(res.output, /not permitted/);
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("editFile refuses to edit a sensitive path", () => {
  const dir = mkTmpDir();
  try {
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, "SECRET=1", "utf-8");
    const res = editFile(file, "SECRET=1", "SECRET=2");
    assert.equal(res.isError, true);
    assert.match(res.output, /not permitted/);
    assert.equal(fs.readFileSync(file, "utf-8"), "SECRET=1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// realpath fails on a dangling symlink exactly as on a missing file, so the
// denylist used to check only the link's own name, and writeFileSync then
// followed the link and CREATED the credential file it pointed at.
test("writeFile refuses a dangling symlink whose target is a sensitive path", { skip: process.platform === "win32" }, () => {
  const dir = mkTmpDir();
  try {
    const target = path.join(dir, "keys", "id_ed25519");
    fs.mkdirSync(path.dirname(target));
    const link = path.join(dir, "notes.md");
    fs.symlinkSync(target, link);
    assert.equal(isSensitivePath(link), true);
    const res = writeFile(link, "attacker key");
    assert.equal(res.isError, true);
    assert.match(res.output, /not permitted/);
    assert.equal(fs.existsSync(target), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A link's target is followed the way the kernel follows it: a ".." in it steps
// out of the directory a linked parent REALLY points into. Resolved lexically,
// "L -> d/../id_ed25519" with d linked into a key directory read as a harmless
// sibling of L, so the write was allowed and created the key file.
test("writeFile refuses a dangling link whose target climbs out of a linked directory", { skip: process.platform === "win32" }, () => {
  const dir = fs.realpathSync(mkTmpDir());
  try {
    const keys = path.join(dir, "home", "keys", "sub");
    fs.mkdirSync(keys, { recursive: true });
    const repo = path.join(dir, "repo");
    fs.mkdirSync(repo);
    fs.symlinkSync(keys, path.join(repo, "d"));
    const link = path.join(repo, "notes.md");
    fs.symlinkSync("d/../id_ed25519", link);
    const landing = path.join(dir, "home", "keys", "id_ed25519");
    assert.equal(realTarget(link), landing);
    assert.equal(isSensitivePath(link), true);
    const res = writeFile(link, "attacker key");
    assert.equal(res.isError, true);
    assert.equal(fs.existsSync(landing), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("realTarget follows a chain of relative dangling links and stops on a loop", { skip: process.platform === "win32" }, () => {
  const dir = fs.realpathSync(mkTmpDir());
  try {
    fs.mkdirSync(path.join(dir, "a", "b"), { recursive: true });
    fs.symlinkSync("b/two", path.join(dir, "a", "one"));
    fs.symlinkSync("../three", path.join(dir, "a", "b", "two"));
    assert.equal(realTarget(path.join(dir, "a", "one")), path.join(dir, "a", "three"));
    fs.symlinkSync("loop2", path.join(dir, "loop1"));
    fs.symlinkSync("loop1", path.join(dir, "loop2"));
    assert.equal(typeof realTarget(path.join(dir, "loop1")), "string");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
