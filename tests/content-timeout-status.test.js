"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Core = require("../src/core.js");

const source = fs.readFileSync(path.join(__dirname, "../src/content.js"), "utf8");

const GUILD_ID = "333333333333333333";
const CHANNEL_ID = "444444444444444444";
const USER_ID = "555555555555555555";
const MESSAGE_ID = "666666666666666666";

function sourceBetween(startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, `production source boundaries: ${startText} / ${endText}`);
  return source.slice(start, end);
}

const timeoutHelpers = sourceBetween(
  "  function refreshTombstoneTimeoutBadges(",
  "  function createAuthorActionControls("
);
const dropTombstoneHelper = sourceBetween(
  "  function dropTombstoneRenderer(",
  "  function removeTombstone("
);

function fakeDateClock(initialNow) {
  let now = initialNow;
  class ClockDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() { return now; }
  }
  return {
    Date: ClockDate,
    now: () => now,
    setNow: (value) => { now = value; }
  };
}

function makeRecord(index = 0, userId = USER_ID) {
  const messageId = String(BigInt(MESSAGE_ID) + BigInt(index));
  return {
    messageId,
    channelId: CHANNEL_ID,
    guildId: GUILD_ID,
    authorId: userId,
    author: `Author ${index}`,
    status: "confirmed_deleted"
  };
}

function timeoutHarness(options = {}) {
  const clock = fakeDateClock(options.now || Date.parse("2026-08-31T12:00:00.000Z"));
  const timers = new Map();
  let nextTimer = 1;
  const sends = [];
  const state = {
    route: {
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      routeKey: `${GUILD_ID}:${CHANNEL_ID}`
    },
    tombstoneRenderers: new Map(),
    archiveByKey: new Map(),
    memberTimeoutsByMessage: new Map(),
    pendingTimeoutMessageIds: new Set(),
    memberTimeoutTimer: null,
    memberTimeoutPromise: null,
    memberTimeoutExpiryTimer: null
  };
  const context = vm.createContext({
    Core,
    Date: clock.Date,
    SNOWFLAKE: /^\d{15,25}$/,
    RESOLVE_MEMBER_TIMEOUTS: "LDMA_RESOLVE_MEMBER_TIMEOUTS",
    state,
    send(command) {
      sends.push(command);
      return options.send ? options.send(command) : Promise.resolve({ ok: true, timeouts: [] });
    },
    setTimeout(callback, delay) {
      const token = nextTimer++;
      timers.set(token, { callback, delay });
      return token;
    },
    clearTimeout(token) { timers.delete(token); },
    Infinity,
    Map,
    Set,
    Number,
    String,
    Math,
    Promise
  });
  vm.runInContext(`${dropTombstoneHelper}\n${timeoutHelpers}
    globalThis.dropTombstoneRenderer = dropTombstoneRenderer;
    globalThis.refreshTombstoneTimeoutBadges = refreshTombstoneTimeoutBadges;
    globalThis.scheduleMemberTimeoutExpiry = scheduleMemberTimeoutExpiry;
    globalThis.scheduleMemberTimeoutFlush = scheduleMemberTimeoutFlush;
    globalThis.queueTombstoneTimeoutResolution = queueTombstoneTimeoutResolution;
    globalThis.scheduleMountedTimeoutRefresh = scheduleMountedTimeoutRefresh;
    globalThis.flushMemberTimeouts = flushMemberTimeouts;
    globalThis.rememberSuccessfulTimeout = rememberSuccessfulTimeout;`, context);
  return { context, state, sends, timers, clock };
}

function mountRecord(harness, record, refresh) {
  const key = Core.recordKey(record);
  harness.state.archiveByKey.set(key, record);
  harness.state.tombstoneRenderers.set(key, {
    refreshTimeoutStatus: refresh || (() => {})
  });
  return key;
}

function fireOnlyTimer(harness) {
  assert.equal(harness.timers.size, 1, "one coalesced timer should be pending");
  const [token, timer] = harness.timers.entries().next().value;
  harness.timers.delete(token);
  timer.callback();
  return timer;
}

test("restored timeout status is tombstone-only, accessible, and not a third author action", () => {
  const tombstone = sourceBetween("  function createTombstoneRenderer(", "  function dropEditRenderer(");
  const live = sourceBetween("  function createLiveAuthorActionRenderer(", "  function activateLiveAuthorActions(");
  const controls = sourceBetween("  function createAuthorActionControls(", "  function nativeHeaderActionInsertion(");

  assert.match(tombstone, /timeoutBadge\.className = "timeout-badge"/);
  assert.match(tombstone, /timeoutBadge\.setAttribute\("role", "img"\)/);
  assert.match(tombstone, /timeoutSvg\.setAttribute\("aria-hidden", "true"\)/);
  assert.match(tombstone, /authorGroup\.append\(author, timeoutBadge, badges\)/);
  assert.match(tombstone, /`Timed out until \$\{new Date\(timestamp\)\.toLocaleString\(\)\}`/);
  assert.match(tombstone, /timeoutBadge\.setAttribute\("aria-label", label\)/);
  assert.match(tombstone, /timeoutBadge\.title = label/);
  assert.match(tombstone, /timeoutBadge\.removeAttribute\("aria-label"\)/);
  assert.match(tombstone, /timeoutBadge\.removeAttribute\("title"\)/);
  assert.match(tombstone, /\.message\.continuation \.header \.author-group[^}]*display:none/);

  assert.doesNotMatch(live, /timeout-badge|ldmaMemberTimeout|RESOLVE_MEMBER_TIMEOUTS/,
    "Discord's native live author header remains presentation-authoritative");
  assert.match(controls, /actions\.append\(copyAction, timeoutAction, status\)/);
  assert.equal((controls.match(/document\.createElement\("button"\)/g) || []).length, 2,
    "the timeout badge is status presentation, never a third toolbar button");
  assert.equal((source.match(/type: RESOLVE_MEMBER_TIMEOUTS/g) || []).length, 1,
    "member timeout state has one production broker call site");
});

test("timeout queries batch, coalesce, and drain at most 200 mounted tombstones at a time", async () => {
  const recordsByMessage = new Map();
  const harness = timeoutHarness({
    send: async (command) => ({
      ok: true,
      timeouts: command.messageIds.map((messageId) => ({
        messageId,
        userId: recordsByMessage.get(messageId).authorId,
        timeoutUntil: null
      }))
    })
  });
  for (let index = 0; index < 205; index += 1) {
    const userId = String(BigInt(USER_ID) + BigInt(index));
    const record = makeRecord(index, userId);
    recordsByMessage.set(record.messageId, record);
    mountRecord(harness, record);
    harness.context.queueTombstoneTimeoutResolution(record, true);
  }
  harness.state.pendingTimeoutMessageIds.add("999999999999999999");

  assert.equal(harness.state.pendingTimeoutMessageIds.size, 206);
  fireOnlyTimer(harness);
  await harness.state.memberTimeoutPromise;
  assert.equal(harness.sends.length, 1);
  assert.equal(harness.sends[0].type, "LDMA_RESOLVE_MEMBER_TIMEOUTS");
  assert.equal(harness.sends[0].messageIds.length, 200);
  assert.equal(new Set(harness.sends[0].messageIds).size, 200);
  assert.equal(harness.state.pendingTimeoutMessageIds.size, 5);

  fireOnlyTimer(harness);
  await harness.state.memberTimeoutPromise;
  assert.equal(harness.sends.length, 2);
  assert.equal(harness.sends[1].messageIds.length, 5);
  assert.equal(harness.state.pendingTimeoutMessageIds.size, 0);
});

test("unmounting a tombstone drops its transient timeout cache and queued lookup", () => {
  const harness = timeoutHarness();
  let disposals = 0;
  const record = makeRecord();
  const key = mountRecord(harness, record);
  harness.state.tombstoneRenderers.set(key, { dispose() { disposals += 1; } });
  harness.state.memberTimeoutsByMessage.set(key, {
    userId: record.authorId,
    known: true,
    timeoutUntil: "2026-09-01T12:00:00.000Z",
    checkedAt: harness.clock.now()
  });
  harness.state.pendingTimeoutMessageIds.add(record.messageId);

  harness.context.dropTombstoneRenderer(key);

  assert.equal(disposals, 1);
  assert.equal(harness.state.tombstoneRenderers.has(key), false);
  assert.equal(harness.state.memberTimeoutsByMessage.has(key), false);
  assert.equal(harness.state.pendingTimeoutMessageIds.has(record.messageId), false);
});

test("a timeout result from an abandoned Discord route cannot mutate current tombstones", async () => {
  let resolveRequest;
  const harness = timeoutHarness({
    send: () => new Promise((resolve) => { resolveRequest = resolve; })
  });
  const record = makeRecord();
  const key = mountRecord(harness, record);
  harness.context.queueTombstoneTimeoutResolution(record, true);
  fireOnlyTimer(harness);
  const inFlight = harness.state.memberTimeoutPromise;
  harness.state.route = {
    guildId: "777777777777777777",
    channelId: "888888888888888888",
    routeKey: "777777777777777777:888888888888888888"
  };
  resolveRequest({
    ok: true,
    timeouts: [{
      messageId: record.messageId,
      userId: record.authorId,
      timeoutUntil: "2026-09-01T12:00:00.000Z"
    }]
  });
  await inFlight;
  assert.equal(harness.state.memberTimeoutsByMessage.has(key), false);
});

test("a timeout result cannot resurrect state after its tombstone unmounts", async () => {
  let resolveRequest;
  const harness = timeoutHarness({
    send: () => new Promise((resolve) => { resolveRequest = resolve; })
  });
  const record = makeRecord();
  const key = mountRecord(harness, record);
  harness.context.queueTombstoneTimeoutResolution(record, true);
  fireOnlyTimer(harness);
  const inFlight = harness.state.memberTimeoutPromise;
  harness.context.dropTombstoneRenderer(key);
  resolveRequest({
    ok: true,
    timeouts: [{
      messageId: record.messageId,
      userId: record.authorId,
      timeoutUntil: "2026-09-01T12:00:00.000Z"
    }]
  });

  await inFlight;
  assert.equal(harness.state.memberTimeoutsByMessage.has(key), false);
});

test("future, null, missing, and failed timeout statuses remain distinct", async () => {
  const future = "2026-09-01T12:00:00.000Z";
  const records = [makeRecord(0), makeRecord(1, "555555555555555556"), makeRecord(2, "555555555555555557")];
  let response = {
    ok: true,
    timeouts: [
      { messageId: records[0].messageId, userId: records[0].authorId, timeoutUntil: future },
      { messageId: records[1].messageId, userId: records[1].authorId, timeoutUntil: null }
    ]
  };
  const harness = timeoutHarness({ send: async () => response });
  const keys = records.map((record) => mountRecord(harness, record));
  records.forEach((record) => harness.context.queueTombstoneTimeoutResolution(record, true));
  fireOnlyTimer(harness);
  await harness.state.memberTimeoutPromise;

  assert.deepEqual(JSON.parse(JSON.stringify(harness.state.memberTimeoutsByMessage.get(keys[0]))), {
    userId: records[0].authorId, known: true, timeoutUntil: future,
    checkedAt: harness.clock.now()
  });
  assert.deepEqual(JSON.parse(JSON.stringify(harness.state.memberTimeoutsByMessage.get(keys[1]))), {
    userId: records[1].authorId, known: true, timeoutUntil: null,
    checkedAt: harness.clock.now()
  });
  assert.deepEqual(JSON.parse(JSON.stringify(harness.state.memberTimeoutsByMessage.get(keys[2]))), {
    userId: records[2].authorId, known: false, timeoutUntil: null,
    checkedAt: harness.clock.now()
  });

  response = { ok: false, reason: "guild-member-store-unavailable", timeouts: [] };
  harness.context.queueTombstoneTimeoutResolution(records[0], true);
  const flushTimer = [...harness.timers.entries()].find(([, timer]) => timer.delay === 50);
  assert.ok(flushTimer);
  harness.timers.delete(flushTimer[0]);
  flushTimer[1].callback();
  await harness.state.memberTimeoutPromise;
  assert.equal(harness.state.memberTimeoutsByMessage.get(keys[0]).known, false);
  assert.equal(harness.state.memberTimeoutsByMessage.get(keys[0]).timeoutUntil, null);
});

test("badge visibility fails closed and is removed at the exact verified deadline", () => {
  const assignment = sourceBetween(
    "    render.refreshTimeoutStatus = () => {",
    "    render.setContinuation = (value) => {"
  );
  const now = Date.parse("2026-08-31T12:00:00.000Z");
  const clock = fakeDateClock(now);
  const key = `${CHANNEL_ID}:${MESSAGE_ID}`;
  const attrs = new Map([["role", "img"]]);
  const timeoutBadge = {
    hidden: true,
    title: "",
    setAttribute(name, value) { attrs.set(name, String(value)); if (name === "title") this.title = String(value); },
    removeAttribute(name) { attrs.delete(name); if (name === "title") this.title = ""; }
  };
  const state = { memberTimeoutsByMessage: new Map() };
  const render = { timeoutMessageKey: key, timeoutUserId: USER_ID };
  const context = vm.createContext({ state, render, timeoutBadge, Date: clock.Date, Number, String });
  vm.runInContext(`${assignment}
    globalThis.refreshTimeoutStatus = render.refreshTimeoutStatus;`, context);

  state.memberTimeoutsByMessage.set(key, {
    userId: USER_ID, known: false, timeoutUntil: "2026-09-01T12:00:00.000Z"
  });
  context.refreshTimeoutStatus();
  assert.equal(timeoutBadge.hidden, true, "unknown state never displays a positive status");

  state.memberTimeoutsByMessage.set(key, { userId: USER_ID, known: true, timeoutUntil: null });
  context.refreshTimeoutStatus();
  assert.equal(timeoutBadge.hidden, true, "known no-timeout state remains hidden");

  const deadline = now + 1000;
  state.memberTimeoutsByMessage.set(key, {
    userId: USER_ID, known: true, timeoutUntil: new Date(deadline).toISOString()
  });
  context.refreshTimeoutStatus();
  assert.equal(timeoutBadge.hidden, false);
  assert.match(attrs.get("aria-label"), /^Timed out until /);
  assert.equal(timeoutBadge.title, attrs.get("aria-label"));

  clock.setNow(deadline);
  context.refreshTimeoutStatus();
  assert.equal(timeoutBadge.hidden, true);
  assert.equal(attrs.has("aria-label"), false);
  assert.equal(timeoutBadge.title, "");
});

test("the earliest deadline owns one expiry timer and forces removal plus revalidation", () => {
  let refreshes = 0;
  const harness = timeoutHarness();
  const record = makeRecord();
  const key = mountRecord(harness, record, () => { refreshes += 1; });
  const deadline = harness.clock.now() + 1000;
  harness.state.memberTimeoutsByMessage.set(key, {
    userId: record.authorId,
    known: true,
    timeoutUntil: new Date(deadline).toISOString(),
    checkedAt: harness.clock.now()
  });

  harness.context.scheduleMemberTimeoutExpiry();
  assert.equal(harness.timers.size, 1);
  const [token, timer] = harness.timers.entries().next().value;
  harness.timers.delete(token);
  assert.equal(timer.delay, 1025);
  harness.clock.setNow(deadline + 25);
  timer.callback();
  assert.equal(refreshes, 1);
  assert.deepEqual([...harness.state.pendingTimeoutMessageIds], [record.messageId]);
  assert.equal([...harness.timers.values()].some((item) => item.delay === 50), true,
    "expiry immediately queues a fresh store check after hiding stale UI");
});

test("a successful timeout action immediately refreshes every mounted row for that guild member", () => {
  const harness = timeoutHarness();
  let sameAuthorRefreshes = 0;
  let otherAuthorRefreshes = 0;
  const sameAuthor = [makeRecord(0), makeRecord(1)];
  const otherAuthor = makeRecord(2, "555555555555555559");
  const sameKeys = sameAuthor.map((record) => mountRecord(harness, record, () => { sameAuthorRefreshes += 1; }));
  const otherKey = mountRecord(harness, otherAuthor, () => { otherAuthorRefreshes += 1; });

  harness.context.rememberSuccessfulTimeout(GUILD_ID, USER_ID);
  assert.equal(sameAuthorRefreshes, 2);
  assert.equal(otherAuthorRefreshes, 0);
  for (const key of sameKeys) {
    const item = harness.state.memberTimeoutsByMessage.get(key);
    assert.equal(item.known, true);
    assert.equal(Date.parse(item.timeoutUntil), harness.clock.now() + 7 * 24 * 60 * 60 * 1000);
  }
  assert.equal(harness.state.memberTimeoutsByMessage.has(otherKey), false);
  assert.equal([...harness.timers.values()].some((item) => item.delay === 1000), true,
    "the optimistic action result is followed by an authoritative store refresh");
  const actionRefresh = sourceBetween("  function rememberSuccessfulTimeout(", "  function createAuthorActionControls(");
  assert.match(actionRefresh, /scheduleMountedTimeoutRefresh\(true, userId\)/,
    "action verification stays scoped to the member whose timeout changed");
});

test("native timed-out vectors are excluded at capture and from compatible old archives", () => {
  const badgeHelpers = sourceBetween("  function describedLabel(", "  function captureAuthorStyle(");
  let wrapper;
  const authorElement = {
    closest() { return wrapper; }
  };
  const timedOut = {
    contains() { return false; },
    matches() { return false; },
    getAttribute(name) { return name === "aria-label" ? "Timed Out until tomorrow" : null; },
    querySelector() { throw new Error("a timeout vector should be rejected before SVG capture"); }
  };
  wrapper = { children: [authorElement, timedOut], parentElement: null };
  const context = vm.createContext({
    Core,
    document: { getElementById() { return null; } },
    normalizedAvatarUrl() { return null; },
    safeColor() { return null; },
    safeCssValue() { return null; },
    getComputedStyle() { return {}; },
    Number,
    String,
    Set
  });
  vm.runInContext(`${badgeHelpers}
    globalThis.captureAuthorBadges = captureAuthorBadges;`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.captureAuthorBadges(authorElement))), []);

  const sanitized = Core.sanitizeAuthorBadges([
    {
      kind: "vector", label: "Timed-Out", viewBox: "0 0 24 24", width: 18, height: 18,
      paths: [{ d: "M1 1L2 2Z", fill: "currentColor" }]
    },
    { kind: "text", text: "MOD", label: "Moderator" }
  ]);
  assert.deepEqual(sanitized, [{
    kind: "text", text: "MOD", label: "Moderator",
    color: null, backgroundColor: null, borderRadius: null
  }]);
});

test("timeout resolution is absent from live hover and scroll-time extraction paths", () => {
  const live = sourceBetween("  function createLiveAuthorActionRenderer(", "  function storedTime(");
  const snapshot = sourceBetween("  function snapshotRenderedMessages(", "  function scheduleSnapshot(");
  const mutation = sourceBetween("  function handleMutations(", "  function noteScroll(");
  const scrollCapture = sourceBetween("  function capturePendingScrollRows(", "  function scheduleScrollingCapture(");

  for (const productionPath of [live, snapshot, mutation, scrollCapture]) {
    assert.doesNotMatch(productionPath, /RESOLVE_MEMBER_TIMEOUTS|flushMemberTimeouts|scheduleMountedTimeoutRefresh/);
  }
  assert.match(source, /message\.kind === "timeout-state-dirty"[\s\S]*scheduleMountedTimeoutRefresh\(true, userId\)/);
  assert.match(source, /lastTimeoutInvalidationByUser\.get\(userId\)/,
    "rapid updates for different authors must not suppress one another");
  assert.match(source, /lastTimeoutInvalidationByUser\.size > 5000/);
  assert.match(source, /setInterval\(\(\) => scheduleMountedTimeoutRefresh\(true\), 30000\)/);
});
