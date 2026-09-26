import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { loadDotenv } from "./env.js";

function dirWithEnv(text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminalagent-env-"));
  fs.writeFileSync(path.join(dir, ".env"), text);
  return dir;
}

test("loadDotenv loads ordinary keys without overriding the shell", () => {
  const env: Record<string, string | undefined> = { MODEL: "from-shell" };
  const r = loadDotenv(dirWithEnv("ANTHROPIC_API_KEY=sk-ant-test-fake\nMODEL=from-file\nMAX_TOKENS=100\n"), env);
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-test-fake");
  assert.equal(env.MODEL, "from-shell");
  assert.equal(env.MAX_TOKENS, "100");
  assert.deepEqual(r.refused, []);
});

test("loadDotenv refuses AUTO_APPROVE from a project .env", () => {
  const env: Record<string, string | undefined> = {};
  const r = loadDotenv(dirWithEnv("AUTO_APPROVE=1\n"), env);
  assert.equal(env.AUTO_APPROVE, undefined);
  assert.deepEqual(r.refused, ["AUTO_APPROVE"]);
});

test("loadDotenv refuses ANTHROPIC_BASE_URL, which would send the key to a server the project chose", () => {
  const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "sk-ant-test-fake" };
  const r = loadDotenv(dirWithEnv("ANTHROPIC_BASE_URL=http://127.0.0.1:9/\n"), env);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.deepEqual(r.refused, ["ANTHROPIC_BASE_URL"]);
});

test("loadDotenv leaves a shell-set shell-only key exactly as the user set it", () => {
  const env: Record<string, string | undefined> = { AUTO_APPROVE: "0" };
  loadDotenv(dirWithEnv("AUTO_APPROVE=1\n"), env);
  assert.equal(env.AUTO_APPROVE, "0");
});

test("loadDotenv is a no-op without a .env", () => {
  const env: Record<string, string | undefined> = {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminalagent-env-"));
  assert.deepEqual(loadDotenv(dir, env), { refused: [] });
  assert.deepEqual(env, {});
});

test("loadDotenv refuses shell-only keys in any letter case (process.env is case-insensitive on Windows)", () => {
  const env: Record<string, string | undefined> = {};
  const r = loadDotenv(dirWithEnv("auto_approve=1\nAnthropic_Base_Url=http://127.0.0.1:9/\n"), env);
  assert.deepEqual(env, {});
  assert.deepEqual(r.refused, ["auto_approve", "Anthropic_Base_Url"]);
});
