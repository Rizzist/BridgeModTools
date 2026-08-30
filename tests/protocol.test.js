"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Protocol = require("../src/protocol.js");
const Core = require("../src/core.js");

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

test("genuine edit lifecycle preserves multiple prior payloads without changing deletion status", () => {
  const original = seen("2", 1);
  original.content = "A";
  let archive = Object.assign(Protocol.emptyArchive(), { records: [original] });
  const editA = Protocol.applyCommand(archive, {
    type: T.CONFIRM_EDIT,
    generation: 0,
    record: original,
    editedAt: 100,
    editSessionId: "page-session",
    editSequence: 1
  }, 100);
  assert.equal(editA.accepted, true);
  assert.equal(editA.archive.records[0].editHistory[0].content, "A");
  assert.equal(editA.archive.records[0].status, "seen");

  const versionB = Object.assign(seen("2", 110), { content: "B", captureSessionId: "capture", captureSequence: 2 });
  archive = Protocol.applyCommand(editA.archive, {
    type: T.UPSERT_RECORDS, generation: 0, records: [versionB]
  }, 110).archive;
  assert.equal(archive.records[0].content, "B");
  assert.deepEqual(archive.records[0].editHistory.map((revision) => revision.content), ["A"]);

  archive = Protocol.applyCommand(archive, {
    type: T.CONFIRM_EDIT,
    generation: 0,
    record: versionB,
    editedAt: 120,
    editSessionId: "page-session",
    editSequence: 2
  }, 120).archive;
  const versionC = Object.assign(seen("2", 130), { content: "C", captureSessionId: "capture", captureSequence: 3 });
  archive = Protocol.applyCommand(archive, {
    type: T.UPSERT_RECORDS, generation: 0, records: [versionC]
  }, 130).archive;
  assert.deepEqual(archive.records[0].editHistory.map((revision) => revision.content), ["A", "B"]);
  assert.equal(archive.records[0].content, "C");

  const duplicate = Protocol.applyCommand(archive, {
    type: T.CONFIRM_EDIT,
    generation: 0,
    record: versionB,
    editedAt: 120,
    editSessionId: "page-session",
    editSequence: 2
  }, 140);
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.reason, "duplicate-edit");

  const staleAcrossSession = Protocol.applyCommand(archive, {
    type: T.CONFIRM_EDIT,
    generation: 0,
    record: versionB,
    editedAt: 120,
    editSessionId: "reloaded-page-session",
    editSequence: 1
  }, 150);
  assert.equal(staleAcrossSession.changed, false);
  assert.equal(staleAcrossSession.reason, "stale-edit");
  assert.deepEqual(staleAcrossSession.archive.records[0].editHistory.map((revision) => revision.content), ["A", "B"]);
  const olderAcrossSession = Protocol.applyCommand(archive, {
    type: T.CONFIRM_EDIT,
    generation: 0,
    record: versionB,
    editedAt: 119,
    editSessionId: "another-page-session",
    editSequence: 1
  }, 151);
  assert.equal(olderAcrossSession.reason, "stale-edit");
});

test("edit history compounds with deletion and late seen capture cannot overwrite the deleted latest payload", () => {
  const original = Object.assign(seen("2", 1), { content: "original" });
  let archive = Protocol.applyCommand(Object.assign(Protocol.emptyArchive(), { records: [original] }), {
    type: T.CONFIRM_EDIT, generation: 0, record: original, editedAt: 10,
    editSessionId: "session", editSequence: 1
  }, 10).archive;
  const edited = Object.assign(seen("2", 20), { content: "edited" });
  archive = Protocol.applyCommand(archive, {
    type: T.UPSERT_RECORDS, generation: 0, records: [edited]
  }, 20).archive;
  archive = Protocol.applyCommand(archive, {
    type: T.CONFIRM_DELETED,
    generation: 0,
    deletions: [{ record: edited, source: "message_store_preserved" }]
  }, 30).archive;
  assert.equal(archive.records[0].status, "confirmed_deleted");
  assert.equal(archive.records[0].content, "edited");
  assert.deepEqual(archive.records[0].editHistory.map((revision) => revision.content), ["original"]);
  const late = Protocol.applyCommand(archive, {
    type: T.UPSERT_RECORDS,
    generation: 0,
    records: [Object.assign(seen("2", 40), { content: "stale" })]
  }, 40).archive;
  assert.equal(late.records[0].content, "edited");
  assert.deepEqual(late.records[0].editHistory.map((revision) => revision.content), ["original"]);
});

test("out-of-order same-session edit retries preserve every novel baseline without rolling back the cursor", () => {
  const original = Object.assign(seen("2", 1), { content: "current" });
  let archive = Object.assign(Protocol.emptyArchive(), { records: [original] });
  archive = Protocol.applyCommand(archive, {
    type: T.CONFIRM_EDIT,
    generation: 0,
    record: Object.assign({}, original, { content: "B" }),
    editedAt: 200,
    editSessionId: "session",
    editSequence: 2
  }, 200).archive;
  const lateEarlier = Protocol.applyCommand(archive, {
    type: T.CONFIRM_EDIT,
    generation: 0,
    record: Object.assign({}, original, { content: "A" }),
    editedAt: 100,
    editSessionId: "session",
    editSequence: 1
  }, 210);
  assert.equal(lateEarlier.reason, "out-of-order-edit");
  assert.deepEqual(lateEarlier.archive.records[0].editHistory.map((revision) => revision.content), ["A", "B"]);
  assert.equal(lateEarlier.archive.records[0].lastEditSequence, 2);
  assert.equal(lateEarlier.archive.records[0].lastEditedAt, 200);
  assert.equal(lateEarlier.archive.records[0].content, "current");
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

test("direct retained confirmation promotes the freshest observed body without a seen upsert", () => {
  const old = { ...seen("2", 10), content: "old body", captureSessionId: "page", captureSequence: 1,
    attachments: ["old.png"], media: [{ kind: "image", url: "https://cdn.discordapp.com/attachments/1/2/old.png" }],
    reply: { messageId: "222222222222222222", content: "old quote", state: "available" } };
  const fresh = { ...old, content: "fresh body", capturedAt: 20, captureSequence: 2,
    attachments: ["new.png"], media: [{ kind: "image", url: "https://cdn.discordapp.com/attachments/1/2/new.png" }],
    reply: { ...old.reply, content: "fresh quote" } };
  const confirmed = Protocol.applyCommand({ ...Protocol.emptyArchive(), records: [old] }, {
    type: T.CONFIRM_DELETED, generation: 0, deletions: [{ record: fresh, source: "message_store_preserved" }]
  }, 30).archive.records[0];
  assert.equal(confirmed.status, "confirmed_deleted");
  assert.equal(confirmed.content, "fresh body");
  assert.deepEqual(confirmed.attachments, ["new.png"]);
  assert.equal(confirmed.media[0].url, fresh.media[0].url);
  assert.equal(confirmed.reply.content, "fresh quote");
  assert.equal(confirmed.capturedAt, 20);
  assert.equal(confirmed.captureSequence, 2);
});

test("confirmation snapshot freshness uses session sequence and cross-session capture time", () => {
  const current = { ...seen("2", 20), content: "current", captureSessionId: "page-a", captureSequence: 2,
    reply: { messageId: "222222222222222222", content: "current quote", state: "available" } };
  const cases = [
    { snapshot: { ...current, content: "older sequence", captureSequence: 1, capturedAt: 100 }, expected: "current" },
    { snapshot: { ...current, content: "same sequence", capturedAt: 100 }, expected: "current" },
    { snapshot: { ...current, content: "new sequence", captureSequence: 3, capturedAt: 10 }, expected: "new sequence" },
    { snapshot: { ...current, content: "older session capture", captureSessionId: "page-b", captureSequence: 999, capturedAt: 10 }, expected: "current" },
    { snapshot: { ...current, content: "newer session capture", captureSessionId: "page-b", captureSequence: 1, capturedAt: 30 }, expected: "newer session capture" },
    { snapshot: { ...seen("2", 30), content: "newer unsequenced capture" }, expected: "newer unsequenced capture" }
  ];
  for (const { snapshot, expected } of cases) {
    snapshot.reply = { ...current.reply, content: "incoming quote" };
    const result = Protocol.applyCommand({ ...Protocol.emptyArchive(), records: [current] }, {
      type: T.CONFIRM_DELETED, generation: 0, deletions: [{ record: snapshot, source: "message_store_preserved" }]
    }, 200).archive.records[0];
    assert.equal(result.content, expected, snapshot.content);
    assert.equal(result.reply.content, expected === "current" ? "current quote" : "incoming quote", snapshot.content);
  }
});

test("direct deletion payload refresh preserves compounded edit history and its cursor", () => {
  const original = { ...seen("2", 1), content: "A", captureSessionId: "capture", captureSequence: 1 };
  let archive = Protocol.applyCommand({ ...Protocol.emptyArchive(), records: [original] }, {
    type: T.CONFIRM_EDIT, generation: 0, record: original, editedAt: 10,
    editSessionId: "edit-page", editSequence: 1
  }, 10).archive;
  const second = { ...original, content: "B", capturedAt: 11, captureSequence: 2 };
  archive = Protocol.applyCommand(archive, { type: T.UPSERT_RECORDS, generation: 0, records: [second] }, 11).archive;
  archive = Protocol.applyCommand(archive, {
    type: T.CONFIRM_EDIT, generation: 0, record: second, editedAt: 20,
    editSessionId: "edit-page", editSequence: 2
  }, 20).archive;
  const latest = { ...second, content: "C", capturedAt: 21, captureSequence: 3,
    editHistory: [{ revisionId: "stale:1", content: "stale incoming history", supersededAt: 2 }],
    editSessionId: "stale-edit-page", lastEditSequence: 1, lastEditedAt: 2 };
  const confirmed = Protocol.applyCommand(archive, {
    type: T.CONFIRM_DELETED, generation: 0, deletions: [{ record: latest, source: "message_store_preserved" }]
  }, 30).archive.records[0];
  assert.equal(confirmed.content, "C");
  assert.deepEqual(confirmed.editHistory.map((revision) => revision.content), ["A", "B"]);
  assert.equal(confirmed.editSessionId, "edit-page");
  assert.equal(confirmed.lastEditSequence, 2);
  assert.equal(confirmed.lastEditedAt, 20);
});

test("replayed confirmations cannot replace an already confirmed body or reply", () => {
  const prior = { ...seen("2", 10), content: "authoritative body", status: "confirmed_deleted",
    captureSessionId: "page", captureSequence: 1,
    attachments: ["original.png"], media: [{ kind: "image", url: "https://cdn.discordapp.com/attachments/1/2/original.png" }],
    reply: { messageId: "222222222222222222", content: "authoritative quote", state: "available" } };
  const replay = { ...prior, content: "stale retained DOM", capturedAt: 20, captureSequence: 2,
    attachments: [], media: [], reply: { ...prior.reply, content: "stale retained quote" } };
  const result = Protocol.applyCommand({ ...Protocol.emptyArchive(), records: [prior] }, {
    type: T.CONFIRM_DELETED, generation: 0, deletions: [{ record: replay, source: "message_store_preserved" }]
  }, 30).archive.records[0];
  assert.equal(result.content, prior.content);
  assert.deepEqual(result.attachments, prior.attachments);
  assert.equal(result.media[0].url, prior.media[0].url);
  assert.equal(result.reply.content, prior.reply.content);
  assert.equal(result.capturedAt, prior.capturedAt);
  assert.equal(result.captureSequence, prior.captureSequence);
});

test("MessageStore retention can promote a just-captured row absent from the archive", () => {
  const confirmed = Protocol.applyCommand(Protocol.emptyArchive(), {
    type: T.CONFIRM_DELETED,
    generation: 0,
    deletions: [{ record: seen("77", 1), source: "message_store_preserved" }]
  }, 20);
  assert.equal(confirmed.accepted, true);
  assert.equal(confirmed.archive.records[0].messageId, "77");
  assert.equal(confirmed.archive.records[0].status, "confirmed_deleted");
});

test("actual saturation preserves a newly posted tail for lifecycle confirmation", () => {
  const deleted = Array.from({ length: Core.DEFAULTS.maxRecords }, (_, index) => ({
    ...seen(String(100000000000000000n + BigInt(index)), index + 1), status: "confirmed_deleted"
  }));
  const fresh = Array.from({ length: Core.DEFAULTS.seenReserve + 10 }, (_, index) =>
    seen(String(200000000000000000n + BigInt(index)), 2000));
  const captured = Protocol.applyCommand({ ...Protocol.emptyArchive(), records: deleted }, {
    type: T.UPSERT_RECORDS, generation: 0, records: fresh
  }, 3000);
  assert.equal(captured.archive.records.length, Core.DEFAULTS.maxRecords);
  assert.equal(captured.archive.records.filter((record) => record.status === "seen").length, Core.DEFAULTS.seenReserve);
  const tail = fresh.at(-1);
  assert.ok(captured.archive.records.some((record) => record.messageId === tail.messageId));
  const confirmed = Protocol.applyCommand(captured.archive, {
    type: T.CONFIRM_DELETED, generation: 0, deletions: [{ record: tail }]
  }, 3001);
  assert.equal(confirmed.accepted, true);
  assert.equal(confirmed.archive.records.find((record) => record.messageId === tail.messageId).status, "confirmed_deleted");

  const pruned = fresh[0];
  assert.equal(captured.archive.records.some((record) => record.messageId === pruned.messageId), false);
  const unverified = Protocol.applyCommand(captured.archive, {
    type: T.CONFIRM_DELETED, generation: 0, deletions: [{ record: pruned }]
  }, 3001);
  assert.equal(unverified.reason, "missing-records", "generic lifecycle events cannot introduce unknown snapshots");
  const retained = Protocol.applyCommand(captured.archive, {
    type: T.CONFIRM_DELETED, generation: 0, deletions: [{ record: pruned, source: "message_store_preserved" }]
  }, 3001);
  assert.equal(retained.accepted, true);
  assert.equal(retained.archive.records.find((record) => record.messageId === pruned.messageId).status, "confirmed_deleted");
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

test("archive normalization migrates to version 6 and sanitizes presentation", () => {
  const restored = Protocol.normalizeArchive({
    version: 2,
    generation: 4,
    records: [Object.assign(seen("2", 1), {
      authorStyle: { gradient: "linear-gradient(red, blue), var(--bad)" },
      authorBadges: [{ kind: "image", url: "javascript:alert(1)" }],
      editHistory: [{
        revisionId: "legacy-edit:1",
        content: "original text",
        attachments: ["before.png"],
        media: [{
          url: "https://cdn.discordapp.com/attachments/111111111111111111/222222222222222222/before.png",
          kind: "image",
          source: "attachment"
        }],
        supersededAt: 10
      }]
    })]
  });
  assert.equal(restored.version, 6);
  assert.equal(restored.generation, 4);
  assert.equal(restored.records[0].authorStyle, undefined);
  assert.deepEqual(restored.records[0].authorBadges, []);
  assert.equal(restored.records[0].editHistory[0].content, "original text");
  assert.equal(restored.records[0].editHistory[0].media[0].kind, "image");
});

test("version 6 migration preserves legacy replies through edit, deletion, and serialization", () => {
  const record = Object.assign(seen("2", 1), { replyPreview: "Quoted legacy text" });
  let archive = Protocol.normalizeArchive({ version: 5, generation: 0, records: [record] });
  assert.equal(archive.version, 6);
  assert.deepEqual(archive.records[0].reply, { fallbackText: "Quoted legacy text", state: "legacy" });
  assert.equal(archive.records[0].replyPreview, undefined);

  archive = Protocol.applyCommand(archive, {
    type: T.CONFIRM_EDIT, generation: 0, record: archive.records[0], editedAt: 10,
    editSessionId: "reply-session", editSequence: 1
  }, 10).archive;
  assert.equal(archive.records[0].editHistory[0].reply, undefined);
  assert.equal(archive.records[0].reply.fallbackText, "Quoted legacy text");

  archive = Protocol.applyCommand(archive, {
    type: T.CONFIRM_DELETED, generation: 0,
    deletions: [{ record: archive.records[0], source: "message_store_preserved" }]
  }, 20).archive;
  const restored = Protocol.normalizeArchive(JSON.parse(JSON.stringify(archive)));
  assert.equal(restored.version, 6);
  assert.equal(restored.records[0].status, "confirmed_deleted");
  assert.equal(restored.records[0].reply.state, "legacy");
  assert.equal(restored.records[0].reply.fallbackText, "Quoted legacy text");
});

test("edit and deletion lifecycle commands can safely hydrate a missing reply snapshot", () => {
  const base = Object.assign(Protocol.emptyArchive(), { records: [seen("2", 1)] });
  const withReply = Object.assign(seen("2", 1), {
    reply: {
      messageId: "222222222222222222", channelId: "111111111111111111",
      content: "quoted target", state: "available"
    }
  });
  const edited = Protocol.applyCommand(base, {
    type: T.CONFIRM_EDIT, generation: 0, record: withReply, editedAt: 10,
    editSessionId: "reply-hydration", editSequence: 1
  }, 10).archive;
  assert.equal(edited.records[0].reply.content, "quoted target");
  assert.equal(edited.records[0].editHistory[0].reply, undefined);

  const deletedBase = Object.assign(Protocol.emptyArchive(), { records: [seen("3", 1)] });
  const deleted = Protocol.applyCommand(deletedBase, {
    type: T.CONFIRM_DELETED, generation: 0,
    deletions: [{ record: Object.assign(seen("3", 1), { reply: withReply.reply }) }]
  }, 20).archive;
  assert.equal(deleted.records[0].status, "confirmed_deleted");
  assert.equal(deleted.records[0].reply.content, "quoted target");
});
