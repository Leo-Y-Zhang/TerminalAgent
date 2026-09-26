import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { parseConfigFile, loadConfig, loadProjectContext, DEFAULT_CONFIG } from "./config.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "terminalagent-cfg-"));
}

// ─── parseConfigFile ──────────────────────────────────────────────────────────

test("parseConfigFile reads a full config", () => {
  const cfg = parseConfigFile('{"model":"m","maxTokens":100,"autoApprove":false,"extraDenylist":["a.json"]}');
  assert.deepEqual(cfg, { model: "m", maxTokens: 100, autoApprove: false, extraDenylist: ["a.json"] });
});

test("parseConfigFile refuses autoApprove: true, since a project file must not disable confirmation", () => {
  assert.throws(() => parseConfigFile('{"autoApprove":true}'), /autoApprove.*--yes|AUTO_APPROVE/s);
});

test("parseConfigFile accepts a partial config", () => {
  assert.deepEqual(parseConfigFile("{}"), {});
  assert.deepEqual(parseConfigFile('{"model":"x"}'), { model: "x" });
});

test("parseConfigFile fails loud on malformed JSON", () => {
  assert.throws(() => parseConfigFile("not json"), /config|json/i);
});

test("parseConfigFile fails loud on wrong types", () => {
  assert.throws(() => parseConfigFile('{"maxTokens":"abc"}'), /maxTokens/);
  assert.throws(() => parseConfigFile('{"extraDenylist":"x"}'), /extraDenylist/);
  assert.throws(() => parseConfigFile('{"autoApprove":"yes"}'), /autoApprove/);
});

test("parseConfigFile reads checkpointTurns and validates it strictly", () => {
  assert.deepEqual(parseConfigFile('{"checkpointTurns":5}'), { checkpointTurns: 5 });
  assert.throws(() => parseConfigFile('{"checkpointTurns":"many"}'), /checkpointTurns/);
  assert.throws(() => parseConfigFile('{"checkpointTurns":0}'), /checkpointTurns/);
  assert.throws(() => parseConfigFile('{"checkpointTurns":-3}'), /checkpointTurns/);
  assert.throws(() => parseConfigFile('{"checkpointTurns":2.5}'), /checkpointTurns/);
});

test("parseConfigFile reads autoCompactThreshold and validates it strictly", () => {
  assert.deepEqual(parseConfigFile('{"autoCompactThreshold":0.5}'), { autoCompactThreshold: 0.5 });
  assert.deepEqual(parseConfigFile('{"autoCompactThreshold":0}'), { autoCompactThreshold: 0 }); // 0 disables
  assert.throws(() => parseConfigFile('{"autoCompactThreshold":"most"}'), /autoCompactThreshold/);
  assert.throws(() => parseConfigFile('{"autoCompactThreshold":1}'), /autoCompactThreshold/);
  assert.throws(() => parseConfigFile('{"autoCompactThreshold":1.5}'), /autoCompactThreshold/);
  assert.throws(() => parseConfigFile('{"autoCompactThreshold":-0.1}'), /autoCompactThreshold/);
});

test("autoCompactThreshold defaults to a sensible fraction and loads from the file", () => {
  assert.ok(DEFAULT_CONFIG.autoCompactThreshold > 0 && DEFAULT_CONFIG.autoCompactThreshold < 1);
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, ".mentorrc.json"), '{"autoCompactThreshold":0.5}');
  assert.equal(loadConfig(dir, {}).autoCompactThreshold, 0.5);
});

test("checkpointTurns defaults to a sensible positive integer", () => {
  assert.ok(Number.isInteger(DEFAULT_CONFIG.checkpointTurns) && DEFAULT_CONFIG.checkpointTurns > 0);
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, ".mentorrc.json"), '{"checkpointTurns":7}');
  assert.equal(loadConfig(dir, {}).checkpointTurns, 7);
});

// ─── loadConfig ───────────────────────────────────────────────────────────────

test("loadConfig returns defaults when no file and no env", () => {
  const cfg = loadConfig(tmpDir(), {});
  assert.deepEqual(cfg, DEFAULT_CONFIG);
});

test("loadConfig reads a .mentorrc.json file", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, ".mentorrc.json"), '{"model":"file-model","maxTokens":123}');
  const cfg = loadConfig(dir, {});
  assert.equal(cfg.model, "file-model");
  assert.equal(cfg.maxTokens, 123);
  assert.equal(cfg.autoApprove, DEFAULT_CONFIG.autoApprove);
});

test("environment variables win over the config file", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, ".mentorrc.json"), '{"model":"file-model"}');
  const cfg = loadConfig(dir, { MODEL: "env-model", AUTO_APPROVE: "1", MAX_TOKENS: "999" });
  assert.equal(cfg.model, "env-model");
  assert.equal(cfg.autoApprove, true);
  assert.equal(cfg.maxTokens, 999);
});

test("loadConfig fails loud on an invalid MAX_TOKENS env", () => {
  assert.throws(() => loadConfig(tmpDir(), { MAX_TOKENS: "not-a-number" }), /MAX_TOKENS/);
});

test("AUTO_APPROVE env can both enable and DISABLE auto-approve", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, ".mentorrc.json"), '{"autoApprove":false}');
  assert.equal(loadConfig(dir, {}).autoApprove, false); // unset keeps the file value
  assert.equal(loadConfig(dir, { AUTO_APPROVE: "1" }).autoApprove, true);
  assert.equal(loadConfig(dir, { AUTO_APPROVE: "0" }).autoApprove, false);
  assert.equal(loadConfig(dir, { AUTO_APPROVE: "false" }).autoApprove, false);
});

test("a project .mentorrc.json asking for autoApprove: true fails loud, whatever the env says", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, ".mentorrc.json"), '{"autoApprove":true}');
  assert.throws(() => loadConfig(dir, {}), /autoApprove/);
  assert.throws(() => loadConfig(dir, { AUTO_APPROVE: "1" }), /autoApprove/);
});

test("loadConfig fails loud on a malformed config file", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, ".mentorrc.json"), "{ broken");
  assert.throws(() => loadConfig(dir, {}), /config|json/i);
});

// ─── loadProjectContext ───────────────────────────────────────────────────────

test("loadProjectContext returns null when no memory file exists", () => {
  assert.equal(loadProjectContext(tmpDir()), null);
});

test("loadProjectContext reads MENTOR.md", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "MENTOR.md"), "# House rules\nUse tabs.");
  const ctx = loadProjectContext(dir);
  assert.ok(ctx && ctx.includes("House rules"));
});

test("loadProjectContext falls back to AGENTS.md", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "agents content");
  assert.ok(loadProjectContext(dir)?.includes("agents content"));
});

test("MENTOR.md takes precedence over AGENTS.md", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "MENTOR.md"), "project memory wins");
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "agents loses");
  assert.ok(loadProjectContext(dir)?.includes("project memory wins"));
});

test("loadProjectContext truncates an oversized file with a notice", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "MENTOR.md"), "x".repeat(50_000));
  const ctx = loadProjectContext(dir);
  assert.ok(ctx);
  assert.ok(ctx.length < 50_000);
  assert.match(ctx, /truncated/i);
});
