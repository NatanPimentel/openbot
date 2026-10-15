// Feeds completed tool items, in the shapes that Claude, Codex, the ACP agents and MCP tools send,
// through the loop guard, and reads real settings files through the loop guard preference store.
// It checks when the guard warns, when it stops, and what ends a streak. Writes
// .openbot-build/loop-guard-e2e/report.json. Run: `bun scripts/loop-guard-e2e.ts`.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import {
  DEFAULT_LOOP_GUARD_SETTINGS,
  LoopGuard,
  type LoopGuardSettings,
  type LoopGuardVerdict,
  loopGuardWarning,
} from "../src/backend/agent/loop-guard";
import { toolUsage } from "../src/backend/agent/thread-items";
import type { ThreadItem } from "../src/backend/protocol";
import { LoopGuardPreferenceStore } from "../src/main/loop-guard-preference-store";

const OUT = resolve(import.meta.dirname, "../.openbot-build/loop-guard-e2e");

interface Check {
  name: string;
  passed: boolean;
  detail: unknown;
}

const checks: Check[] = [];
const check = (name: string, passed: boolean, detail: unknown = null) => checks.push({ name, passed, detail });
const warnAndStop: LoopGuardSettings = { enabled: true, warnAt: 3, stopAt: 6 };

/** The verdicts of a series of items in one turn, `null` for none. */
function run(
  items: ThreadItem[],
  settings = warnAndStop,
  turnIds?: string[],
): Array<LoopGuardVerdict["action"] | null> {
  const guard = new LoopGuard();
  return items.map(
    (item, index) => guard.observe("agent-1", turnIds?.[index] ?? "turn-1", item, settings)?.action ?? null,
  );
}

// Claude's Bash tool after this change: the input, the end of the result and `failed` for `is_error`.
const claudeBash = (attempt: number, isError = true, output = "Error: Cannot find module 'left-pad'"): ThreadItem => ({
  id: `toolu_${attempt}`,
  type: "toolCall",
  name: "Bash",
  status: isError ? "failed" : "completed",
  // Claude often writes another description for the same command.
  arguments: { command: "npm test", description: `Run the tests, attempt ${attempt}` },
  result: `${output} (after ${attempt * 137} ms)`,
});
const claudeRead: ThreadItem = {
  id: "toolu_read",
  type: "toolCall",
  name: "Read",
  status: "completed",
  arguments: { file_path: "/w/package.json" },
  result: "{}",
};
const codexCommand = (exitCode: number, output = "make: *** [build] Error 2"): ThreadItem => ({
  id: "item-1",
  type: "commandExecution",
  command: "make build",
  status: exitCode === 0 ? "completed" : "failed",
  exitCode,
  aggregatedOutput: output,
});
const acpExecute: ThreadItem = {
  id: "call-1",
  type: "toolCall",
  name: "Run cargo test",
  toolKind: "execute",
  status: "failed",
  arguments: { command: "cargo test" },
  result: { stderr: "error[E0425]: cannot find value `x`" },
};
const mcpCall = (args: { repo: string; title: string }): ThreadItem => ({
  id: "mcp-1",
  type: "mcpToolCall",
  server: "github",
  tool: "create_issue",
  status: "failed",
  arguments: args,
  error: { message: "403 Forbidden" },
});

const times = <T>(count: number, make: (index: number) => T) =>
  Array.from({ length: count }, (_, index) => make(index));

let verdicts = run(times(3, (index) => claudeBash(index)));
check("Claude Bash warns at the third identical failure", verdicts.join() === ",,warn", verdicts);

verdicts = run(times(7, (index) => claudeBash(index)));
check("Claude Bash stops at the sixth and is quiet after it", verdicts.join() === ",,warn,,,stop,", verdicts);

verdicts = run([claudeBash(1), claudeRead, claudeBash(2), claudeRead, claudeBash(3)]);
check("a call between two tries does not end the streak", verdicts.at(-1) === "warn", verdicts);

verdicts = run([claudeBash(1), claudeBash(2), claudeBash(3, false), claudeBash(4), claudeBash(5)]);
check(
  "a success of the same call ends the streak",
  verdicts.every((verdict) => verdict === null),
  verdicts,
);

verdicts = run([claudeBash(1), claudeBash(2), claudeBash(3, true, "Error: tests failed: 2"), claudeBash(4)]);
check(
  "another failure output ends the streak",
  verdicts.every((verdict) => verdict === null),
  verdicts,
);

verdicts = run(times(3, () => codexCommand(2)));
check("a Codex command with a non-zero exit code warns", verdicts.at(-1) === "warn", verdicts);

verdicts = run(times(4, () => codexCommand(0)));
check(
  "a command that succeeds never counts",
  verdicts.every((verdict) => verdict === null),
  verdicts,
);

verdicts = run(times(3, () => acpExecute));
check("an ACP execute tool warns", verdicts.at(-1) === "warn", verdicts);

verdicts = run([
  mcpCall({ repo: "a", title: "b" }),
  mcpCall({ title: "b", repo: "a" }),
  mcpCall({ repo: "a", title: "b" }),
]);
check("an MCP call with the same arguments in another order is the same call", verdicts.at(-1) === "warn", verdicts);

verdicts = run(times(3, () => ({ ...codexCommand(1), status: "declined" })));
check(
  "a declined call never counts",
  verdicts.every((verdict) => verdict === null),
  verdicts,
);

verdicts = run(times(3, () => ({ id: "toolu_x", type: "toolCall", name: "Bash", status: "completed" })));
check(
  "an item without its input is not compared",
  verdicts.every((verdict) => verdict === null),
  verdicts,
);

verdicts = run(
  times(3, (index) => claudeBash(index)),
  { ...warnAndStop, enabled: false },
);
check(
  "a disabled guard does nothing",
  verdicts.every((verdict) => verdict === null),
  verdicts,
);

verdicts = run(
  times(3, (index) => claudeBash(index)),
  warnAndStop,
  ["turn-1", "turn-1", "turn-2"],
);
check(
  "a new turn starts the count again",
  verdicts.every((verdict) => verdict === null),
  verdicts,
);

verdicts = run(
  times(50, (index) => claudeBash(index)),
  DEFAULT_LOOP_GUARD_SETTINGS,
);
check(
  "the defaults warn once and never stop",
  verdicts.filter((verdict) => verdict === "warn").length === 1 && !verdicts.includes("stop"),
  verdicts.filter(Boolean),
);

const guard = new LoopGuard();
let warning: LoopGuardVerdict | null = null;
for (const item of times(3, (index) => claudeBash(index)))
  warning = guard.observe("agent-1", "turn-1", item, warnAndStop);
const text = warning ? loopGuardWarning(warning) : "";
check("the warning names the command and the count", text.includes("npm test") && text.includes("3 times"), text);

const usage = toolUsage(claudeBash(1));
check("tool analytics see a failed Claude call", usage?.failed === true, usage);

const root = mkdtempSync(join(tmpdir(), "openbot-loop-guard-e2e-"));
try {
  const read = async (content: string | null) => {
    const path = join(root, `settings-${checks.length}.json`);
    if (content !== null) writeFileSync(path, content);
    const store = new LoopGuardPreferenceStore(path);
    await Effect.runPromise(store.load());
    return store.get();
  };
  let settings = await read(null);
  check(
    "a missing settings file gives the defaults",
    JSON.stringify(settings) === JSON.stringify(DEFAULT_LOOP_GUARD_SETTINGS),
    settings,
  );
  settings = await read('{ "version": 1, "enabled": true, "warnAt": 3, "stopAt": 6 }');
  check("a settings file sets stopAt", settings.stopAt === 6 && settings.warnAt === 3 && settings.enabled, settings);
  settings = await read('{ "version": 1, "enabled": false, "warnAt": 1, "stopAt": 5000 }');
  check(
    "out-of-range values keep their defaults",
    !settings.enabled && settings.warnAt === 3 && settings.stopAt === null,
    settings,
  );
  settings = await read("not json");
  check("a file that is not JSON gives the defaults", settings.enabled && settings.stopAt === null, settings);
} finally {
  rmSync(root, { recursive: true, force: true });
}

mkdirSync(OUT, { recursive: true });
const failed = checks.filter((item) => !item.passed);
writeFileSync(join(OUT, "report.json"), `${JSON.stringify({ passed: failed.length === 0, checks }, null, 2)}\n`);
for (const item of checks) process.stdout.write(`${item.passed ? "ok" : "FAILED"} ${item.name}\n`);
assert.equal(failed.length, 0, `${failed.length} checks failed; see ${join(OUT, "report.json")}`);
