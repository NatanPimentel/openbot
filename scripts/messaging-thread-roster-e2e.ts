// Checks that a restart never makes the thread of a Discord or Slack conversation an agent's own chat,
// and that an agent which an earlier build gave one gets it back with its history kept in place. Boots
// the real agent store on a temporary profile three times: `bun scripts/messaging-thread-roster-e2e.ts`.
// Writes .openbot-build/messaging-thread-roster-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MessagingStore } from "../src/backend/messaging/messaging-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const OUT = resolve(import.meta.dirname, "../.openbot-build/messaging-thread-roster-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-messaging-thread-roster-"));
const userData = join(root, "user-data");
const home = join(root, "home");

interface Report {
  messagingThreadId?: string;
  threadAfterRestart?: string | null;
  threadAfterRepair?: string | null;
  ownThreadAfterRepair?: string;
  messagingThreadKept?: boolean;
  passed: boolean;
}

const report: Report = { passed: false };

async function boot<T>(use: (store: AgentStore, database: OpenBotDatabase) => T | Promise<T>): Promise<T> {
  const database = new OpenBotDatabase(userData);
  const store = new AgentStore(userData, home, database);
  await runCauseEffect(store.initialize());
  try {
    return await use(store, database);
  } finally {
    database.close();
  }
}

try {
  // A Discord conversation reaches an agent that was never opened, so the agent has no chat of its own.
  const { agentId, messagingThreadId } = await boot(async (store, database) => {
    const agent = await runCauseEffect(
      store.createAgent({ name: "Discord Orchestrator", description: "", avatarSeed: "seed", avatarHue: null }),
    );
    assert.equal(agent.threadId, null);
    const messaging = new MessagingStore(database);
    const connection = messaging.ensureConnection("discord", "guild-1", "Guild");
    const link = messaging.ensureLink({
      connectionId: connection.connectionId,
      agentId: agent.id,
      platformChannelId: "channel-1",
      threadKey: "thread-1",
      isDirect: false,
      title: "#general · hello",
    });
    return { agentId: agent.id, messagingThreadId: link.threadId };
  });
  report.messagingThreadId = messagingThreadId;

  // A restart must not adopt the conversation's thread as the agent's chat.
  report.threadAfterRestart = await boot(
    (store) => store.list().find((agent) => agent.id === agentId)?.threadId ?? null,
  );
  assert.notEqual(report.threadAfterRestart, messagingThreadId, "A restart adopted the messaging thread.");

  // The state an earlier build left: the agent's chat is the conversation's thread.
  await boot((store, database) => {
    const agents = store
      .list()
      .map((agent) => (agent.id === agentId ? { ...agent, threadId: messagingThreadId } : agent));
    database.replaceAgents("messaging-thread-roster-e2e:seed", agents, "thread.reclaimed");
  });

  await boot((store, database) => {
    report.threadAfterRepair = store.list().find((agent) => agent.id === agentId)?.threadId ?? null;
    assert.notEqual(report.threadAfterRepair, messagingThreadId, "The agent kept the messaging thread as its chat.");
    report.ownThreadAfterRepair = store.ensureThreadIdNow(agentId);
    assert.notEqual(report.ownThreadAfterRepair, messagingThreadId);
    const link = new MessagingStore(database).linkForThread(messagingThreadId);
    report.messagingThreadKept = link?.agentId === agentId;
    assert.ok(report.messagingThreadKept, "The messaging thread lost its link.");
  });

  report.passed = true;
} finally {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}
process.stdout.write(`Messaging thread roster check passed. Report: ${join(OUT, "report.json")}\n`);
