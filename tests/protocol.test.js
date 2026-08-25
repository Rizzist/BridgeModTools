"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Protocol = require("../src/protocol.js");

const T = Protocol.TYPES;

function seen(messageId, updatedAt) {
  return { messageId, channelId: "10", content: messageId, status: "seen", capturedAt: updatedAt, updatedAt };
}

test("clear advances generation and rejects a stale in-flight capture", () => {
  const initial = Object.assign(Protocol.emptyArchive(), { records: [seen("1", 1)] });
  const cleared = Protocol.applyCommand(initial, { type: T.CLEAR_ARCHIVE }, 10);
  assert.equal(cleared.archive.generation, 1);
  assert.equal(cleared.archive.records.length, 0);
  const staleWrite = Protocol.applyCommand(cleared.archive, {
    type: T.UPSERT_RECORDS, generation: 0, records: [seen("2", 2)]
  }, 11);
  assert.equal(staleWrite.accepted, false);
  assert.equal(staleWrite.reason, "stale-generation");
  assert.equal(staleWrite.archive.records.length, 0);
});

test("pause advances generation and rejects captures while paused", () => {
  const paused = Protocol.applyCommand(Protocol.emptyArchive(), { type: T.SET_PAUSED, paused: true }, 10);
  assert.equal(paused.archive.generation, 1);
  const stale = Protocol.applyCommand(paused.archive, { type: T.UPSERT_RECORDS, generation: 0, records: [seen("1", 1)] }, 11);
  assert.equal(stale.reason, "stale-generation");
  const current = Protocol.applyCommand(paused.archive, { type: T.UPSERT_RECORDS, generation: 1, records: [seen("1", 1)] }, 11);
  assert.equal(current.reason, "paused");
});

test("inference persists anchors and live reappearance retracts to seen", () => {
  const base = Object.assign(Protocol.emptyArchive(), { records: [seen("2", 1)] });
  const inferred = Protocol.applyCommand(base, {
    type: T.INFER_DELETED, generation: 0, record: seen("2", 1),
    previousId: "1", nextId: "3", listIdentity: "g/c|chat-messages"
  }, 20);
  const record = inferred.archive.records[0];
  assert.equal(record.status, "inferred_deleted");
  assert.equal(record.inferredPreviousId, "1");
  assert.equal(record.inferredNextId, "3");
  const retracted = Protocol.applyCommand(inferred.archive, {
    type: T.RETRACT_MESSAGE, generation: 0, key: "10:2"
  }, 30);
  assert.equal(retracted.archive.records[0].status, "seen");
  assert.equal("inferredDeletedAt" in retracted.archive.records[0], false);
  assert.equal("inferredPreviousId" in retracted.archive.records[0], false);
});

test("Discord lifecycle confirmation persists exact status and cannot be retracted", () => {
  const base = Object.assign(Protocol.emptyArchive(), { records: [seen("2", 1)] });
  const confirmed = Protocol.applyCommand(base, {
    type: T.CONFIRM_DELETED,
    generation: 0,
    deletions: [{ record: seen("2", 1), previousId: "1", nextId: "3", listIdentity: "@me/10|chat-messages" }]
  }, 20);
  const record = confirmed.archive.records[0];
  assert.equal(record.status, "confirmed_deleted");
  assert.equal(record.deletionSource, "discord_lifecycle");
  assert.equal(record.confirmedDeletedAt, 20);
  const retracted = Protocol.applyCommand(confirmed.archive, {
    type: T.RETRACT_MESSAGE, generation: 0, key: "10:2"
  }, 30);
  assert.equal(retracted.archive.records[0].status, "confirmed_deleted");
  const staleSeen = Protocol.applyCommand(confirmed.archive, {
    type: T.UPSERT_RECORDS, generation: 0, records: [seen("2", 40)]
  }, 40);
  assert.equal(staleSeen.archive.records[0].status, "confirmed_deleted");
});

test("MessageStore retention is persisted as a distinct confirmed deletion source", () => {
  const base = Object.assign(Protocol.emptyArchive(), { records: [seen("2", 1)] });
  const confirmed = Protocol.applyCommand(base, {
    type: T.CONFIRM_DELETED,
    generation: 0,
    deletions: [{ record: seen("2", 1), source: "message_store_preserved" }]
  }, 20);
  assert.equal(confirmed.archive.records[0].status, "confirmed_deleted");
  assert.equal(confirmed.archive.records[0].deletionSource, "message_store_preserved");
});

test("MessageStore retention can promote a just-captured row even when the seen archive is saturated", () => {
  const confirmed = Protocol.applyCommand(Protocol.emptyArchive(), {
    type: T.CONFIRM_DELETED,
    generation: 0,
    deletions: [{ record: seen("77", 1), source: "message_store_preserved" }]
  }, 20);
  assert.equal(confirmed.accepted, true);
  assert.equal(confirmed.archive.records[0].messageId, "77");
  assert.equal(confirmed.archive.records[0].status, "confirmed_deleted");
});

test("a clear or pause generation boundary rejects an old lifecycle deletion", () => {
  const initial = Object.assign(Protocol.emptyArchive(), { records: [seen("2", 1)] });
  const cleared = Protocol.applyCommand(initial, { type: T.CLEAR_ARCHIVE }, 10);
  const staleAfterClear = Protocol.applyCommand(cleared.archive, {
    type: T.CONFIRM_DELETED, generation: 0, deletions: [{ record: seen("2", 1) }]
  }, 11);
  assert.equal(staleAfterClear.accepted, false);
  assert.equal(staleAfterClear.archive.records.length, 0);
  const paused = Protocol.applyCommand(initial, { type: T.SET_PAUSED, paused: true }, 20);
  const staleAfterPause = Protocol.applyCommand(paused.archive, {
    type: T.CONFIRM_DELETED, generation: 0, deletions: [{ record: seen("2", 1) }]
  }, 21);
  assert.equal(staleAfterPause.accepted, false);
  assert.equal(staleAfterPause.archive.records[0].status, "seen");
});

test("lifecycle confirmation cannot create a record that was never archived", () => {
  const forged = Protocol.applyCommand(Protocol.emptyArchive(), {
    type: T.CONFIRM_DELETED,
    generation: 0,
    deletions: [{ record: seen("99", 1) }]
  }, 20);
  assert.equal(forged.accepted, false);
  assert.equal(forged.reason, "missing-records");
  assert.equal(forged.archive.records.length, 0);
});

test("single-record reads return only the requested archived record", () => {
  const archive = Object.assign(Protocol.emptyArchive(), { records: [seen("1", 1), seen("2", 2)] });
  const found = Protocol.applyCommand(archive, { type: T.GET_RECORD, key: "10:2" }, 10);
  assert.equal(found.data.messageId, "2");
  assert.equal(found.archive.records.length, 2);
  const missing = Protocol.applyCommand(archive, { type: T.GET_RECORD, key: "10:9" }, 10);
  assert.equal(missing.data, null);
});

test("tail inference persists its remount placement flag", () => {
  const inferred = Protocol.applyCommand(Protocol.emptyArchive(), {
    type: T.INFER_DELETED,
    generation: 0,
    record: seen("9", 1),
    previousId: "8",
    tail: true,
    listIdentity: "g/c|chat-messages"
  }, 20);
  assert.equal(inferred.archive.records[0].inferredTail, true);
  assert.equal(inferred.archive.records[0].inferredPreviousId, "8");
  assert.equal(inferred.archive.records[0].inferredNextId, null);
});

test("per-record deletion advances generation to block stale recapture", () => {
  const base = Object.assign(Protocol.emptyArchive(), { records: [seen("1", 1), seen("2", 2)] });
  const deleted = Protocol.applyCommand(base, { type: T.DELETE_RECORD, key: "10:1" }, 10);
  assert.equal(deleted.archive.generation, 1);
  assert.deepEqual(deleted.archive.records.map((record) => record.messageId), ["2"]);
  const stale = Protocol.applyCommand(deleted.archive, {
    type: T.UPSERT_RECORDS, generation: 0, records: [seen("1", 20)]
  }, 20);
  assert.equal(stale.accepted, false);
});

test("revision increases on every changed command and not on rejected commands", () => {
  const health = Protocol.applyCommand(Protocol.emptyArchive(), { type: T.SET_HEALTH, status: "active" }, 1);
  assert.equal(health.archive.revision, 1);
  const upsert = Protocol.applyCommand(health.archive, {
    type: T.UPSERT_RECORDS, generation: 0, records: [seen("1", 2)]
  }, 2);
  assert.equal(upsert.archive.revision, 2);
  const cleared = Protocol.applyCommand(upsert.archive, { type: T.CLEAR_ARCHIVE }, 3);
  assert.equal(cleared.archive.revision, 3);
  const stale = Protocol.applyCommand(cleared.archive, {
    type: T.UPSERT_RECORDS, generation: 0, records: [seen("2", 4)]
  }, 4);
  assert.equal(stale.changed, false);
  assert.equal(stale.archive.revision, 3);
});

test("archive snapshot ordering rejects lower generation or same-generation lower revision", () => {
  const current = Object.assign(Protocol.emptyArchive(), { generation: 4, revision: 9 });
  assert.equal(Protocol.shouldApplyArchive(current, Object.assign({}, current, { generation: 3, revision: 20 })), false);
  assert.equal(Protocol.shouldApplyArchive(current, Object.assign({}, current, { revision: 8 })), false);
  assert.equal(Protocol.shouldApplyArchive(current, Object.assign({}, current, { revision: 10 })), true);
  assert.equal(Protocol.shouldApplyArchive(current, Object.assign({}, current, { generation: 5, revision: 1 })), true);
});

test("confirmed deletions survive archive serialization and a fresh normalization", () => {
  const base = Object.assign(Protocol.emptyArchive(), { records: [seen("2", 1)] });
  const confirmed = Protocol.applyCommand(base, {
    type: T.CONFIRM_DELETED,
    generation: 0,
    deletions: [{
      record: seen("2", 1),
      source: "message_store_preserved",
      previousId: "1",
      nextId: "3",
      listIdentity: "@me/10|chat-messages"
    }]
  }, 20).archive;
  const restored = Protocol.normalizeArchive(JSON.parse(JSON.stringify(confirmed)));
  assert.equal(restored.records.length, 1);
  assert.equal(restored.records[0].status, "confirmed_deleted");
  assert.equal(restored.records[0].deletionSource, "message_store_preserved");
  assert.equal(restored.records[0].inferredPreviousId, "1");
  assert.equal(restored.records[0].inferredNextId, "3");
});

test("archive normalization migrates to version 3 and sanitizes presentation", () => {
  const restored = Protocol.normalizeArchive({
    version: 2,
    generation: 4,
    records: [Object.assign(seen("2", 1), {
      authorStyle: { gradient: "linear-gradient(red, blue), var(--bad)" },
      authorBadges: [{ kind: "image", url: "javascript:alert(1)" }]
    })]
  });
  assert.equal(restored.version, 3);
  assert.equal(restored.generation, 4);
  assert.equal(restored.records[0].authorStyle, undefined);
  assert.deepEqual(restored.records[0].authorBadges, []);
});
