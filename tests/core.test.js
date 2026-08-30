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

test("trailing frame scheduler collapses scroll storms and preserves persistent capture", () => {
  const frames = new Map();
  const timers = new Map();
  const runs = [];
  let token = 0;
  const scheduler = Core.createTrailingFrameScheduler((persist) => runs.push(persist), {
    requestFrame(callback) { const id = ++token; frames.set(id, callback); return id; },
    cancelFrame(id) { frames.delete(id); },
    setTimer(callback, delay) { const id = ++token; timers.set(id, { callback, delay }); return id; },
    clearTimer(id) { timers.delete(id); }
  });

  for (let index = 0; index < 1000; index += 1) scheduler(index === 400, 1550);
  assert.deepEqual(scheduler.pending(), { frame: false, timer: true, persist: true });
  assert.equal(timers.size, 1);
  assert.equal(frames.size, 0);
  const trailing = [...timers.values()][0];
  timers.clear();
  trailing.callback();
  assert.equal(frames.size, 1);
  [...frames.values()][0]();
  frames.clear();
  assert.deepEqual(runs, [true]);
  assert.deepEqual(scheduler.pending(), { frame: false, timer: false, persist: false });
});

test("trailing frame scheduler runs at most once for a mutation burst", () => {
  const frames = new Map();
  const runs = [];
  let token = 0;
  const scheduler = Core.createTrailingFrameScheduler((persist) => runs.push(persist), {
    requestFrame(callback) { const id = ++token; frames.set(id, callback); return id; },
    cancelFrame(id) { frames.delete(id); },
    setTimer() { throw new Error("unexpected timer"); },
    clearTimer() {}
  });
  for (let index = 0; index < 500; index += 1) scheduler(index % 2 === 0, 0);
  assert.equal(frames.size, 1);
  [...frames.values()][0]();
  assert.deepEqual(runs, [true]);
});

test("rate-limited scheduler cannot be starved by a continuous event stream", () => {
  const timers = new Map();
  const runs = [];
  let now = 0;
  let token = 0;
  const scheduler = Core.createRateLimitedScheduler((persist) => runs.push({ at: now, persist }), 250, {
    now: () => now,
    setTimer(callback, delay) { const id = ++token; timers.set(id, { callback, delay }); return id; },
    clearTimer(id) { timers.delete(id); }
  });

  scheduler(false);
  assert.deepEqual(runs, [{ at: 0, persist: false }]);
  now = 10;
  for (let index = 0; index < 1000; index += 1) scheduler(index === 500);
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].delay, 240);
  now = 250;
  const bounded = [...timers.values()][0];
  timers.clear();
  bounded.callback();
  assert.deepEqual(runs, [
    { at: 0, persist: false },
    { at: 250, persist: true }
  ]);
  assert.deepEqual(scheduler.pending(), { timer: false, persist: false, lastRunAt: 250 });
});

test("live action ownership accepts Discord's nested article inside its outer message row", () => {
  const messageId = "888888888888888881";
  const channelId = "777777777777777777";
  const host = { isConnected: true };
  const innerArticle = { isConnected: true, dataset: { listItemId: `chat-messages___${channelId}-${messageId}` } };
  const outerRow = {
    id: `chat-messages-${channelId}-${messageId}`,
    isConnected: true,
    contains(element) { return element === innerArticle || element === host; }
  };
  host.closest = () => innerArticle;

  assert.notEqual(host.closest(), outerRow);
  assert.equal(Core.messageRowOwnsElement(outerRow, host, messageId), true);
  assert.equal(Core.messageRowOwnsElement(outerRow, { isConnected: true }, messageId), false);
  assert.equal(Core.messageRowOwnsElement({ ...outerRow, isConnected: false }, host, messageId), false);
  assert.equal(Core.messageRowOwnsElement(outerRow, host, "888888888888888889"), false);
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
  assert.equal(merged[0].content, "old");
});

test("merge keeps Discord author IDs and canonical usernames atomically bound", () => {
  const base = {
    channelId: "111111111111111",
    messageId: "222222222222222",
    authorId: "333333333333333",
    authorUsername: "original_name",
    status: "seen"
  };
  const sameAuthor = Core.mergeRecords([base], [{
    channelId: base.channelId,
    messageId: base.messageId,
    authorId: base.authorId,
    status: "seen"
  }], { now: 2 })[0];
  assert.equal(sameAuthor.authorUsername, "original_name");

  const changedWithoutUsername = Core.mergeRecords([base], [{
    channelId: base.channelId,
    messageId: base.messageId,
    authorId: "444444444444444",
    status: "seen"
  }], { now: 3 })[0];
  assert.equal(changedWithoutUsername.authorId, "444444444444444");
  assert.equal(changedWithoutUsername.authorUsername, undefined);

  const changedWithUsername = Core.mergeRecords([base], [{
    channelId: base.channelId,
    messageId: base.messageId,
    authorId: "444444444444444",
    authorUsername: "replacement_name",
    status: "seen"
  }], { now: 4 })[0];
  assert.equal(changedWithUsername.authorId, "444444444444444");
  assert.equal(changedWithUsername.authorUsername, "replacement_name");
});

test("resolved and fallback Discord author identity is selected as one bound pair", () => {
  const authorA = "333333333333333";
  const authorB = "444444444444444";
  assert.deepEqual(Core.boundAuthorIdentity(authorB, null, authorA, "old_name"), {
    userId: authorB,
    username: null
  });
  assert.deepEqual(Core.boundAuthorIdentity(authorB, "new_name", authorA, "old_name"), {
    userId: authorB,
    username: "new_name"
  });
  assert.deepEqual(Core.boundAuthorIdentity(authorA, null, authorA, "legacy_name"), {
    userId: authorA,
    username: "legacy_name"
  });
  assert.deepEqual(Core.boundAuthorIdentity(null, null, authorA, "fallback_name"), {
    userId: authorA,
    username: "fallback_name"
  });
  assert.deepEqual(Core.boundAuthorIdentity(authorB, null, null, "unbound_name"), {
    userId: authorB,
    username: null
  });
});

test("edit payload signatures ignore presentation churn but detect text and media changes", () => {
  const base = {
    content: "hello   world",
    attachments: ["clip.gif"],
    media: [{
      url: "https://cdn.discordapp.com/attachments/111111111111111/222222222222222/clip.gif?ex=one&is=two",
      kind: "image", source: "attachment", name: "clip.gif", width: 80, height: 80
    }]
  };
  assert.equal(Core.editPayloadSignature(base), Core.editPayloadSignature(Object.assign({}, base, {
    content: "hello   world",
    authorColor: "red",
    channelName: "renamed",
    media: [{
      url: "https://cdn.discordapp.com/attachments/111111111111111/222222222222222/clip.gif?ex=rotated&is=new",
      kind: "image", source: "attachment", name: "clip.gif", width: 80, height: 80
    }]
  })));
  assert.equal(Core.editPayloadSignature(base), Core.editPayloadSignature(Object.assign({}, base, {
    media: [Object.assign({}, base.media[0], {
      width: 320,
      height: 180,
      mimeType: "image/gif",
      alt: "hydrated alt",
      posterUrl: "https://media.discordapp.net/attachments/111111111111111/222222222222222/poster.png"
    })]
  })));
  assert.notEqual(Core.editPayloadSignature(base), Core.editPayloadSignature(Object.assign({}, base, { content: "hello world" })));
  assert.notEqual(Core.editPayloadSignature(base), Core.editPayloadSignature(Object.assign({}, base, { content: "changed" })));
  assert.notEqual(Core.editPayloadSignature(base), Core.editPayloadSignature(Object.assign({}, base, { media: [] })));
});

test("edit history is sanitized, bounded, keeps the original, and remains searchable", () => {
  const revisions = Array.from({ length: 25 }, (_, index) => ({
    revisionId: `session:${index + 1}`,
    content: `revision ${index}`,
    attachments: [`file-${index}.txt`],
    media: [{ url: `https://cdn.discordapp.com/attachments/111111111111111/${String(300000000000000 + index)}/file.png`, kind: "image" }],
    capturedAt: index + 1,
    supersededAt: index + 2
  }));
  const sanitized = Core.sanitizeEditHistory(revisions, { maxEditRevisions: 5, maxEditBytes: 100000 });
  assert.equal(sanitized.length, 5);
  assert.equal(sanitized[0].content, "revision 0");
  assert.deepEqual(sanitized.slice(1).map((revision) => revision.content), ["revision 21", "revision 22", "revision 23", "revision 24"]);
  const record = { messageId: "1", channelId: "2", status: "seen", content: "current", editHistory: sanitized, updatedAt: 30 };
  assert.equal(Core.hasEdits(record), true);
  assert.equal(Core.searchRecords([record], "revision 22", "all").length, 1);
  const hostile = Core.sanitizeRecordPresentation(Object.assign({}, record, {
    editHistory: [{ revisionId: "x", content: "old", media: [{ url: "javascript:alert(1)" }] }]
  }));
  assert.deepEqual(hostile.editHistory[0].media, []);
});

test("edit history preserves formatting-only revisions and handles a one-revision bound", () => {
  const formatted = Core.sanitizeEditHistory([
    { revisionId: "a", content: "hello\nworld", supersededAt: 1 },
    { revisionId: "b", content: "hello world", supersededAt: 2 },
    { revisionId: "c", content: "hello  world", supersededAt: 3 }
  ]);
  assert.deepEqual(formatted.map((revision) => revision.content), ["hello\nworld", "hello world", "hello  world"]);
  const bounded = Core.sanitizeEditHistory(formatted, { maxEditRevisions: 1 });
  assert.deepEqual(bounded.map((revision) => revision.revisionId), ["a"]);
});

test("same-session stale captures cannot roll the current payload backward", () => {
  const current = {
    messageId: "10", channelId: "20", content: "new", status: "seen",
    captureSessionId: "page-a", captureSequence: 3, capturedAt: 30
  };
  const stale = Object.assign({}, current, { content: "old", captureSequence: 2, capturedAt: 20 });
  const merged = Core.mergeRecords([current], [stale], { now: 40 });
  assert.equal(merged[0].content, "new");
  assert.equal(merged[0].captureSequence, 3);
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

test("a saturated archive reserves the newest tail of an equal-timestamp capture batch", () => {
  const deleted = Array.from({ length: Core.DEFAULTS.maxRecords }, (_, index) => ({
    messageId: String(100000000000000000n + BigInt(index)), channelId: "1",
    status: "confirmed_deleted", content: "saved", updatedAt: index + 1
  }));
  const captured = Array.from({ length: Core.DEFAULTS.seenReserve + 10 }, (_, index) => ({
    messageId: String(200000000000000000n + BigInt(index)), channelId: "1",
    status: "seen", content: "new", capturedAt: 2000,
    captureSessionId: "one-page", captureSequence: index + 1
  }));
  const expected = captured.slice(-Core.DEFAULTS.seenReserve).map((record) => record.messageId).reverse();
  for (const batch of [captured, [...captured].reverse()]) {
    const merged = Core.mergeRecords(deleted, batch, { now: 3000 });
    assert.equal(merged.length, Core.DEFAULTS.maxRecords);
    assert.deepEqual(merged.filter((record) => record.status === "seen").map((record) => record.messageId), expected);
  }
});

test("equal-write-time pruning uses capture time before snowflake chronology", () => {
  const records = [
    { channelId: "1", messageId: "200000000000000002", status: "seen", capturedAt: 10 },
    { channelId: "1", messageId: "200000000000000001", status: "seen", capturedAt: 20 }
  ];
  for (const batch of [records, [...records].reverse()]) {
    const merged = Core.mergeRecords([], batch, { now: 30, maxRecords: 1 });
    assert.equal(merged[0].messageId, "200000000000000001");
  }
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

  const grouped = Core.sanitizeRecordPresentation({
    messageId: "222222222222222", channelId: "111111111111111",
    authorId: "999999999999999", authorUsername: "curiousbro",
    groupRootMessageId: "111111111111112", sourceContinuation: 1
  });
  assert.equal(grouped.authorId, "999999999999999");
  assert.equal(grouped.authorUsername, "curiousbro");
  assert.equal(Core.searchRecords([grouped], "curiousbro", "all").length, 1);
  assert.equal(grouped.groupRootMessageId, "111111111111112");
  assert.equal(grouped.sourceContinuation, true);

  const hostile = Core.sanitizeRecordPresentation({
    messageId: "3",
    channelId: "2",
    authorId: "not-a-user",
    authorUsername: "@not a username",
    groupRootMessageId: "future<script>",
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
  assert.equal(hostile.authorId, undefined);
  assert.equal(hostile.authorUsername, undefined);
  assert.equal(hostile.groupRootMessageId, undefined);
});

test("tombstone gap balancing preserves natural layout and handles prior shifts", () => {
  assert.equal(Core.balancedTombstoneShift(0, 17, 0, 0), 8.5);
  assert.equal(Core.balancedTombstoneShift(8.5, 8.5, 8.5, 8.5), 8.5);
  assert.equal(Core.balancedTombstoneShift(17, 0, 0, 0), -8.5);
  assert.equal(Core.balancedTombstoneShift(0, 0, 0, 0), 0);
  assert.equal(Core.balancedTombstoneShift(0, 100, 0, 0), 0);
});

test("Discord continuation grouping prefers captured native roots and handles visible-run promotion", () => {
  const root = {
    channelId: "111111111111111", messageId: "300000000000000", groupRootMessageId: "300000000000000",
    author: "Rizzist", messageTimestamp: "2026-08-26T06:56:00.000Z"
  };
  const second = Object.assign({}, root, {
    messageId: "310000000000000", groupRootMessageId: root.messageId,
    messageTimestamp: "2026-08-26T06:57:00.000Z"
  });
  const third = Object.assign({}, second, { messageId: "320000000000000" });
  assert.equal(Core.messageContinues(root, second), true);
  assert.equal(Core.messageContinues(second, third), true);
  assert.equal(Core.messageContinues(null, second), false);
  assert.equal(Core.messageContinues({ messageId: "305000000000000", groupRootMessageId: "305000000000000" }, second), false);
  assert.equal(Core.messageContinues(root, Object.assign({}, second, { replyPreview: "reply" })), false);
});

test("legacy continuation fallback requires the same author, day, and seven-minute window", () => {
  const base = {
    channelId: "111111111111111", messageId: "300000000000000", author: "Rizzist",
    avatarUrl: "https://cdn.discordapp.com/avatars/999999999999999/avatar.webp?size=80",
    messageTimestamp: "2026-08-26T06:56:00.000Z"
  };
  const next = Object.assign({}, base, {
    messageId: "310000000000000", messageTimestamp: "2026-08-26T07:02:59.000Z"
  });
  assert.equal(Core.messageContinues(base, next), true);
  assert.equal(Core.messageContinues(base, Object.assign({}, next, { messageTimestamp: "2026-08-26T07:03:01.000Z" })), false);
  assert.equal(Core.messageContinues(base, Object.assign({}, next, { author: "Someone else", avatarUrl: null })), false);
  assert.equal(Core.messageContinues(base, Object.assign({}, next, { messageTimestamp: "2026-08-27T00:00:01.000Z" })), false);
  assert.equal(Core.messageContinues(base, Object.assign({}, next, { groupRootMessageId: next.messageId })), false);
  assert.equal(Core.avatarAuthorId("https://cdn.discordapp.com/guilds/888888888888888/users/999999999999999/avatars/hash.webp"), "999999999999999");
});

test("legacy continuation fallback fails closed without matching stable author identity", () => {
  const base = {
    channelId: "111111111111111", messageId: "300000000000000", author: "Same display name",
    messageTimestamp: "2026-08-26T06:56:00.000Z"
  };
  const next = Object.assign({}, base, {
    messageId: "310000000000000", messageTimestamp: "2026-08-26T06:57:00.000Z"
  });
  assert.equal(Core.messageContinues(base, next), false);
  assert.equal(Core.messageContinues(
    Object.assign({}, base, { avatarUrl: "https://cdn.discordapp.com/avatars/999999999999999/avatar.webp" }),
    next
  ), false);
  assert.equal(Core.messageContinues(
    Object.assign({}, base, { avatarUrl: "https://cdn.discordapp.com/embed/avatars/0.png" }),
    Object.assign({}, next, { avatarUrl: "https://cdn.discordapp.com/embed/avatars/0.png" })
  ), false);
  assert.equal(Core.messageContinues(
    Object.assign({}, base, { authorId: "999999999999999" }),
    Object.assign({}, next, { authorId: "999999999999999" })
  ), true);
});

test("strict fallback can reconcile a stale non-self root after native promotion", () => {
  const promotedNative = {
    messageId: "310000000000000", groupRootMessageId: "310000000000000",
    authorId: "999999999999999", messageTimestamp: "2026-08-26T06:57:00.000Z"
  };
  const capturedBeforePromotion = {
    messageId: "320000000000000", groupRootMessageId: "300000000000000",
    authorId: "999999999999999", messageTimestamp: "2026-08-26T06:58:00.000Z"
  };
  assert.equal(Core.messageContinues(promotedNative, capturedBeforePromotion), false);
  assert.equal(Core.messageContinues(promotedNative, capturedBeforePromotion, { ignoreGroupRoot: true }), true);
  assert.equal(Core.messageContinues(promotedNative, Object.assign({}, capturedBeforePromotion, {
    groupRootMessageId: capturedBeforePromotion.messageId
  })), false);
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

test("virtualized tombstones are retained only inside the current rendered snowflake window", () => {
  const range = (oldest, newest) => [
    `chat-messages-111111111111111-${oldest}`,
    `chat-messages-111111111111111-${newest}`
  ];
  assert.equal(Core.tombstoneInRenderedRange("550000000000000", range("500000000000000", "600000000000000")), true);
  assert.equal(Core.tombstoneInRenderedRange("550000000000000", range("300000000000000", "400000000000000")), false);
  assert.equal(Core.tombstoneInRenderedRange("350000000000000", range("300000000000000", "400000000000000")), true);
  assert.equal(Core.tombstoneInRenderedRange("350000000000000", range("100000000000000", "200000000000000")), false);
  assert.equal(Core.tombstoneInRenderedRange("700000000000000", range("500000000000000", "600000000000000"), {
    tail: true, atBottom: true
  }), true);
  const deleted = ["200000000000000", "400000000000000"];
  const mounted = (rows, options) => deleted.filter((id) => Core.tombstoneInRenderedRange(id, rows, options));
  assert.deepEqual(mounted(range("300000000000000", "500000000000000")), ["400000000000000"]);
  assert.deepEqual(mounted([], { allowEmpty: false }), []);
  assert.deepEqual(mounted(range("100000000000000", "300000000000000")), ["200000000000000"]);
  assert.deepEqual(mounted([], { allowEmpty: true }), deleted);
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

test("reply snapshots are strictly bounded, sanitized, and migrate legacy previews", () => {
  const media = Array.from({ length: 8 }, (_value, index) => ({
    url: `https://cdn.discordapp.com/attachments/111111111111111111/22222222222222222${index}/reply-${index}.png`,
    kind: "image", source: "attachment", name: `reply-${index}.png`
  }));
  media.unshift({ url: "javascript:alert(1)", kind: "image" });
  const sanitized = Core.sanitizeRecordPresentation({
    messageId: "333333333333333333", channelId: "111111111111111111", status: "seen",
    replyPreview: "legacy fallback",
    reply: {
      messageId: "222222222222222222", channelId: "111111111111111111",
      guildId: "444444444444444444", authorId: "555555555555555555",
      author: "A".repeat(200), authorUsername: "curiousbro", avatarUrl: "javascript:alert(1)",
      authorColor: "url(https://evil.invalid)", content: "x".repeat(3000),
      attachmentNames: Array.from({ length: 10 }, (_value, index) => `../file-${index}.png`),
      media, state: "resolved", ignored: "not persisted"
    }
  });
  assert.equal(sanitized.reply.state, "available");
  assert.equal(sanitized.reply.author.length, 128);
  assert.equal(sanitized.reply.content.length, 2000);
  assert.equal(sanitized.reply.attachmentNames.length, 4);
  assert.equal(sanitized.reply.media.length, 4);
  assert.equal(sanitized.reply.avatarUrl, undefined);
  assert.equal(sanitized.reply.authorColor, undefined);
  assert.equal(sanitized.reply.ignored, undefined);
  assert.equal(sanitized.replyPreview, undefined);

  const legacy = Core.sanitizeRecordPresentation({
    messageId: "333333333333333333", channelId: "111111111111111111", replyPreview: " old reply preview "
  });
  assert.deepEqual(legacy.reply, { fallbackText: "old reply preview", state: "legacy" });
  assert.equal(legacy.replyPreview, undefined);
  assert.equal(Core.sanitizeReply({
    messageId: 222222222222222222, author: {}, fallbackText: {}, attachmentNames: [{}], state: "edited"
  }), null);
});

test("reply merge preserves rich and deleted snapshots and rejects conflicting identities", () => {
  const base = {
    messageId: "333333333333333333", channelId: "111111111111111111", status: "seen", capturedAt: 1,
    reply: {
      messageId: "222222222222222222", channelId: "111111111111111111",
      authorId: "555555555555555555", author: "Target", content: "original target",
      media: [{
        url: "https://cdn.discordapp.com/attachments/111111111111111111/666666666666666666/reply.png",
        kind: "image", source: "attachment"
      }], state: "available"
    }
  };
  let merged = Core.mergeRecords([], [base], { now: 2, maxRecords: 10, maxBytes: 100000, seenReserve: 1 })[0];
  merged = Core.mergeRecords([merged], [{
    ...base, capturedAt: 3,
    reply: { messageId: "222222222222222222", channelId: "111111111111111111", state: "unavailable" }
  }], { now: 3, maxRecords: 10, maxBytes: 100000, seenReserve: 1 })[0];
  assert.equal(merged.reply.state, "available");
  assert.equal(merged.reply.content, "original target");
  assert.equal(merged.reply.media.length, 1);

  merged = Core.mergeRecords([merged], [{
    ...base, capturedAt: 4,
    reply: { messageId: "222222222222222222", channelId: "111111111111111111", state: "deleted" }
  }], { now: 4, maxRecords: 10, maxBytes: 100000, seenReserve: 1 })[0];
  assert.equal(merged.reply.state, "deleted");
  merged = Core.mergeRecords([merged], [{
    ...base, capturedAt: 5,
    reply: { messageId: "222222222222222222", channelId: "111111111111111111", content: "stale", state: "available" }
  }], { now: 5, maxRecords: 10, maxBytes: 100000, seenReserve: 1 })[0];
  assert.equal(merged.reply.state, "deleted");
  assert.equal(merged.reply.content, "original target");

  merged = Core.mergeRecords([merged], [{
    ...base, capturedAt: 6,
    reply: { messageId: "777777777777777777", channelId: "111111111111111111", content: "wrong target", state: "deleted" }
  }], { now: 6, maxRecords: 10, maxBytes: 100000, seenReserve: 1 })[0];
  assert.equal(merged.reply.messageId, "222222222222222222");
  assert.equal(merged.reply.content, "original target");
});

test("reply data is searchable and affects grouping but never edit history semantics", () => {
  const record = {
    messageId: "333333333333333333", channelId: "111111111111111111", authorId: "555555555555555555",
    content: "body", status: "seen", capturedAt: 1,
    reply: {
      messageId: "222222222222222222", author: "Quoted Person", authorUsername: "quoted.user",
      content: "secret quoted words", attachmentNames: ["quoted-file.png"], state: "available"
    }
  };
  assert.equal(Core.searchRecords([record], "quoted person", "all").length, 1);
  assert.equal(Core.searchRecords([record], "quoted-file", "all").length, 1);
  assert.equal(Core.messageContinues({ ...record, reply: null }, record), false);
  const withoutReply = { ...record };
  delete withoutReply.reply;
  assert.equal(Core.editPayloadSignature(record), Core.editPayloadSignature(withoutReply));
  assert.equal(Core.editRevisionFromRecord(record, { revisionId: "s:1" }).reply, undefined);
});

test("confirmed deleted records reject stale reply upserts", () => {
  const deleted = Core.sanitizeRecordPresentation({
    messageId: "333333333333333333", channelId: "111111111111111111", status: "confirmed_deleted",
    content: "deleted body", capturedAt: 10,
    reply: { messageId: "222222222222222222", content: "deleted reply snapshot", state: "deleted" }
  });
  const merged = Core.mergeRecords([deleted], [{
    messageId: deleted.messageId, channelId: deleted.channelId, status: "seen", content: "stale body", capturedAt: 20,
    reply: { messageId: "777777777777777777", content: "stale unrelated reply", state: "available" }
  }], { now: 20, maxRecords: 10, maxBytes: 100000, seenReserve: 1 })[0];
  assert.equal(merged.content, "deleted body");
  assert.equal(merged.reply.messageId, "222222222222222222");
  assert.equal(merged.reply.content, "deleted reply snapshot");
});

test("lower-confidence inference cannot replace an already confirmed payload or reply", () => {
  const confirmed = Core.sanitizeRecordPresentation({
    messageId: "333333333333333333", channelId: "111111111111111111", status: "confirmed_deleted",
    content: "confirmed body", attachments: ["confirmed.png"], capturedAt: 10,
    confirmedDeletedAt: 11, deletionSource: "discord_lifecycle",
    reply: { messageId: "222222222222222222", content: "confirmed quoted target", state: "available" }
  });
  const merged = Core.mergeRecords([confirmed], [{
    messageId: confirmed.messageId, channelId: confirmed.channelId, status: "inferred_deleted",
    content: "stale inferred body", attachments: ["stale.png"], capturedAt: 20,
    reply: { messageId: "222222222222222222", content: "stale inferred target", state: "available" }
  }], { now: 20, maxRecords: 10, maxBytes: 100000, seenReserve: 1 })[0];
  assert.equal(merged.status, "confirmed_deleted");
  assert.equal(merged.content, "confirmed body");
  assert.deepEqual(merged.attachments, ["confirmed.png"]);
  assert.equal(merged.reply.content, "confirmed quoted target");
  assert.equal(merged.confirmedDeletedAt, 11);
  assert.equal(merged.deletionSource, "discord_lifecycle");
});

test("reply snapshots count toward the existing archive byte bound", () => {
  const plain = {
    messageId: "333333333333333333", channelId: "111111111111111111",
    status: "seen", content: "body", capturedAt: 1
  };
  const withReply = Core.sanitizeRecordPresentation({
    ...plain,
    reply: { messageId: "222222222222222222", content: "quoted ".repeat(200), state: "available" }
  });
  const ceiling = Core.estimateBytes(Core.sanitizeRecordPresentation(plain)) + 4;
  assert.ok(Core.estimateBytes(withReply) > ceiling);
  assert.deepEqual(Core.pruneRecords([withReply], {
    maxRecords: 1, maxBytes: ceiling, seenReserve: 0, seenReserveBytes: 0
  }), []);
});
