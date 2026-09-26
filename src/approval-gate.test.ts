import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "child_process";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

// End-to-end checks on the confirmation gate, driving the REAL built CLI
// (dist/index.js) in one-shot mode against a local stand-in for the Messages
// API. Nothing leaves the machine and no real key is used: the SDK honours
// ANTHROPIC_BASE_URL, which the test sets in the child's real environment.
//
// The scripted model asks, once, to run a shell command that creates a marker
// file. One-shot mode has no prompt to answer, so the command may only run when
// the USER opted in (--yes or AUTO_APPROVE in their own shell). Whether the
// marker exists afterwards is the whole verdict.

const CLI = fileURLToPath(new URL("./index.js", import.meta.url));
const MARKER = "gate-marker.txt";

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function streamReply(res: http.ServerResponse, toolUse: boolean): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(
    sse("message_start", {
      type: "message_start",
      message: {
        id: "msg_gate",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }),
  );
  if (toolUse) {
    res.write(
      sse("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_gate_1", name: "bash", input: {} },
      }),
    );
    res.write(
      sse("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: `echo ran > ${MARKER}` }) },
      }),
    );
    res.write(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
  } else {
    res.write(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    res.write(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }));
    res.write(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
  }
  res.write(
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: toolUse ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 0 },
    }),
  );
  res.write(sse("message_stop", { type: "message_stop" }));
  res.end();
}

async function withFakeApi<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const messages = (JSON.parse(body).messages ?? []) as { content: unknown }[];
      const last = messages[messages.length - 1];
      const answered =
        Array.isArray(last?.content) && last.content.some((b: { type?: string }) => b.type === "tool_result");
      streamReply(res, !answered);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

interface RunResult {
  code: number | null;
  stderr: string;
  ran: boolean;
}

/** Run `terminal-agent -p go [...extra]` in a fresh directory seeded with `files`. */
async function runCli(
  files: Record<string, string>,
  shellEnv: Record<string, string> = {},
  extraArgs: string[] = [],
): Promise<RunResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminalagent-gate-"));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  try {
    return await withFakeApi(async (baseUrl) => {
      // Start from a clean environment so a developer's own AUTO_APPROVE or
      // ANTHROPIC_* variables cannot leak into the verdict.
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v === undefined || k === "AUTO_APPROVE" || k === "MODEL" || k === "MAX_TOKENS") continue;
        if (k.startsWith("ANTHROPIC_")) continue;
        env[k] = v;
      }
      Object.assign(env, { ANTHROPIC_API_KEY: "sk-ant-test-not-a-real-key", ANTHROPIC_BASE_URL: baseUrl }, shellEnv);
      const child = spawn(process.execPath, [CLI, "-p", "go", ...extraArgs], {
        cwd: dir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (c) => (stderr += c));
      child.stdout.resume();
      const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
      return { code, stderr, ran: fs.existsSync(path.join(dir, MARKER)) };
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("gate: one-shot mode skips a shell command nobody approved", async () => {
  const r = await runCli({});
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.ran, false);
});

// Positive controls: prove the harness CAN see a command run, so the refusals
// below are not passing vacuously.
test("gate: --yes from the user runs the command", async () => {
  const r = await runCli({}, {}, ["--yes"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.ran, true);
});

test("gate: AUTO_APPROVE=1 in the user's own shell runs the command", async () => {
  const r = await runCli({}, { AUTO_APPROVE: "1" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.ran, true);
});

// The working directory is the project the user pointed the tool at — often a
// repository somebody else wrote. A file in it must not be able to switch the
// gate off.
test("gate: a project .mentorrc.json cannot turn on auto-approve", async () => {
  const r = await runCli({ ".mentorrc.json": '{"autoApprove":true}' });
  assert.equal(r.ran, false, "a project config file approved a shell command on the user's behalf");
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /autoApprove/);
});

test("gate: a project .env cannot turn on auto-approve", async () => {
  const r = await runCli({ ".env": "AUTO_APPROVE=1\n" });
  assert.equal(r.ran, false, "a project .env approved a shell command on the user's behalf");
  assert.match(r.stderr, /AUTO_APPROVE/);
});

test("gate: an explicit autoApprove:false in the project config is still accepted", async () => {
  const r = await runCli({ ".mentorrc.json": '{"autoApprove":false}' }, {}, ["--yes"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.ran, true);
});
