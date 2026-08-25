"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../src/core.js");

function acceptedSignal(overrides) {
  return Object.assign({
    candidateKnown: true,
    documentHidden: false,
    routeChanged: false,
    sameChannel: true,
    rootReplacement: false,
    removedMessageCount: 1,
    totalRemovedElementCount: 5,
    addedMessageCount: 0,
    msSinceScroll: 5000,
    msSinceRouteChange: 5000,
    targetConnected: true,
    listUnchanged: true,
    parentUnchanged: true,
    wasVisible: true,
    visibleRatio: 1,
    innerViewport: true,
    snapshotAgeMs: 100,
    currentlyPresent: false,
    previousAnchorPresent: true,
    nextAnchorPresent: true,
    anchorsAdjacent: true,
    previousAnchorDeltaPx: 0
  }, overrides || {});
}

test("parses server and direct-message channel routes", () => {
  assert.deepEqual(Core.parseDiscordRoute("/channels/123/456"), {
    guildId: "123", channelId: "456", routeKey: "123/456"
  });
  assert.deepEqual(Core.parseDiscordRoute("/channels/@me/999"), {
    guildId: null, channelId: "999", routeKey: "@me/999"
  });
  assert.equal(Core.parseDiscordRoute("/settings/account"), null);
});

test("accepts only a stationary single-message removal with surviving anchors", () => {
  assert.deepEqual(Core.classifyRemoval(acceptedSignal()), {
    highConfidence: true,
    reason: "stationary-single-removal"
  });
});

test("rejects scroll virtualization, navigation, mass removals, and replacements", () => {
  assert.equal(Core.classifyRemoval(acceptedSignal({ msSinceScroll: 20 })).reason, "recent-scroll");
  assert.equal(Core.classifyRemoval(acceptedSignal({ routeChanged: true })).reason, "navigation");
  assert.equal(Core.classifyRemoval(acceptedSignal({ removedMessageCount: 2 })).reason, "invalid-removal-count");
  assert.equal(Core.classifyRemoval(acceptedSignal({ removedMessageCount: 0 })).reason, "invalid-removal-count");
  assert.equal(Core.classifyRemoval(acceptedSignal({ rootReplacement: true })).reason, "root-replacement");
  assert.equal(Core.classifyRemoval(acceptedSignal({ addedMessageCount: 1 })).reason, "list-replacement");
});

test("allows an attachment-sized single-row subtree but rejects a full list-sized subtree", () => {
  assert.equal(Core.classifyRemoval(acceptedSignal({ totalRemovedElementCount: 180 })).highConfidence, true);
  assert.equal(Core.classifyRemoval(acceptedSignal({ totalRemovedElementCount: 300 })).reason, "mass-dom-removal");
});

test("requires substantial inner-viewport visibility and unchanged list ownership", () => {
  assert.equal(Core.classifyRemoval(acceptedSignal({ visibleRatio: 0.5 })).reason, "offscreen-or-edge-visible");
  assert.equal(Core.classifyRemoval(acceptedSignal({ innerViewport: false })).reason, "offscreen-or-edge-visible");
  assert.equal(Core.classifyRemoval(acceptedSignal({ listUnchanged: false })).reason, "list-or-parent-changed");
  assert.equal(Core.classifyRemoval(acceptedSignal({ parentUnchanged: false })).reason, "list-or-parent-changed");
});

test("rejects missing anchors, moved layout, stale snapshots, and reappearing messages", () => {
  assert.equal(Core.classifyRemoval(acceptedSignal({ previousAnchorPresent: false })).reason, "missing-previous-anchor");
  assert.equal(Core.classifyRemoval(acceptedSignal({ previousAnchorDeltaPx: 9 })).reason, "layout-shift");
  assert.equal(Core.classifyRemoval(acceptedSignal({ snapshotAgeMs: 31000 })).reason, "stale-snapshot");
  assert.equal(Core.classifyRemoval(acceptedSignal({ currentlyPresent: true })).reason, "message-still-present");
});

test("accepts only a stationary at-bottom tail deletion with a fixed previous anchor", () => {
  const tail = acceptedSignal({
    tailCandidate: true,
    wasAtBottom: true,
    nextAnchorPresent: false,
    anchorsAdjacent: false
  });
  assert.deepEqual(Core.classifyRemoval(tail), {
    highConfidence: true,
    reason: "stationary-tail-removal"
  });
  assert.equal(Core.classifyRemoval(Object.assign({}, tail, { wasAtBottom: false })).reason, "tail-not-at-bottom");
  assert.equal(Core.classifyRemoval(Object.assign({}, tail, { previousAnchorPresent: false })).reason, "missing-previous-anchor");
  assert.equal(Core.classifyRemoval(Object.assign({}, tail, { msSinceScroll: 10 })).reason, "recent-scroll");
});

test("scroll-bottom helper is tolerant but rejects invalid or non-bottom metrics", () => {
  assert.equal(Core.isAtScrollBottom({ scrollTop: 976, scrollHeight: 2000, clientHeight: 1000 }), true);
  assert.equal(Core.isAtScrollBottom({ scrollTop: 900, scrollHeight: 2000, clientHeight: 1000 }), false);
  assert.equal(Core.isAtScrollBottom({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 }), false);
});

test("merge updates content but never downgrades inferred deletion", () => {
  const oldRecord = {
    messageId: "10", channelId: "20", content: "old", status: "inferred_deleted",
    inferredDeletedAt: 50, capturedAt: 1, updatedAt: 50
  };
  const merged = Core.mergeRecords([oldRecord], [{
    messageId: "10", channelId: "20", content: "new", status: "seen", capturedAt: 60
  }], { now: 60 });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].content, "new");
  assert.equal(merged[0].status, "inferred_deleted");
  assert.equal(merged[0].inferredDeletedAt, 50);
});

test("merge never downgrades a Discord-confirmed deletion", () => {
  const confirmed = {
    messageId: "10", channelId: "20", content: "old", status: "confirmed_deleted",
    confirmedDeletedAt: 50, deletionSource: "discord_lifecycle", capturedAt: 1, updatedAt: 50
  };
  const merged = Core.mergeRecords([confirmed], [{
    messageId: "10", channelId: "20", content: "new", status: "seen", capturedAt: 60
  }], { now: 60 });
  assert.equal(merged[0].status, "confirmed_deleted");
  assert.equal(merged[0].confirmedDeletedAt, 50);
  assert.equal(merged[0].deletionSource, "discord_lifecycle");
});

test("prunes deterministically by record and byte caps", () => {
  const records = Array.from({ length: 6 }, (_, index) => ({
    messageId: String(index), channelId: "1", content: "x", updatedAt: index
  }));
  const pruned = Core.pruneRecords(records, { maxRecords: 3, maxBytes: 10000 });
  assert.deepEqual(pruned.map((record) => record.messageId), ["5", "4", "3"]);
  assert.deepEqual(Core.pruneRecords(records, { maxRecords: 3, maxBytes: 1 }), []);
});

test("pruning discards ordinary seen records before inferred removals", () => {
  const records = [
    { messageId: "deleted", channelId: "1", status: "inferred_deleted", updatedAt: 1 },
    { messageId: "seen-new", channelId: "1", status: "seen", updatedAt: 100 },
    { messageId: "seen-old", channelId: "1", status: "seen", updatedAt: 50 }
  ];
  const pruned = Core.pruneRecords(records, { maxRecords: 2, maxBytes: 10000 });
  assert.deepEqual(pruned.map((record) => record.messageId), ["deleted", "seen-new"]);
});

test("a full deleted archive reserves room for newly rendered messages", () => {
  const deleted = Array.from({ length: 5 }, (_, index) => ({
    messageId: `deleted-${index}`, channelId: "1", status: "confirmed_deleted", updatedAt: index
  }));
  const incoming = { messageId: "fresh", channelId: "1", status: "seen", updatedAt: 100 };
  const pruned = Core.pruneRecords([...deleted, incoming], {
    maxRecords: 5, maxBytes: 10000, seenReserve: 1, seenReserveBytes: 1000
  });
  assert.equal(pruned.some((record) => record.messageId === "fresh"), true);
  assert.equal(pruned.filter((record) => Core.isDeletedStatus(record.status)).length, 4);
});

test("author presentation sanitizer keeps Discord visuals and rejects executable CSS or assets", () => {
  const record = Core.sanitizeRecordPresentation({
    messageId: "1",
    channelId: "2",
    authorColor: "rgb(91, 44, 255)",
    avatarUrl: "https://cdn.discordapp.com/avatars/1/avatar.webp?size=80",
    authorStyle: {
      color: "rgb(91, 44, 255)",
      gradient: "linear-gradient(to right, rgb(91, 44, 255), rgb(0, 180, 255))",
      backgroundPosition: "50% 0%",
      animation: {
        frames: [{ backgroundPosition: "0% 0%" }, { backgroundPosition: "100% 0%" }],
        timing: { duration: 4000, iterations: -1, easing: "linear" }
      }
    },
    authorBadges: [{
      kind: "image", url: "https://cdn.discordapp.com/role-icons/9/icon.webp", label: "Moderator", width: 20, height: 20
    }]
  });
  assert.match(record.authorStyle.gradient, /^linear-gradient/);
  assert.equal(record.authorStyle.animation.frames.length, 2);
  assert.equal(record.authorBadges[0].kind, "image");
  assert.match(record.avatarUrl, /^https:/);

  const hostile = Core.sanitizeRecordPresentation({
    messageId: "3",
    channelId: "2",
    avatarUrl: "https://example.com/avatars/1/a.png",
    authorStyle: {
      gradient: "linear-gradient(red, blue), var(--remote-image)",
      animation: {
        frames: [{ transform: "scale(999999)" }, { filter: "blur(999999px)" }],
        timing: { duration: 1, iterations: -1 }
      }
    },
    authorBadges: [{ kind: "image", url: "javascript:alert(1)" }]
  });
  assert.equal(hostile.avatarUrl, null);
  assert.equal(hostile.authorStyle, undefined);
  assert.deepEqual(hostile.authorBadges, []);
});

test("tombstone gap balancing preserves natural layout and handles prior shifts", () => {
  assert.equal(Core.balancedTombstoneShift(0, 17, 0, 0), 8.5);
  assert.equal(Core.balancedTombstoneShift(8.5, 8.5, 8.5, 8.5), 8.5);
  assert.equal(Core.balancedTombstoneShift(17, 0, 0, 0), -8.5);
  assert.equal(Core.balancedTombstoneShift(0, 0, 0, 0), 0);
  assert.equal(Core.balancedTombstoneShift(0, 100, 0, 0), 0);
});

test("row parsing and active-list selection reject another channel", () => {
  assert.deepEqual(Core.parseMessageRowIdentity("chat-messages-111111111111111-222222222222222"), {
    channelId: "111111111111111", messageId: "222222222222222"
  });
  const correct = { id: "correct", rowIds: ["chat-messages-111111111111111-222222222222222"], preferredList: true };
  const wrong = { id: "wrong", rowIds: ["chat-messages-999999999999999-333333333333333"], preferredList: true, intersectsViewport: true };
  assert.equal(Core.chooseActiveList([wrong, correct], "111111111111111").id, "correct");
});

test("active-list selection ignores Discord date-divider structural rows", () => {
  const candidate = {
    id: "messages-with-divider",
    rowIds: [
      "chat-messages-111111111111111-222222222222222",
      "chat-messages___divider-August 26, 2026"
    ],
    preferredList: true,
    intersectsViewport: true
  };
  assert.equal(Core.chooseActiveList([candidate], "111111111111111").id, "messages-with-divider");
});

test("snowflake placement finds nearest live or already-restored neighbors", () => {
  const target = "300000000000000";
  const placement = Core.chronologicalNeighborIds(target, [
    "chat-messages-111111111111111-100000000000000",
    "111111111111111:200000000000000",
    "chat-messages___divider-August 26, 2026",
    "chat-messages-111111111111111-400000000000000",
    "chat-messages-111111111111111-500000000000000"
  ]);
  assert.deepEqual(placement, {
    previousId: "200000000000000",
    nextId: "400000000000000"
  });
  assert.equal(Core.compareSnowflakeIds("999999999999999", "1000000000000000"), -1);
  assert.equal(Core.compareSnowflakeIds("400000000000000", target), 1);
});

test("anchorless restore stays inside the rendered range except for a safe at-bottom tail", () => {
  const rows = [
    "chat-messages-111111111111111-200000000000000",
    "chat-messages-111111111111111-400000000000000"
  ];
  assert.equal(Core.anchorlessRestoreAllowed("300000000000000", rows), true);
  assert.equal(Core.anchorlessRestoreAllowed("100000000000000", rows), false);
  assert.equal(Core.anchorlessRestoreAllowed("500000000000000", rows, { tail: true, atBottom: false }), false);
  assert.equal(Core.anchorlessRestoreAllowed("500000000000000", rows, { tail: true, atBottom: true }), true);
  assert.equal(Core.anchorlessRestoreAllowed("300000000000000", [], { allowEmpty: false }), false);
  assert.equal(Core.anchorlessRestoreAllowed("300000000000000", [], { allowEmpty: true }), true);
});

test("one visible preferred Discord message list wins before fallback scoring", () => {
  const rowId = "chat-messages-111111111111111-222222222222222";
  const preferred = { id: "preferred", rowIds: [rowId], preferredList: true, intersectsViewport: true };
  const fallback = { id: "fallback", rowIds: Array(50).fill(rowId), preferredList: false, intersectsViewport: true, directParent: true };
  assert.equal(Core.chooseActiveList([fallback, preferred], "111111111111111").id, "preferred");
  const secondPreferred = { id: "preferred-2", rowIds: [rowId], preferredList: true, intersectsViewport: true };
  assert.equal(Core.chooseActiveList([fallback, preferred, secondPreferred], "111111111111111").id, "fallback");
});

test("tombstone cleanup removes cleared/deleted records and live reappearances", () => {
  const deleted = [{ messageId: "2", channelId: "1", status: "inferred_deleted" }];
  assert.deepEqual(Core.tombstoneCleanupKeys([], ["1:2"], []), ["1:2"]);
  assert.deepEqual(Core.tombstoneCleanupKeys(deleted, ["1:2"], ["1:2"]), ["1:2"]);
  assert.deepEqual(Core.tombstoneCleanupKeys(deleted, ["1:2"], []), []);
});

test("confirmed deletions receive the same durable tombstone priority", () => {
  const records = [
    { messageId: "confirmed", channelId: "1", status: "confirmed_deleted", updatedAt: 1 },
    { messageId: "seen", channelId: "1", status: "seen", updatedAt: 100 }
  ];
  assert.deepEqual(Core.pruneRecords(records, { maxRecords: 1, maxBytes: 10000 }).map((record) => record.messageId), ["confirmed"]);
  assert.deepEqual(Core.tombstoneCleanupKeys(records, ["1:confirmed"], []), []);
});

test("searches author, content, channel, and attachments with a status filter", () => {
  const records = [
    { messageId: "1", channelId: "2", author: "Leah", content: "Gemini app", attachments: ["voice.mp4"], status: "seen", updatedAt: 1 },
    { messageId: "2", channelId: "2", author: "River", content: "Release notes", channelName: "updates", status: "inferred_deleted", updatedAt: 2 }
  ];
  assert.equal(Core.searchRecords(records, "voice", "all")[0].messageId, "1");
  assert.equal(Core.searchRecords(records, "updates", "inferred_deleted")[0].messageId, "2");
  assert.equal(Core.searchRecords(records, "Leah", "inferred_deleted").length, 0);
});
