/**
 * Tests for caravel-messaging module.
 *
 * Test groups:
 * 1. sendMessage — validation, persistence, defaults
 * 2. getMessages — retrieval, unread filter, cross-channel
 * 3. markAsRead — marking messages, validation, file updates
 * 4. getMessagesByChannel — channel filtering, empty channels
 * 5. Persistence — file structure, schema integrity
 * 6. Edge cases — missing files, unknown agents, idempotent ops
 * 7. DEFAULT_CHANNELS export
 * 8. getAvailableChannels
 * 9. getChannelMessages
 * 10. Agent-specific <from>→<to> channel auto-creation
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  sendMessage,
  getMessages,
  markAsRead,
  getMessagesByChannel,
  DEFAULT_CHANNELS,
  getAvailableChannels,
  getChannelMessages,
  sendNudge,
  escalate,
  getUnresolvedNudges,
  getOpenEscalations,
  resolveEscalation,
  NUDGE_EXPIRY_MS,
  ESCALATION_RECIPIENTS,
} from "./caravel-messaging";

// ── Test runner ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let errors: Array<{ test: string; error: string }> = [];

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    failed++;
    errors.push({ test: currentTest(), error: `ASSERT: ${msg}` });
    console.error(`  ✗ ${msg}`);
  } else {
    passed++;
    console.log(`  ✓ ${msg}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, msg: string): void {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr !== expectedStr) {
    failed++;
    errors.push({ test: currentTest(), error: `EXPECTED ${expectedStr} GOT ${actualStr}: ${msg}` });
    console.error(`  ✗ ${msg} (expected ${expectedStr}, got ${actualStr})`);
  } else {
    passed++;
    console.log(`  ✓ ${msg}`);
  }
}

function assertThrows(fn: () => void, msg: string): void {
  try {
    fn();
    failed++;
    errors.push({ test: currentTest(), error: `EXPECTED THROWS: ${msg}` });
    console.error(`  ✗ ${msg} (expected error, got none)`);
  } catch (e: any) {
    passed++;
    console.log(`  ✓ ${msg}: ${e.message}`);
  }
}

let currentTestName = "";
function currentTest(): string { return currentTestName || "(unknown)"; }
function runTest(name: string, fn: () => void): void {
  console.log(`\n${name}`);
  currentTestName = name;
  fn();
}

// ── Test helpers ───────────────────────────────────────────────────────────────

function createTestDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caravel-messaging-test-"));
  fs.mkdirSync(path.join(dir, ".caravel"), { recursive: true });
  return dir;
}

function removeTestDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function loadMessagesFile(testDir: string): any {
  const filePath = path.join(testDir, ".caravel", "messages.json");
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

// ── Group 1: sendMessage ──────────────────────────────────────────────────────

runTest("Group 1: sendMessage", () => {
  let testDir = "";

  runTest("  1.1 sendMessage creates messages.json on first call", () => {
    testDir = createTestDir();
    const msg = sendMessage(
      "caravel/dev/primary",
      "caravel/reviewer/primary",
      "Code review request",
      "Please review the auth module changes.",
      "high",
      "reviews",
      testDir,
    );
    assertEqual(msg.id, 1, "first message gets id 1");
    assertEqual(msg.from, "caravel/dev/primary", "sender matches");
    assertEqual(msg.to, "caravel/reviewer/primary", "recipient matches");
    assertEqual(msg.subject, "Code review request", "subject matches");
    assertEqual(msg.priority, "high", "priority matches");
    assertEqual(msg.isRead, false, "message starts unread");
    assertEqual(msg.channel, "reviews", "channel matches");
    assert(typeof msg.createdAt === "number", "createdAt is a number");
    assert(typeof msg.updatedAt === "number", "updatedAt is a number");
    assert(fs.existsSync(path.join(testDir, ".caravel", "messages.json")), "messages.json created");
  });

  runTest("  1.2 sendMessage with default priority uses 'normal'", () => {
    const msg = sendMessage(
      "caravel/dev/primary",
      "caravel/reviewer/primary",
      "Normal priority message",
      "This has no explicit priority.",
      undefined,
      "general",
      testDir,
    );
    assertEqual(msg.priority, "normal", "default priority is 'normal'");
  });

  runTest("  1.3 sendMessage with default channel uses 'general'", () => {
    const msg = sendMessage(
      "caravel/dev/primary",
      "caravel/reviewer/primary",
      "Channel test",
      "Should go to general channel.",
      undefined,
      undefined,
      testDir,
    );
    assertEqual(msg.channel, "general", "default channel is 'general'");
  });

  runTest("  1.4 sendMessage generates incrementing IDs", () => {
    const msg2 = sendMessage(
      "caravel/dev/primary",
      "caravel/reviewer/primary",
      "Second message",
      "Body 2",
      "low",
      "general",
      testDir,
    );
    // Note: test 1.3 also sent a message, so next ID is 4 (1 from 1.1, 2 from 1.2, 3 from 1.3)
    assertEqual(msg2.id, 4, "second explicit message in this test gets id 4 (accounting for 1.3)");
  });

  runTest("  1.5 sendMessage rejects empty sender", () => {
    assertThrows(() => sendMessage("", "caravel/reviewer/primary", "s", "b", undefined, undefined, testDir), "empty from");
    assertThrows(() => sendMessage("  ", "caravel/reviewer/primary", "s", "b", undefined, undefined, testDir), "whitespace from");
  });

  runTest("  1.6 sendMessage rejects empty recipient", () => {
    assertThrows(() => sendMessage("caravel/dev/primary", "", "s", "b", undefined, undefined, testDir), "empty to");
    assertThrows(() => sendMessage("caravel/dev/primary", "  ", "s", "b", undefined, undefined, testDir), "whitespace to");
  });

  runTest("  1.7 sendMessage rejects empty subject", () => {
    assertThrows(() => sendMessage("caravel/dev/primary", "caravel/reviewer/primary", "", "b", undefined, undefined, testDir), "empty subject");
  });

  runTest("  1.8 sendMessage rejects empty body", () => {
    assertThrows(() => sendMessage("caravel/dev/primary", "caravel/reviewer/primary", "s", "", undefined, undefined, testDir), "empty body");
  });

  runTest("  1.9 sendMessage rejects invalid priority", () => {
    assertThrows(
      () => sendMessage("caravel/dev/primary", "caravel/reviewer/primary", "s", "b", "invalid" as any, undefined, testDir),
      "invalid priority rejected",
    );
  });

  runTest("  1.10 All four priority levels are accepted", () => {
    for (const prio of ["low", "normal", "high", "urgent"]) {
      const msg = sendMessage(
        "caravel/dev/primary",
        "caravel/reviewer/primary",
        `Priority ${prio}`,
        `Body for ${prio} priority`,
        prio as any,
        "general",
        testDir,
      );
      assertEqual(msg.priority, prio, `${prio} priority accepted`);
    }
  });
});

// ── Group 2: getMessages ──────────────────────────────────────────────────────

runTest("Group 2: getMessages", () => {
  let testDir = "";

  runTest("  2.1 getMessages returns empty when no messages exist", () => {
    testDir = createTestDir();
    const msgs = getMessages("caravel/dev/primary", undefined, testDir);
    assertEqual(msgs.length, 0, "no messages for agent with no messages");
  });

  runTest("  2.2 getMessages returns messages where agent is recipient", () => {
    const testDir2 = createTestDir();
    sendMessage(
      "caravel/dev/primary",
      "caravel/reviewer/primary",
      "Review request",
      "Please review the code.",
      "high",
      "reviews",
      testDir2,
    );
    const msgs = getMessages("caravel/reviewer/primary", undefined, testDir2);
    assertEqual(msgs.length, 1, "1 message for recipient");
    assertEqual(msgs[0].to, "caravel/reviewer/primary", "recipient matches");
    removeTestDir(testDir2);
  });

  runTest("  2.3 getMessages returns messages where agent is sender", () => {
    const testDir2 = createTestDir();
    sendMessage(
      "caravel/dev/primary",
      "caravel/reviewer/primary",
      "My message",
      "I sent this.",
      "normal",
      "general",
      testDir2,
    );
    const msgs = getMessages("caravel/dev/primary", undefined, testDir2);
    assertEqual(msgs.length, 1, "1 message for sender");
    assertEqual(msgs[0].from, "caravel/dev/primary", "sender matches");
    removeTestDir(testDir2);
  });

  runTest("  2.4 getMessages returns both sent and received messages", () => {
    const testDir2 = createTestDir();
    sendMessage("caravel/alice/primary", "caravel/bob/primary", "Msg 1", "Body 1", "normal", "general", testDir2);
    sendMessage("caravel/bob/primary", "caravel/alice/primary", "Msg 2", "Body 2", "high", "reviews", testDir2);
    const msgs = getMessages("caravel/alice/primary", undefined, testDir2);
    assertEqual(msgs.length, 2, "alice sees both sent and received");
    removeTestDir(testDir2);
  });

  runTest("  2.5 getMessages with unreadOnly returns only unread", () => {
    const testDir2 = createTestDir();
    const msg1 = sendMessage("caravel/dev/primary", "caravel/reviewer/primary", "Msg A", "Body A", "normal", "general", testDir2);
    const msg2 = sendMessage("caravel/dev/primary", "caravel/reviewer/primary", "Msg B", "Body B", "high", "general", testDir2);
    // Mark msg1 as read
    markAsRead(msg1.id, "caravel/reviewer/primary", testDir2);

    const unread = getMessages("caravel/reviewer/primary", true, testDir2);
    assertEqual(unread.length, 1, "1 unread message");
    assertEqual(unread[0].id, msg2.id, "only msg2 is unread");
    removeTestDir(testDir2);
  });

  runTest("  2.6 getMessages returns messages sorted by createdAt ascending", () => {
    const testDir2 = createTestDir();
    const msg1 = sendMessage("caravel/dev/primary", "caravel/reviewer/primary", "First", "Body", "normal", "general", testDir2);
    // Tiny delay to ensure different timestamps
    const before = Date.now();
    const msg2 = sendMessage("caravel/dev/primary", "caravel/reviewer/primary", "Second", "Body", "normal", "general", testDir2);
    assert(msg2.id > msg1.id, "later message has higher id");

    const msgs = getMessages("caravel/reviewer/primary", undefined, testDir2);
    assertEqual(msgs[0].id, msg1.id, "first is older message");
    assertEqual(msgs[1].id, msg2.id, "second is newer message");
    removeTestDir(testDir2);
  });

  runTest("  2.7 getMessages returns a copy (mutations don't affect storage)", () => {
    const testDir2 = createTestDir();
    sendMessage("caravel/dev/primary", "caravel/reviewer/primary", "Original", "Body", "normal", "general", testDir2);
    const msgs = getMessages("caravel/reviewer/primary", undefined, testDir2);
    const originalLen = msgs.length;
    msgs.length = 0; // Mutate returned array
    const after = getMessages("caravel/reviewer/primary", undefined, testDir2);
    assertEqual(after.length, originalLen, "storage unaffected by mutation");
    removeTestDir(testDir2);
  });
});

// ── Group 3: markAsRead ──────────────────────────────────────────────────────

runTest("Group 3: markAsRead", () => {
  let testDir = "";

  runTest("  3.1 markAsRead returns true for valid message", () => {
    testDir = createTestDir();
    const msg = sendMessage("caravel/dev/primary", "caravel/reviewer/primary", "Msg", "Body", "normal", "general", testDir);
    const result = markAsRead(msg.id, "caravel/reviewer/primary", testDir);
    assertEqual(result, true, "markAsRead returns true");
    // Re-read from storage since markAsRead writes to file
    const updatedMsgs = getMessages("caravel/reviewer/primary", false, testDir);
    const updatedMsg = updatedMsgs.find((m) => m.id === msg.id)!;
    assertEqual(updatedMsg.isRead, true, "message is now read");
  });

  runTest("  3.2 markAsRead returns false for unknown message ID", () => {
    const result = markAsRead(9999, "caravel/reviewer/primary", testDir);
    assertEqual(result, false, "unknown id returns false");
  });

  runTest("  3.3 markAsRead returns false when wrong agent calls it", () => {
    const msg = sendMessage("caravel/dev/primary", "caravel/reviewer/primary", "Msg", "Body", "normal", "general", testDir);
    const result = markAsRead(msg.id, "caravel/dev/primary", testDir);
    assertEqual(result, false, "sender can't mark as read");
    // Verify message is still unread
    const msgs = getMessages("caravel/reviewer/primary", true, testDir);
    assertEqual(msgs.length, 1, "message still unread for recipient");
  });

  runTest("  3.4 markAsRead updates updatedAt timestamp", () => {
    const msg = sendMessage("caravel/dev/primary", "caravel/reviewer/primary", "Timestamp test", "Body", "normal", "general", testDir);
    const before = msg.updatedAt;

    // Force a tiny delay
    const start = Date.now();
    while (Date.now() - start < 2) { /* spin */ }

    markAsRead(msg.id, "caravel/reviewer/primary", testDir);
    const updatedMsg = getMessages("caravel/reviewer/primary", undefined, testDir).find((m) => m.id === msg.id)!;
    assert(updatedMsg.updatedAt > before, "updatedAt increased after markAsRead");
  });

  runTest("  3.5 markAsRead is idempotent (no duplicate file writes)", () => {
    const msg = sendMessage("caravel/dev/primary", "caravel/reviewer/primary", "Idempotent test", "Body", "normal", "general", testDir);
    const beforeFile = loadMessagesFile(testDir);
    const beforeNextId = beforeFile?.nextId;

    markAsRead(msg.id, "caravel/reviewer/primary", testDir);
    markAsRead(msg.id, "caravel/reviewer/primary", testDir);

    const afterFile = loadMessagesFile(testDir);
    assertEqual(afterFile?.nextId, beforeNextId, "nextId unchanged after double markAsRead");
    assertEqual(afterFile?.channels["general"]?.[0]?.isRead, true, "still marked as read");
  });

  runTest("  3.6 markAsRead rejects invalid agent identity", () => {
    const msg = sendMessage("caravel/dev/primary", "caravel/reviewer/primary", "Msg", "Body", "normal", "general", testDir);
    assertThrows(() => markAsRead(msg.id, "", testDir), "empty agent identity rejected");
    assertThrows(() => markAsRead(msg.id, "  ", testDir), "whitespace agent identity rejected");
  });
});

// ── Group 4: getMessagesByChannel ────────────────────────────────────────────

runTest("Group 4: getMessagesByChannel", () => {
  let testDir = "";

  runTest("  4.1 getMessagesByChannel returns empty for unknown channel", () => {
    testDir = createTestDir();
    const msgs = getMessagesByChannel("nonexistent", testDir);
    assertEqual(msgs.length, 0, "no messages for unknown channel");
  });

  runTest("  4.2 getMessagesByChannel returns all messages in a channel", () => {
    sendMessage("caravel/dev/primary", "caravel/reviewer/primary", "Review 1", "Body 1", "high", "reviews", testDir);
    sendMessage("caravel/lead/primary", "caravel/dev/primary", "Review 2", "Body 2", "urgent", "reviews", testDir);
    sendMessage("caravel/dev/primary", "caravel/reviewer/primary", "General msg", "Body", "normal", "general", testDir);

    const reviewMsgs = getMessagesByChannel("reviews", testDir);
    assertEqual(reviewMsgs.length, 2, "2 messages in reviews channel");
    assertEqual(reviewMsgs[0].channel, "reviews", "first message is in reviews");
    assertEqual(reviewMsgs[1].channel, "reviews", "second message is in reviews");
  });

  runTest("  4.3 getMessagesByChannel returns messages sorted by createdAt", () => {
    const m1 = sendMessage("caravel/a/primary", "caravel/b/primary", "First in channel", "Body", "normal", "test-channel", testDir);
    const m2 = sendMessage("caravel/a/primary", "caravel/b/primary", "Second in channel", "Body", "normal", "test-channel", testDir);
    assert(m2.id > m1.id, "later message has higher id");

    const msgs = getMessagesByChannel("test-channel", testDir);
    assertEqual(msgs[0].id, m1.id, "first message is the older one");
    assertEqual(msgs[1].id, m2.id, "second message is the newer one");
  });

  runTest("  4.4 getMessagesByChannel returns a copy", () => {
    const msgs = getMessagesByChannel("reviews", testDir);
    const originalLen = msgs.length;
    msgs.length = 0;
    const after = getMessagesByChannel("reviews", testDir);
    assertEqual(after.length, originalLen, "storage unaffected by mutation");
  });

  runTest("  4.5 getMessagesByChannel rejects empty channel name", () => {
    assertThrows(() => getMessagesByChannel("", testDir), "empty channel rejected");
    assertThrows(() => getMessagesByChannel("  ", testDir), "whitespace channel rejected");
  });

  runTest("  4.6 getMessagesByChannel creates no side effects for empty channel", () => {
    const beforeFile = loadMessagesFile(testDir);
    const beforeChannels = { ...beforeFile?.channels };
    getMessagesByChannel("ghost-channel", testDir);
    const afterFile = loadMessagesFile(testDir);
    assertEqual(Object.keys(afterFile?.channels || {}).length, Object.keys(beforeChannels || {}).length, "no new channel created");
  });
});

// ── Group 5: Persistence and schema ──────────────────────────────────────────

runTest("Group 5: Persistence and schema", () => {
  let testDir = "";

  runTest("  5.1 messages.json has correct schema on first write", () => {
    testDir = createTestDir();
    sendMessage("caravel/dev/primary", "caravel/reviewer/primary", "Schema test", "Body", "normal", "general", testDir);
    const file = loadMessagesFile(testDir);

    assertEqual(typeof file?.version, "number", "version is number");
    assertEqual(file?.version, 1, "version is 1");
    assertEqual(typeof file?.nextId, "number", "nextId is number");
    assertEqual(file?.nextId, 2, "nextId is 2 after first message");
    assert(typeof file?.channels === "object", "channels is object");
    assertEqual(typeof file?.updatedAt, "number", "updatedAt is number");
  });

  runTest("  5.2 messages.json persists across fresh reads", () => {
    // Force a fresh read by loading from file
    const file = loadMessagesFile(testDir);
    assertEqual(file?.nextId > 1, true, "nextId persisted from previous tests");
  });

  runTest("  5.3 messages.json file is valid JSON", () => {
    const filePath = path.join(testDir, ".caravel", "messages.json");
    const raw = fs.readFileSync(filePath, "utf-8");
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      assert(false, "messages.json is valid JSON");
      return;
    }
    assertEqual(parsed.version, 1, "version is 1");
    assert(typeof parsed.nextId === "number", "nextId is number");
    assert(typeof parsed.channels === "object", "channels is object");
    assert(typeof parsed.updatedAt === "number", "updatedAt is number");
  });

  runTest("  5.4 messages.json channel structure matches schema", () => {
    const file = loadMessagesFile(testDir);
    for (const [channel, msgs] of Object.entries(file?.channels || {})) {
      assertEqual(typeof channel, "string", `channel key '${channel}' is string`);
      assert(Array.isArray(msgs), `channel '${channel}' has array value`);
      for (const msg of msgs) {
        assertEqual(typeof msg.id, "number", `message ${msg.id} id is number`);
        assert(typeof msg.from === "string", `message ${msg.id} from is string`);
        assert(typeof msg.to === "string", `message ${msg.id} to is string`);
        assert(typeof msg.subject === "string", `message ${msg.id} subject is string`);
        assert(typeof msg.body === "string", `message ${msg.id} body is string`);
        assert(["low", "normal", "high", "urgent"].includes(msg.priority), `message ${msg.id} priority is valid`);
        assert(typeof msg.createdAt === "number", `message ${msg.id} createdAt is number`);
        assert(typeof msg.updatedAt === "number", `message ${msg.id} updatedAt is number`);
        assertEqual(typeof msg.isRead, "boolean", `message ${msg.id} isRead is boolean`);
        assertEqual(typeof msg.channel, "string", `message ${msg.id} channel is string`);
      }
    }
  });
});

// ── Group 6: Edge cases ──────────────────────────────────────────────────────

runTest("Group 6: Edge cases", () => {
  let testDir = "";

  runTest("  6.1 getMessages returns empty for unknown identity", () => {
    testDir = createTestDir();
    const msgs = getMessages("caravel/ghost/primary", undefined, testDir);
    assertEqual(msgs.length, 0, "no messages for unknown agent");
  });

  runTest("  6.2 markAsRead returns false when file doesn't exist", () => {
    testDir = createTestDir();
    const result = markAsRead(1, "caravel/reviewer/primary", testDir);
    assertEqual(result, false, "false when no messages.json");
  });

  runTest("  6.3 sendMessage with null/undefined sender throws", () => {
    testDir = createTestDir();
    assertThrows(() => sendMessage(null as any, "caravel/reviewer/primary", "s", "b"), "null sender");
    assertThrows(() => sendMessage(undefined as any, "caravel/reviewer/primary", "s", "b"), "undefined sender");
  });

  runTest("  6.4 sendMessage with null/undefined recipient throws", () => {
    testDir = createTestDir();
    assertThrows(() => sendMessage("caravel/dev/primary", null as any, "s", "b"), "null recipient");
    assertThrows(() => sendMessage("caravel/dev/primary", undefined as any, "s", "b"), "undefined recipient");
  });

  runTest("  6.5 Multiple channels coexist in the same file", () => {
    sendMessage("caravel/a/primary", "caravel/b/primary", "A", "A body", "normal", "ch-a", testDir);
    sendMessage("caravel/a/primary", "caravel/b/primary", "B", "B body", "high", "ch-b", testDir);
    sendMessage("caravel/a/primary", "caravel/b/primary", "C", "C body", "low", "ch-c", testDir);

    assertEqual(getMessagesByChannel("ch-a", testDir).length, 1, "ch-a has 1 message");
    assertEqual(getMessagesByChannel("ch-b", testDir).length, 1, "ch-b has 1 message");
    assertEqual(getMessagesByChannel("ch-c", testDir).length, 1, "ch-c has 1 message");

    const file = loadMessagesFile(testDir);
    // >= 3 because the auto-created <from>→<to> channel from test 1.1 also exists
    assert(Object.keys(file?.channels || {}).length >= 3, "at least 3 distinct channels in file");
  });

  runTest("  6.6 All unread messages filtered correctly", () => {
    // Mark all messages in testDir for reviewer as read
    const allMsgs = getMessages("caravel/reviewer/primary", undefined, testDir);
    for (const msg of allMsgs) {
      if (msg.to === "caravel/reviewer/primary" && !msg.isRead) {
        markAsRead(msg.id, "caravel/reviewer/primary", testDir);
      }
    }

    const unread = getMessages("caravel/reviewer/primary", true, testDir);
    assertEqual(unread.length, 0, "no unread messages for reviewer");

    // Send one more unread
    sendMessage("caravel/a/primary", "caravel/reviewer/primary", "New unread", "Body", "normal", "general", testDir);
    const unreadAgain = getMessages("caravel/reviewer/primary", true, testDir);
    assertEqual(unreadAgain.length, 1, "1 unread after sending new message");
  });

  runTest("  6.7 Message IDs are globally unique across channels", () => {
    const testDir2 = createTestDir();
    const m1 = sendMessage("caravel/a/primary", "caravel/b/primary", "M1", "B1", "normal", "ch1", testDir2);
    const m2 = sendMessage("caravel/a/primary", "caravel/b/primary", "M2", "B2", "normal", "ch2", testDir2);
    const m3 = sendMessage("caravel/a/primary", "caravel/b/primary", "M3", "B3", "normal", "ch3", testDir2);

    const ids = new Set([m1.id, m2.id, m3.id]);
    assertEqual(ids.size, 3, "all message IDs are unique");
    removeTestDir(testDir2);
  });
});

// ── Group 7: DEFAULT_CHANNELS export ──────────────────────────────────────────

runTest("Group 7: DEFAULT_CHANNELS", () => {
  runTest("  7.1 DEFAULT_CHANNELS contains 'general'", () => {
    assert(DEFAULT_CHANNELS.includes("general"), "includes 'general'");
  });

  runTest("  7.2 DEFAULT_CHANNELS contains 'review'", () => {
    assert(DEFAULT_CHANNELS.includes("review"), "includes 'review'");
  });

  runTest("  7.3 DEFAULT_CHANNELS contains 'escalation'", () => {
    assert(DEFAULT_CHANNELS.includes("escalation"), "includes 'escalation'");
  });

  runTest("  7.4 DEFAULT_CHANNELS has exactly 3 entries", () => {
    assertEqual(DEFAULT_CHANNELS.length, 3, "length is 3");
  });

  runTest("  7.5 DEFAULT_CHANNELS values are correct in order", () => {
    assertEqual(DEFAULT_CHANNELS[0], "general", "first is 'general'");
    assertEqual(DEFAULT_CHANNELS[1], "review", "second is 'review'");
    assertEqual(DEFAULT_CHANNELS[2], "escalation", "third is 'escalation'");
  });
});

// ── Group 8: getAvailableChannels ────────────────────────────────────────────

runTest("Group 8: getAvailableChannels", () => {
  runTest("  8.1 getAvailableChannels returns same values as DEFAULT_CHANNELS", () => {
    const channels = getAvailableChannels();
    assertEqual(channels.length, 3, "returns 3 channels");
    assertEqual(channels[0], "general", "first is 'general'");
    assertEqual(channels[1], "review", "second is 'review'");
    assertEqual(channels[2], "escalation", "third is 'escalation'");
  });

  runTest("  8.2 getAvailableChannels returns a copy (mutations don't affect DEFAULT_CHANNELS)", () => {
    const channels = getAvailableChannels();
    channels.push("fake-channel");
    const original = getAvailableChannels();
    assertEqual(original.length, 3, "original DEFAULT_CHANNELS unchanged");
  });
});

// ── Group 9: getChannelMessages ──────────────────────────────────────────────

runTest("Group 9: getChannelMessages", () => {
  let testDir = "";

  runTest("  9.1 getChannelMessages returns empty for nonexistent channel", () => {
    testDir = createTestDir();
    const msgs = getChannelMessages("nonexistent", undefined, testDir);
    assertEqual(msgs.length, 0, "no messages for nonexistent channel");
  });

  runTest("  9.2 getChannelMessages returns messages for existing channel", () => {
    const testDir2 = createTestDir();
    sendMessage("caravel/a/primary", "caravel/b/primary", "Msg 1", "Body 1", "normal", "test-ch", testDir2);
    sendMessage("caravel/a/primary", "caravel/b/primary", "Msg 2", "Body 2", "high", "test-ch", testDir2);

    const msgs = getChannelMessages("test-ch", undefined, testDir2);
    assertEqual(msgs.length, 2, "2 messages in channel");
    removeTestDir(testDir2);
  });

  runTest("  9.3 getChannelMessages with limit returns newest N", () => {
    const testDir2 = createTestDir();
    // Send 5 messages
    for (let i = 1; i <= 5; i++) {
      sendMessage("caravel/a/primary", "caravel/b/primary", `Msg ${i}`, `Body ${i}`, "normal", "lim-ch", testDir2);
    }
    const msgs = getChannelMessages("lim-ch", 3, testDir2);
    assertEqual(msgs.length, 3, "limit returns 3 messages");
    // Should be the last 3 (newest)
    assertEqual(msgs[0].subject, "Msg 3", "oldest of the 3 is Msg 3");
    assertEqual(msgs[2].subject, "Msg 5", "newest of the 3 is Msg 5");
    removeTestDir(testDir2);
  });

  runTest("  9.4 getChannelMessages with limit=1 returns 1", () => {
    const testDir2 = createTestDir();
    sendMessage("caravel/a/primary", "caravel/b/primary", "Only", "Body", "normal", "one-ch", testDir2);
    const msgs = getChannelMessages("one-ch", 1, testDir2);
    assertEqual(msgs.length, 1, "returns exactly 1 message");
    removeTestDir(testDir2);
  });

  runTest("  9.5 getChannelMessages with limit=0 returns empty", () => {
    const testDir2 = createTestDir();
    sendMessage("caravel/a/primary", "caravel/b/primary", "X", "Y", "normal", "zero-ch", testDir2);
    const msgs = getChannelMessages("zero-ch", 0, testDir2);
    assertEqual(msgs.length, 0, "limit=0 returns empty");
    removeTestDir(testDir2);
  });

  runTest("  9.6 getChannelMessages rejects negative limit", () => {
    testDir = createTestDir();
    assertThrows(() => getChannelMessages("ch", -1, testDir), "negative limit rejected");
  });

  runTest("  9.7 getChannelMessages rejects non-integer limit", () => {
    testDir = createTestDir();
    assertThrows(() => getChannelMessages("ch", 1.5, testDir), "non-integer limit rejected");
  });

  runTest("  9.8 getChannelMessages rejects empty channel", () => {
    testDir = createTestDir();
    assertThrows(() => getChannelMessages("", testDir), "empty channel rejected");
    assertThrows(() => getChannelMessages("  ", testDir), "whitespace channel rejected");
  });

  runTest("  9.9 getChannelMessages auto-creates the channel in storage", () => {
    const testDir2 = createTestDir();
    // Channel doesn't exist yet
    const fileBefore = loadMessagesFile(testDir2);
    assert(!("auto-ch" in (fileBefore?.channels || {})), "channel not in file before call");

    getChannelMessages("auto-ch", undefined, testDir2);

    const fileAfter = loadMessagesFile(testDir2);
    assert("auto-ch" in (fileAfter?.channels || {}), "channel auto-created in file");
    assertEqual(Array.isArray(fileAfter?.channels?.["auto-ch"]), true, "auto-ch is an array");
    removeTestDir(testDir2);
  });

  runTest("  9.10 getChannelMessages returns copies (mutations don't affect storage)", () => {
    const testDir2 = createTestDir();
    sendMessage("caravel/a/primary", "caravel/b/primary", "Mut", "Body", "normal", "copy-ch", testDir2);
    const msgs = getChannelMessages("copy-ch", undefined, testDir2);
    const before = msgs.length;
    msgs.length = 0;
    const after = getChannelMessages("copy-ch", undefined, testDir2);
    assertEqual(after.length, before, "storage unaffected by mutation");
    removeTestDir(testDir2);
  });
});

// ── Group 10: Auto-creation of <from>→<to> channels ─────────────────────────

runTest("Group 10: Agent-specific channel auto-creation", () => {
  runTest("  10.1 sendMessage auto-creates <from>→<to> channel", () => {
    const testDir = createTestDir();
    const from = "caravel/dev/primary";
    const to = "caravel/reviewer/primary";

    sendMessage(from, to, "First", "Body", "normal", "general", testDir);

    const file = loadMessagesFile(testDir);
    const agentChannel = `${from}→${to}`;
    assert(agentChannel in (file?.channels || {}), `<${from}→${to}> channel auto-created`);
    assertEqual(Array.isArray(file?.channels?.[agentChannel]), true, "auto-created channel is array");
    removeTestDir(testDir);
  });

  runTest("  10.2 Auto-created <from>→<to> channel persists after messages", () => {
    const testDir = createTestDir();
    const from = "caravel/lead/primary";
    const to = "caravel/dev/primary";
    const agentChannel = `${from}→${to}`;

    sendMessage(from, to, "Msg 1", "Body 1", "normal", "general", testDir);
    sendMessage(from, to, "Msg 2", "Body 2", "high", "general", testDir);

    const file = loadMessagesFile(testDir);
    assert(agentChannel in (file?.channels || {}), "agent channel still exists after messages");
    assertEqual(Array.isArray(file?.channels?.[agentChannel]), true, "agent channel is an array");
    // auto-created channel has its own empty array (messages go to the specified channel)
    assertEqual(file?.channels?.[agentChannel].length, 0, "auto-created channel is empty");
    removeTestDir(testDir);
  });

  runTest("  10.2b Messages sent to auto-created <from>→<to> channel are stored there", () => {
    const testDir = createTestDir();
    const from = "caravel/lead/primary";
    const to = "caravel/dev/primary";
    const agentChannel = `${from}→${to}`;

    sendMessage(from, to, "Msg 1", "Body 1", "normal", agentChannel, testDir);
    sendMessage(from, to, "Msg 2", "Body 2", "high", agentChannel, testDir);

    const file = loadMessagesFile(testDir);
    assertEqual(file?.channels?.[agentChannel].length, 2, "auto-created channel has 2 messages when targeted");
    assertEqual(file?.channels?.[agentChannel][0].subject, "Msg 1", "first message matches");
    assertEqual(file?.channels?.[agentChannel][1].subject, "Msg 2", "second message matches");
    removeTestDir(testDir);
  });

  runTest("  10.3 Different agent pairs get distinct auto-created channels", () => {
    const testDir = createTestDir();
    sendMessage("caravel/a/primary", "caravel/b/primary", "A→B", "Body", "normal", "general", testDir);
    sendMessage("caravel/b/primary", "caravel/a/primary", "B→A", "Body", "normal", "general", testDir);

    const file = loadMessagesFile(testDir);
    const ch1 = "caravel/a/primary→caravel/b/primary";
    const ch2 = "caravel/b/primary→caravel/a/primary";
    assert(ch1 in (file?.channels || {}), "A→B channel exists");
    assert(ch2 in (file?.channels || {}), "B→A channel exists");
    assert(ch1 !== ch2, "channels are distinct");
    removeTestDir(testDir);
  });

  runTest("  10.4 Messages sent to auto-created <from>→<to> channel are retrievable", () => {
    const testDir = createTestDir();
    const from = "caravel/agent-x/primary";
    const to = "caravel/agent-y/primary";
    const agentChannel = `${from}→${to}`;

    sendMessage(from, to, "Hello", "Hey there!", "urgent", agentChannel, testDir);

    const msgs = getChannelMessages(agentChannel, undefined, testDir);
    assertEqual(msgs.length, 1, "auto-created channel has 1 message");
    assertEqual(msgs[0].subject, "Hello", "message in auto-created channel matches");
    assertEqual(msgs[0].from, from, "message from matches sender");
    assertEqual(msgs[0].to, to, "message to matches recipient");
    removeTestDir(testDir);
  });

  runTest("  10.5 Auto-created <from>→<to> channel persists to file even without prior messages", () => {
    const testDir = createTestDir();
    const from = "caravel/new/primary";
    const to = "caravel/agent-z/primary";

    // Before: no messages, file may not exist
    const beforeFile = loadMessagesFile(testDir);
    const hadAgentCh = beforeFile ? `${from}→${to}` in (beforeFile.channels || {}) : false;
    assert(!hadAgentCh, "agent channel did not exist before");

    sendMessage(from, to, "First contact", "Hi!", "normal", "general", testDir);

    const afterFile = loadMessagesFile(testDir);
    assert(`${from}→${to}` in (afterFile?.channels || {}), "agent channel exists after first message");
    removeTestDir(testDir);
  });
});

// ── Group 11: sendNudge ───────────────────────────────────────────────────────

runTest("Group 11: sendNudge", () => {
  let testDir = "";

  runTest("  11.1 sendNudge creates a high-priority message with expiry", () => {
    testDir = createTestDir();
    const nudge = sendNudge("caravel/dev/primary", "caravel/reviewer/primary", "Quick check required", testDir);
    assertEqual(nudge.priority, "high", "nudge has high priority");
    assertEqual(nudge.channel, "general", "nudge goes to general channel");
    assertEqual(nudge.subject, "Quick check required", "subject = message text");
    assertEqual(nudge.body, "Quick check required", "body = message text");
    assert(nudge.expiryAt !== null, "nudge has expiryAt");
    assert(typeof nudge.expiryAt === "number", "expiryAt is a number");
    assertEqual(nudge.resolved, false, "nudge is not resolved");
  });

  runTest("  11.2 sendNudge expiryAt is ~5 min from now", () => {
    const testDir2 = createTestDir();
    const before = Date.now();
    const nudge = sendNudge("caravel/a/primary", "caravel/b/primary", "Now", testDir2);
    const after = Date.now();
    const expectedMin = before + NUDGE_EXPIRY_MS;
    const expectedMax = after + NUDGE_EXPIRY_MS;
    assert(nudge.expiryAt! >= expectedMin, "expiryAt >= now + 5min");
    assert(nudge.expiryAt! <= expectedMax, "expiryAt <= now + 5min (tolerant)");
    removeTestDir(testDir2);
  });

  runTest("  11.3 sendNudge validates empty sender", () => {
    const testDir2 = createTestDir();
    assertThrows(() => sendNudge("", "caravel/b/primary", "msg", testDir2), "empty sender rejected");
    removeTestDir(testDir2);
  });

  runTest("  11.4 sendNudge validates empty recipient", () => {
    const testDir2 = createTestDir();
    assertThrows(() => sendNudge("caravel/a/primary", "", "msg", testDir2), "empty recipient rejected");
    removeTestDir(testDir2);
  });

  runTest("  11.5 sendNudge validates empty message", () => {
    const testDir2 = createTestDir();
    assertThrows(() => sendNudge("caravel/a/primary", "caravel/b/primary", "", testDir2), "empty message rejected");
    removeTestDir(testDir2);
  });

  runTest("  11.6 sendNudge stores message in persistence", () => {
    const testDir2 = createTestDir();
    sendNudge("caravel/a/primary", "caravel/b/primary", "Persist me", testDir2);
    const file = loadMessagesFile(testDir2);
    const nudges = file?.channels?.["general"]?.filter((m: any) => m.priority === "high" && m.expiryAt !== null);
    assert(nudges !== undefined && nudges.length >= 1, "nudge persisted in file");
    removeTestDir(testDir2);
  });
});

// ── Group 12: escalate ───────────────────────────────────────────────────────

runTest("Group 12: escalate", () => {
  let testDir = "";

  runTest("  12.1 escalate creates messages for all escalation recipients", () => {
    testDir = createTestDir();
    const results = escalate("caravel/dev/primary", "caravel/lead/primary", "Bug in production", "Critical issue", testDir);
    assertEqual(results.length, ESCALATION_RECIPIENTS.length, `creates ${ESCALATION_RECIPIENTS.length} messages`);
    assertEqual(results[0].to, "tech-lead", "first recipient is tech-lead");
    assertEqual(results[1].to, "orchestrator", "second recipient is orchestrator");
  });

  runTest("  12.2 escalate sets priority to 'escalation'", () => {
    const testDir2 = createTestDir();
    const results = escalate("caravel/a/primary", "caravel/b/primary", "Subj", "Body", testDir2);
    for (const msg of results) {
      assertEqual(msg.priority, "escalation", `priority is 'escalation' for msg ${msg.id}`);
    }
    removeTestDir(testDir2);
  });

  runTest("  12.3 escalate sets channel to 'escalation'", () => {
    const testDir2 = createTestDir();
    const results = escalate("caravel/a/primary", "caravel/b/primary", "Subj", "Body", testDir2);
    for (const msg of results) {
      assertEqual(msg.channel, "escalation", `channel is 'escalation' for msg ${msg.id}`);
    }
    removeTestDir(testDir2);
  });

  runTest("  12.4 escalate sets resolved to false", () => {
    const testDir2 = createTestDir();
    const results = escalate("caravel/a/primary", "caravel/b/primary", "Subj", "Body", testDir2);
    for (const msg of results) {
      assertEqual(msg.resolved, false, `resolved is false for msg ${msg.id}`);
    }
    removeTestDir(testDir2);
  });

  runTest("  12.5 escalate includes escalationId in subject", () => {
    const testDir2 = createTestDir();
    const results = escalate("caravel/a/primary", "caravel/b/primary", "Test Escalation", "Details", testDir2);
    for (const msg of results) {
      assert(msg.subject.startsWith(`[escalation:${msg.id}]`), `subject includes [escalation:${msg.id}]`);
    }
    removeTestDir(testDir2);
  });

  runTest("  12.6 escalate includes sender/to info in body", () => {
    const testDir2 = createTestDir();
    const from = "caravel/dev/primary";
    const to = "caravel/lead/primary";
    const results = escalate(from, to, "Urgent", "Fix it now", testDir2);
    for (const msg of results) {
      assert(msg.body.includes(`From: ${from}`), `body includes From: ${from}`);
      assert(msg.body.includes(`To: ${to}`), `body includes To: ${to}`);
      assert(msg.body.includes(`Escalation #${msg.id}`), `body includes Escalation #${msg.id}`);
    }
    removeTestDir(testDir2);
  });

  runTest("  12.7 escalate rejects empty sender", () => {
    const testDir2 = createTestDir();
    assertThrows(() => escalate("", "caravel/b/primary", "s", "b", testDir2), "empty from rejected");
    removeTestDir(testDir2);
  });

  runTest("  12.8 escalate rejects empty recipient", () => {
    const testDir2 = createTestDir();
    assertThrows(() => escalate("caravel/a/primary", "", "s", "b", testDir2), "empty to rejected");
    removeTestDir(testDir2);
  });

  runTest("  12.9 escalate rejects empty subject", () => {
    const testDir2 = createTestDir();
    assertThrows(() => escalate("caravel/a/primary", "caravel/b/primary", "", "b", testDir2), "empty subject rejected");
    removeTestDir(testDir2);
  });

  runTest("  12.10 escalate rejects empty body", () => {
    const testDir2 = createTestDir();
    assertThrows(() => escalate("caravel/a/primary", "caravel/b/primary", "s", "", testDir2), "empty body rejected");
    removeTestDir(testDir2);
  });

  runTest("  12.11 Escalation messages are persisted to escalation channel in file", () => {
    const testDir2 = createTestDir();
    escalate("caravel/a/primary", "caravel/b/primary", "Persist", "Body", testDir2);
    const file = loadMessagesFile(testDir2);
    const escMessages = file?.channels?.["escalation"] || [];
    assertEqual(escMessages.length, 2, "2 escalation messages in file");
    removeTestDir(testDir2);
  });
});

// ── Group 13: getUnresolvedNudges ─────────────────────────────────────────────

runTest("Group 13: getUnresolvedNudges", () => {
  let testDir = "";

  runTest("  13.1 getUnresolvedNudges returns empty when no nudges exist", () => {
    testDir = createTestDir();
    const nudges = getUnresolvedNudges(testDir);
    assertEqual(nudges.length, 0, "no unresolved nudges");
  });

  runTest("  13.2 getUnresolvedNudges returns fresh nudge", () => {
    const testDir2 = createTestDir();
    sendNudge("caravel/a/primary", "caravel/b/primary", "New nudge", testDir2);
    const nudges = getUnresolvedNudges(testDir2);
    assertEqual(nudges.length, 1, "1 unresolved nudge");
    assertEqual(nudges[0].subject, "New nudge", "subject matches");
    assert(nudges[0].expiryAt! > Date.now(), "nudge not yet expired");
    removeTestDir(testDir2);
  });

  runTest("  13.3 getUnresolvedNudges filters out expired nudges", () => {
    const testDir2 = createTestDir();
    // Send a nudge
    sendNudge("caravel/a/primary", "caravel/b/primary", "Fresh", testDir2);
    // Simulate an expired nudge by writing one with past expiry
    const file = loadMessagesFile(testDir2) || { version: 1, nextId: 2, channels: { general: [] }, updatedAt: Date.now() };
    const expiredNudge = {
      id: 999,
      from: "caravel/a/primary",
      to: "caravel/b/primary",
      subject: "Expired nudge",
      body: "Expired nudge",
      priority: "high",
      createdAt: Date.now() - NUDGE_EXPIRY_MS - 1000,
      updatedAt: Date.now() - NUDGE_EXPIRY_MS - 1000,
      isRead: false,
      channel: "general",
      expiryAt: Date.now() - 1000,
      resolved: false,
    };
    file.channels["general"]!.push(expiredNudge);
    file.nextId = 1000;
    file.updatedAt = Date.now();
    fs.writeFileSync(
      path.join(testDir2, ".caravel", "messages.json"),
      JSON.stringify(file, null, 2),
      "utf-8",
    );

    const nudges = getUnresolvedNudges(testDir2);
    assertEqual(nudges.length, 1, "expired nudge filtered out");
    assertEqual(nudges[0].subject, "Fresh", "only fresh nudge returned");
    removeTestDir(testDir2);
  });

  runTest("  13.4 getUnresolvedNudges returns multiple unresolved nudges", () => {
    const testDir2 = createTestDir();
    sendNudge("caravel/a/primary", "caravel/b/primary", "Nudge 1", testDir2);
    sendNudge("caravel/a/primary", "caravel/b/primary", "Nudge 2", testDir2);
    sendNudge("caravel/a/primary", "caravel/b/primary", "Nudge 3", testDir2);
    const nudges = getUnresolvedNudges(testDir2);
    assertEqual(nudges.length, 3, "3 unresolved nudges");
    // Should be sorted by createdAt ascending
    assertEqual(nudges[0].subject, "Nudge 1", "sorted first");
    assertEqual(nudges[1].subject, "Nudge 2", "sorted second");
    assertEqual(nudges[2].subject, "Nudge 3", "sorted third");
    removeTestDir(testDir2);
  });

  runTest("  13.5 getUnresolvedNudges returns a copy (mutations don't affect storage)", () => {
    const testDir2 = createTestDir();
    sendNudge("caravel/a/primary", "caravel/b/primary", "Copy test", testDir2);
    const nudges = getUnresolvedNudges(testDir2);
    const before = nudges.length;
    nudges.length = 0;
    const after = getUnresolvedNudges(testDir2);
    assertEqual(after.length, before, "storage unaffected by mutation");
    removeTestDir(testDir2);
  });
});

// ── Group 14: getOpenEscalations ──────────────────────────────────────────────

runTest("Group 14: getOpenEscalations", () => {
  let testDir = "";

  runTest("  14.1 getOpenEscalations returns empty when no escalations", () => {
    testDir = createTestDir();
    const escs = getOpenEscalations(testDir);
    assertEqual(escs.length, 0, "no open escalations");
  });

  runTest("  14.2 getOpenEscalations returns unresolved escalations", () => {
    const testDir2 = createTestDir();
    escalate("caravel/a/primary", "caravel/b/primary", "Open Escalation", "Details", testDir2);
    const escs = getOpenEscalations(testDir2);
    assertEqual(escs.length, 2, "2 open escalations (one per recipient)");
    assertEqual(escs[0].priority, "escalation", "priority is escalation");
    assertEqual(escs[0].resolved, false, "resolved is false");
    removeTestDir(testDir2);
  });

  runTest("  14.3 getOpenEscalations filters out resolved escalations", () => {
    const testDir2 = createTestDir();
    const results = escalate("caravel/a/primary", "caravel/b/primary", "Resolve me", "Body", testDir2);
    // Resolve the escalation
    resolveEscalation(results[0].id, testDir2);

    const escs = getOpenEscalations(testDir2);
    assertEqual(escs.length, 0, "no open escalations after resolve");
    removeTestDir(testDir2);
  });

  runTest("  14.4 getOpenEscalations returns only priority 'escalation' messages", () => {
    const testDir2 = createTestDir();
    // Add a high-priority message to escalation channel (should not show up)
    const file = loadMessagesFile(testDir2) || { version: 1, nextId: 1, channels: { general: [], escalation: [] }, updatedAt: Date.now() };
    file.channels["escalation"]!.push({
      id: 888,
      from: "caravel/a/primary",
      to: "tech-lead",
      subject: "Not an escalation",
      body: "Just high priority",
      priority: "high",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      isRead: false,
      channel: "escalation",
      expiryAt: null,
      resolved: false,
    });
    file.nextId = 900;
    file.updatedAt = Date.now();
    fs.writeFileSync(
      path.join(testDir2, ".caravel", "messages.json"),
      JSON.stringify(file, null, 2),
      "utf-8",
    );

    // Now send a real escalation
    escalate("caravel/a/primary", "caravel/b/primary", "Real", "Body", testDir2);

    const escs = getOpenEscalations(testDir2);
    // Only the 2 from escalate() should be returned (priority='escalation'), not the fake one
    assertEqual(escs.length, 2, "only escalation priority messages returned");
    removeTestDir(testDir2);
  });

  runTest("  14.5 getOpenEscalations returns a copy", () => {
    const testDir2 = createTestDir();
    escalate("caravel/a/primary", "caravel/b/primary", "Copy", "Body", testDir2);
    const escs = getOpenEscalations(testDir2);
    const before = escs.length;
    escs.length = 0;
    const after = getOpenEscalations(testDir2);
    assertEqual(after.length, before, "storage unaffected by mutation");
    removeTestDir(testDir2);
  });
});

// ── Group 15: resolveEscalation ───────────────────────────────────────────────

runTest("Group 15: resolveEscalation", () => {
  let testDir = "";

  runTest("  15.1 resolveEscalation returns true for valid escalation", () => {
    testDir = createTestDir();
    const results = escalate("caravel/a/primary", "caravel/b/primary", "Resolve test", "Body", testDir);
    const resolved = resolveEscalation(results[0].id, testDir);
    assertEqual(resolved, true, "resolve returns true");
    // Verify it's now closed
    const open = getOpenEscalations(testDir);
    assertEqual(open.length, 0, "no open escalations after resolve");
  });

  runTest("  15.2 resolveEscalation returns false for unknown ID", () => {
    const result = resolveEscalation(99999, testDir);
    assertEqual(result, false, "false for unknown ID");
  });

  runTest("  15.3 resolveEscalation sets resolved=true on all recipients", () => {
    const testDir2 = createTestDir();
    const results = escalate("caravel/a/primary", "caravel/b/primary", "Multi resolve", "Body", testDir2);
    const escId = results[0].id;
    resolveEscalation(escId, testDir2);

    // Re-read from storage
    const file = loadMessagesFile(testDir2);
    const escMessages = file?.channels?.["escalation"] || [];
    for (const msg of escMessages) {
      if (msg.priority === "escalation") {
        assertEqual(msg.resolved, true, `msg ${msg.id} resolved`);
      }
    }
    removeTestDir(testDir2);
  });

  runTest("  15.4 resolveEscalation updates updatedAt", () => {
    const testDir2 = createTestDir();
    const results = escalate("caravel/a/primary", "caravel/b/primary", "Timestamp", "Body", testDir2);
    const escId = results[0].id;
    const before = Date.now();
    resolveEscalation(escId, testDir2);
    const after = Date.now();

    const file = loadMessagesFile(testDir2);
    const escMessages = file?.channels?.["escalation"] || [];
    const resolvedMsg = escMessages.find((m: any) => m.priority === "escalation" && m.resolved);
    assert(resolvedMsg !== undefined, "resolved message exists");
    assert(resolvedMsg.updatedAt >= before, `updatedAt after resolve >= ${before}`);
    assert(resolvedMsg.updatedAt <= after + 1000, `updatedAt after resolve <= ${after}+1000`);
    removeTestDir(testDir2);
  });

  runTest("  15.5 resolveEscalation is idempotent (double resolve returns true still)", () => {
    const testDir2 = createTestDir();
    const results = escalate("caravel/a/primary", "caravel/b/primary", "Idempotent", "Body", testDir2);
    const escId = results[0].id;
    resolveEscalation(escId, testDir2);
    const second = resolveEscalation(escId, testDir2);
    // Second resolve should still return true (it found and resolved the messages)
    assertEqual(second, true, "second resolve still returns true");
    removeTestDir(testDir2);
  });

  runTest("  15.6 resolveEscalation rejects negative ID", () => {
    const testDir2 = createTestDir();
    assertThrows(() => resolveEscalation(-1, testDir2), "negative ID rejected");
    removeTestDir(testDir2);
  });

  runTest("  15.7 resolveEscalation rejects non-integer ID", () => {
    const testDir2 = createTestDir();
    assertThrows(() => resolveEscalation(1.5, testDir2), "non-integer rejected");
    removeTestDir(testDir2);
  });

  runTest("  15.8 resolveEscalation persists to file", () => {
    const testDir2 = createTestDir();
    const results = escalate("caravel/a/primary", "caravel/b/primary", "Persist", "Body", testDir2);
    const escId = results[0].id;
    resolveEscalation(escId, testDir2);

    // Force a fresh read to verify persistence
    const freshFile = loadMessagesFile(testDir2);
    const escMessages = freshFile?.channels?.["escalation"] || [];
    for (const msg of escMessages) {
      if (msg.id === escId) {
        assertEqual(msg.resolved, true, "resolved persists to file");
      }
    }
    removeTestDir(testDir2);
  });
});

// ── Summary ────────────────────────────────────────────────────────────────────

console.log("\n═══════════════════════════════════════");
const total = passed + failed;
console.log(`Results: ${passed}/${total} passed, ${failed} failed`);

if (errors.length > 0) {
  console.error("\nFailures:");
  for (const e of errors) {
    console.error(`  ✗ ${e.test}: ${e.error}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
