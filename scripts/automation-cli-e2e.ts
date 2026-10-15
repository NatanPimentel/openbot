// Runs `resources/cli/openbot-cli.mjs` as a child process against the real `AutomationServer` on a
// loopback port. The agent service behind the server is a small in-memory stand-in: a message gets a
// delivery that moves from queued to running to its end each time the CLI reads it. The script checks
// the CLI's output and exit codes for each outcome and that the token never reaches the output.
// Writes .openbot-build/automation-cli-e2e/report.json. Run: `bun scripts/automation-cli-e2e.ts`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { QueueDelivery, QueuedMessageReceipt, UpdateAgentInput } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { AutomationServer, type UpdatedAgent } from "../src/main/automation-server";

const OUT = resolve(import.meta.dirname, "../.openbot-build/automation-cli-e2e");
const CLI = resolve(import.meta.dirname, "../resources/cli/openbot-cli.mjs");

interface Check {
  name: string;
  passed: boolean;
  detail: unknown;
}

/** How a message's delivery ends, chosen by the message text. */
type Outcome = "completed" | "failed" | "person" | "forever";

interface FakeDelivery {
  id: string;
  agentId: string;
  outcome: Outcome;
  reads: number;
}

const agents = [
  { id: "agent-ada", name: "Ada", allowAutomation: true },
  { id: "agent-bo", name: "Bo", allowAutomation: false },
];
const deliveries = new Map<string, FakeDelivery>();
const updates: UpdateAgentInput[] = [];
let busy = false;

function deliveryState(
  delivery: FakeDelivery,
): Pick<QueueDelivery, "recipientAgentId" | "status" | "turnId" | "error"> {
  delivery.reads += 1;
  const base = { recipientAgentId: delivery.agentId, turnId: delivery.reads > 1 ? `turn-${delivery.id}` : null };
  if (delivery.reads === 1) return { ...base, status: "queued", error: null };
  if (delivery.reads < 3 || delivery.outcome === "person" || delivery.outcome === "forever")
    return { ...base, status: "running", error: null };
  if (delivery.outcome === "failed") return { ...base, status: "failed", error: "The provider stopped." };
  return { ...base, status: "completed", error: null };
}

const root = mkdtempSync(join(tmpdir(), "openbot-cli-e2e-"));
const server = new AutomationServer({
  root,
  listAgents: () => agents,
  listRoutines: () => [],
  runRoutine: () => Effect.die(new Error("No routine runs in this test.")),
  sendMessage: (input) => {
    const id = `delivery-${deliveries.size + 1}`;
    const outcome: Outcome =
      input.text === "please fail"
        ? "failed"
        : input.text === "ask me"
          ? "person"
          : input.text === "forever"
            ? "forever"
            : "completed";
    deliveries.set(id, { id, agentId: input.agentId, outcome, reads: 0 });
    const receipt: QueuedMessageReceipt = {
      messageId: `message-${id}`,
      deliveries: [{ id, recipientAgentId: input.agentId, status: "queued", position: 1 }],
    };
    return Effect.succeed(receipt);
  },
  getLocalAttention: (agentId) => {
    // Only the newest delivery can wait: an earlier question is gone once the next test starts.
    const newest = [...deliveries.values()].at(-1);
    const waiting = newest?.agentId === agentId && newest.outcome === "person";
    return {
      prompts: [],
      approvals: [],
      browserTakeovers: waiting ? [{ requestId: "takeover-1", requiresOpenBot: true }] : [],
    };
  },
  respondToLocalAttention: () => Effect.void,
  delivery: (deliveryId) => {
    const delivery = deliveries.get(deliveryId);
    return delivery ? deliveryState(delivery) : null;
  },
  turnAnswer: (_agentId, turnId) => `Answer of ${turnId}`,
  updateAgent: (input) => {
    if (busy) return Effect.fail({ cause: new Error("Wait until the agent is idle.") });
    updates.push(input);
    const agent: UpdatedAgent = {
      id: input.agentId,
      name: "Ada",
      provider: input.provider ?? "claude",
      model: input.model ?? "claude-sonnet-5-5",
      reasoningEffort: input.reasoningEffort ?? "high",
      ...(input.providerAccountId ? { providerAccountId: input.providerAccountId } : {}),
    };
    return Effect.succeed(agent);
  },
});

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function cli(args: string[], stdin?: string): Promise<Run> {
  return new Promise((done, fail) => {
    // The CLI is for Node, which is what users have; Bun runs only this script.
    const child = spawn("node", [CLI, ...args], {
      env: { ...process.env, OPENBOT_AUTOMATION_DIR: root },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", fail);
    child.on("close", (code) => done({ code, stdout, stderr }));
    child.stdin.end(stdin ?? "");
  });
}

mkdirSync(OUT, { recursive: true });
const checks: Check[] = [];
const outputs: string[] = [];
async function check(name: string, args: string[], expectCode: number, test: (run: Run) => boolean, stdin?: string) {
  const run = await cli(args, stdin);
  outputs.push(run.stdout, run.stderr);
  checks.push({ name, passed: run.code === expectCode && test(run), detail: run });
}
const parsed = (run: Run) => JSON.parse(run.stdout);

try {
  await Effect.runPromise(server.sync());
  const token = readFileSync(join(root, "token"), "utf8").trim();

  await check("list shows only agents with Local scripts", ["list", "--json"], 0, (run) => {
    const value = parsed(run);
    return value.ok === true && value.agents.length === 1 && value.agents[0].name === "Ada";
  });
  await check("run without --wait returns the queued delivery", ["run", "ada", "hello", "--json"], 0, (run) => {
    const value = parsed(run);
    return value.status === "queued" && value.deliveryId === "delivery-1";
  });
  await check("run --wait prints the turn's answer", ["run", "Ada", "do it", "--wait"], 0, (run) => {
    return run.stdout.trim() === "Answer of turn-delivery-2";
  });
  await check(
    "run --wait --json ends completed with the answer",
    ["run", "agent-ada", "-", "--wait", "--json"],
    0,
    (run) => {
      const value = parsed(run);
      return value.status === "completed" && value.answer === "Answer of turn-delivery-3";
    },
    "a task from stdin",
  );
  await check("a failed turn exits 1", ["run", "Ada", "please fail", "--wait", "--json"], 1, (run) => {
    const value = parsed(run);
    return value.status === "failed" && value.error === "The provider stopped.";
  });
  await check("a turn that waits for a person exits 3", ["run", "Ada", "ask me", "--wait", "--json"], 3, (run) => {
    return parsed(run).state === "needs-person";
  });
  await check(
    "a turn that runs past the timeout exits 4",
    ["run", "Ada", "forever", "--wait", "--timeout", "3s"],
    4,
    (run) => run.stdout.includes("Timed out"),
  );
  await check("status reads a delivery", ["status", "Ada", "delivery-2", "--json"], 0, (run) => {
    return parsed(run).answer === "Answer of turn-delivery-2";
  });
  await check("an agent without Local scripts is not found", ["run", "Bo", "hello"], 5, (run) => {
    return run.stderr.includes('No agent "Bo"');
  });
  await check("a wrong command line exits 2", ["run", "Ada"], 2, (run) => run.stderr.includes("Usage:"));
  await check("set-account changes the account", ["agent", "set-account", "Ada", "a0123456789abcdef"], 0, (run) => {
    return (
      run.stdout.includes("account a0123456789abcdef") && updates.at(-1)?.providerAccountId === "a0123456789abcdef"
    );
  });
  await check(
    "set-model sends the model and the effort",
    ["agent", "set-model", "Ada", "claude-opus-5-5", "--effort", "max", "--json"],
    0,
    (run) => parsed(run).agent.model === "claude-opus-5-5" && updates.at(-1)?.reasoningEffort === "max",
  );
  await check("an invalid account ID is refused", ["agent", "set-account", "Ada", "../x"], 1, (run) => {
    return run.stderr.includes("providerAccountId is invalid.");
  });
  busy = true;
  await check("a refused update exits 1 with its reason", ["agent", "set-account", "Ada", "default"], 1, (run) => {
    return run.stderr.includes("Wait until the agent is idle.");
  });
  busy = false;
  await Effect.runPromise(server.stop());
  await check("a stopped app exits 5", ["list"], 5, (run) => run.stderr.includes("OpenBot is not running"));
  checks.push({
    name: "the token is never in the output",
    passed: outputs.every((text) => !text.includes(token)),
    detail: null,
  });
} finally {
  await Effect.runPromise(server.stop());
  rmSync(root, { recursive: true, force: true });
}

const failed = checks.filter((item) => !item.passed);
writeFileSync(join(OUT, "report.json"), `${JSON.stringify({ passed: failed.length === 0, checks }, null, 2)}\n`);
for (const item of checks) process.stdout.write(`${item.passed ? "ok" : "FAILED"} ${item.name}\n`);
assert.equal(failed.length, 0, `${failed.length} checks failed; see ${join(OUT, "report.json")}`);
