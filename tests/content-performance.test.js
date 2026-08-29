"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/content.js"), "utf8");

function productionFunctions(startName, endName) {
  const start = source.indexOf(`  function ${startName}(`);
  const end = source.indexOf(`  function ${endName}(`, start);
  assert.ok(start >= 0 && end > start, `production function boundaries: ${startName} / ${endName}`);
  return source.slice(start, end);
}

function element(options = {}) {
  const value = {
    nodeType: 1,
    parentElement: options.parent || null,
    contains(candidate) { return options.contains?.includes(candidate) || false; },
    matches() { return Boolean(options.extension); },
    closest() { return options.extension ? value : null; }
  };
  return value;
}

test("extension-authored observer records are ignored without hiding native list changes", () => {
  const context = vm.createContext({ Node: { ELEMENT_NODE: 1 } });
  vm.runInContext(`${productionFunctions("extensionManagedNode", "explicitRootReplacement")}
    globalThis.extensionOnlyMutation = extensionOnlyMutation;
    globalThis.mutationTouchesMessageSurface = mutationTouchesMessageSurface;`, context);
  const list = element();
  const managed = element({ extension: true });
  const native = element();
  const listChild = element({ parent: list });
  list.contains = (candidate) => candidate === listChild;

  assert.equal(context.extensionOnlyMutation({ addedNodes: [managed], removedNodes: [] }), true);
  assert.equal(context.extensionOnlyMutation({ addedNodes: [managed, native], removedNodes: [] }), false);
  assert.equal(context.mutationTouchesMessageSurface({ target: listChild, addedNodes: [], removedNodes: [] }, list), true);
  assert.equal(context.mutationTouchesMessageSurface({ target: native, addedNodes: [], removedNodes: [] }, list), false);
});

test("equal archive revisions stop before normalization and DOM reconciliation", () => {
  let compared = 0;
  const context = vm.createContext({
    state: {
      archiveInitialized: true,
      generation: 4,
      archive: { generation: 4, revision: 9, records: [] }
    },
    Protocol: { shouldApplyArchive() { compared += 1; throw new Error("should not compare equal revisions"); } }
  });
  vm.runInContext(`${productionFunctions("applyArchive", "requestMediaRecovery")}
    globalThis.applyArchive = applyArchive;`, context);
  context.applyArchive({ generation: 4, revision: 9, records: [] });
  assert.equal(compared, 0);
});

test("scroll performance guards precede expensive subtree work and row extraction is visibility-gated", () => {
  const mutation = productionFunctions("handleMutations", "noteScroll");
  assert.ok(mutation.indexOf("performance.now() - state.lastScrollAt") < mutation.indexOf("countElementTree(node)"));
  assert.match(mutation, /collectScrollCaptureRows\(relevantMutations, route\)/);
  assert.match(mutation, /rememberRecentRemovedMessages\(relevantMutations, route\)/);
  assert.ok(mutation.indexOf("rememberRecentRemovedMessages(relevantMutations, route)") <
    mutation.indexOf("trimPendingScrollRows()"));
  assert.match(mutation, /scheduleScrollingCapture\(true\)/);
  const snapshot = productionFunctions("snapshotRenderedMessages", "scheduleSnapshot");
  assert.match(snapshot, /wasActuallyVisible \? recordFromNode\(node, nowDate\) : null/);
  assert.doesNotMatch(snapshot, /active\.rows\.map\(\(node\) => recordFromNode/);
  const scrolling = productionFunctions("noteScroll", "knownDeletion");
  assert.match(scrolling, /clearTimeout\(state\.scrollSettleTimer\)/);
  assert.match(scrolling, /scheduleSnapshot\(false, 0\)/);
});

test("scroll fast path records known removals without subtree classification", () => {
  const message = {};
  const newlyMountedThenRemoved = {};
  const list = {};
  const snapshot = { messageId: "222222222222222222", listNode: list, record: { channelId: "111111111111111111" } };
  const pendingSnapshot = { messageId: "333333333333333333", listNode: list, record: { channelId: "111111111111111111" } };
  const context = vm.createContext({
    state: {
      activeList: list,
      snapshots: new WeakMap([[message, snapshot]]),
      pendingScrollRows: new Set([newlyMountedThenRemoved]),
      priorityScrollRows: new Set(),
      recentRemovals: new Map()
    },
    performance: { now: () => 500 },
    uniqueMessageNodes: (node) => node.rows,
    rowIdentity: (node) => node === newlyMountedThenRemoved ? { messageId: pendingSnapshot.messageId } : null
  });
  vm.runInContext(`${productionFunctions("rememberRecentRemovedMessages", "findChatScrollContainer")}
    globalThis.rememberRecentRemovedMessages = rememberRecentRemovedMessages;`, context);
  context.rememberRecentRemovedMessages([
    { removedNodes: [{ rows: [message, newlyMountedThenRemoved] }] }
  ], { channelId: "111111111111111111" });
  assert.equal(context.state.recentRemovals.get("111111111111111111:222222222222222222"), 500);
  assert.equal(context.state.recentRemovals.get("111111111111111111:333333333333333333"), 500);
  assert.equal(context.state.pendingScrollRows.size, 1,
    "detached rows stay queued for the bounded capture instead of extracting synchronously");
  assert.equal(context.state.priorityScrollRows.has(newlyMountedThenRemoved), true);
});

test("list-level mutations queue only changed rows, never the whole virtual list", () => {
  const list = { nodeType: 1, matches: () => false, closest: () => null };
  const unchangedRows = Array.from({ length: 100 }, (_, index) => ({ messageId: `9${String(index).padStart(17, "0")}` }));
  list.descendants = unchangedRows;
  const changedRow = { nodeType: 1, matches: () => true, closest() { return this; }, messageId: "888888888888888888" };
  const context = vm.createContext({
    Node: { ELEMENT_NODE: 1 },
    MESSAGE_SELECTOR: "message",
    state: { pendingScrollRows: new Set() },
    extensionManagedNode: () => false,
    rowIdentity: (node) => node.messageId ? { channelId: "111111111111111111", messageId: node.messageId } : null,
    uniqueMessageNodes: (node) => node.descendants || (node.messageId ? [node] : [])
  });
  vm.runInContext(`${productionFunctions("collectScrollCaptureRows", "rememberRecentRemovedMessages")}
    globalThis.collectScrollCaptureRows = collectScrollCaptureRows;`, context);
  context.collectScrollCaptureRows([
    { target: list, addedNodes: [changedRow] }
  ], { channelId: "111111111111111111" });
  assert.deepEqual([...context.state.pendingScrollRows], [changedRow]);
});

test("removal priority is assigned before a full scroll queue is trimmed", () => {
  const channelId = "111111111111111111";
  const pending = Array.from({ length: 500 }, (_, index) => ({
    messageId: `8${String(index).padStart(17, "0")}`,
    nodeType: 1
  }));
  const removed = pending[0];
  const changed = {
    messageId: "999999999999999999",
    nodeType: 1,
    matches: () => true,
    closest() { return this; }
  };
  const list = { nodeType: 1, matches: () => false, closest: () => null };
  const removedRoot = { nodeType: 1, removedRows: [removed] };
  const context = vm.createContext({
    Node: { ELEMENT_NODE: 1 },
    MESSAGE_SELECTOR: "message",
    state: {
      activeList: null,
      pendingScrollRows: new Set(pending),
      priorityScrollRows: new Set(),
      snapshots: new WeakMap(),
      recentRemovals: new Map()
    },
    performance: { now: () => 700 },
    extensionManagedNode: () => false,
    rowIdentity: (node) => node.messageId ? { channelId, messageId: node.messageId } : null,
    uniqueMessageNodes: (node) => node.removedRows || (node === changed ? [changed] : [])
  });
  vm.runInContext(`${productionFunctions("collectScrollCaptureRows", "findChatScrollContainer")}
    globalThis.collectScrollCaptureRows = collectScrollCaptureRows;
    globalThis.rememberRecentRemovedMessages = rememberRecentRemovedMessages;
    globalThis.trimPendingScrollRows = trimPendingScrollRows;`, context);
  const mutation = { target: list, addedNodes: [changed], removedNodes: [removedRoot] };
  context.collectScrollCaptureRows([mutation], { channelId });
  assert.equal(context.state.pendingScrollRows.size, 501);
  context.rememberRecentRemovedMessages([mutation], { channelId });
  context.trimPendingScrollRows();
  assert.equal(context.state.pendingScrollRows.size, 500);
  assert.equal(context.state.pendingScrollRows.has(removed), true);
  assert.equal(context.state.priorityScrollRows.has(removed), true);
  assert.equal(context.state.recentRemovals.get(`${channelId}:${removed.messageId}`), 700);
  assert.equal(context.state.pendingScrollRows.has(pending[1]), false,
    "the oldest ordinary virtualization row is evicted instead of the lifecycle row");
});

test("scroll row capture is rate-limited and retains detached row references", () => {
  const helpers = productionFunctions("capturePendingScrollRows", "findChatScrollContainer");
  assert.match(helpers, /Core\.createRateLimitedScheduler/);
  assert.match(helpers, /SCROLL_CAPTURE_INTERVAL_MS/);
  assert.match(helpers, /const rows = \[\.\.\.state\.pendingScrollRows\]/);
  assert.match(helpers, /state\.pendingScrollRows\.delete\(row\)/);
  assert.doesNotMatch(helpers, /state\.pendingScrollRows\.clear\(\)/);
  const row = { isConnected: false };
  const captures = [];
  const context = vm.createContext({
    state: { pendingScrollRows: new Set([row]), priorityScrollRows: new Set() },
    Core: { parseDiscordRoute: () => ({ channelId: "111111111111111111" }) },
    location: { pathname: "/channels/111/222" },
    performance: { now: () => 10 },
    SCROLL_CAPTURE_ROWS_PER_FRAME: 4,
    SCROLL_CAPTURE_FRAME_BUDGET_MS: 5,
    captureScrollMessageNode(node, route, persist) { captures.push({ node, route, persist }); }
  });
  vm.runInContext(`${productionFunctions("capturePendingScrollRows", "scheduleScrollingCapture")}
    globalThis.capturePendingScrollRows = capturePendingScrollRows;`, context);
  context.capturePendingScrollRows(true);
  assert.deepEqual(captures, [{ node: row, route: { channelId: "111111111111111111" }, persist: true }]);
  assert.equal(context.state.pendingScrollRows.size, 0);
});

test("one scroll frame captures a small detached-first work budget", () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({ index, isConnected: index % 2 === 1 }));
  const captures = [];
  const continuation = [];
  const context = vm.createContext({
    state: {
      pendingScrollRows: new Set(rows),
      priorityScrollRows: new Set(),
      scrollCaptureFrameScheduler: (persist, delay) => continuation.push({ persist, delay })
    },
    Core: { parseDiscordRoute: () => ({ channelId: "111111111111111111" }) },
    location: { pathname: "/channels/111/222" },
    performance: { now: () => 10 },
    SCROLL_CAPTURE_ROWS_PER_FRAME: 4,
    SCROLL_CAPTURE_FRAME_BUDGET_MS: 5,
    captureScrollMessageNode: (row) => captures.push(row)
  });
  vm.runInContext(`${productionFunctions("capturePendingScrollRows", "scheduleScrollingCapture")}
    globalThis.capturePendingScrollRows = capturePendingScrollRows;`, context);
  context.capturePendingScrollRows(true);
  assert.equal(captures.length, 4);
  assert.equal(captures.every((row) => !row.isConnected), true, "detached lifecycle rows have priority");
  assert.equal(context.state.pendingScrollRows.size, 6);
  assert.deepEqual(continuation, [{ persist: true, delay: 0 }]);
});

test("a lifecycle removal jumps ahead of a 500-row detached backlog", () => {
  const rows = Array.from({ length: 500 }, (_, index) => ({ index, isConnected: false }));
  const removed = rows[499];
  const captures = [];
  const context = vm.createContext({
    state: {
      pendingScrollRows: new Set(rows),
      priorityScrollRows: new Set([removed]),
      scrollCaptureFrameScheduler() {}
    },
    Core: { parseDiscordRoute: () => ({ channelId: "111111111111111111" }) },
    location: { pathname: "/channels/111/222" },
    performance: { now: () => 10 },
    SCROLL_CAPTURE_ROWS_PER_FRAME: 4,
    SCROLL_CAPTURE_FRAME_BUDGET_MS: 5,
    captureScrollMessageNode: (row) => captures.push(row)
  });
  vm.runInContext(`${productionFunctions("capturePendingScrollRows", "scheduleScrollingCapture")}
    globalThis.capturePendingScrollRows = capturePendingScrollRows;`, context);
  context.capturePendingScrollRows(true);
  assert.equal(captures[0], removed);
  assert.equal(captures.length, 4);
  assert.equal(context.state.pendingScrollRows.size, 496);
});

test("scroll persistence batches many captures into one bounded archive flush", () => {
  const timers = new Map();
  let token = 0;
  let clears = 0;
  const context = vm.createContext({
    state: { signatures: new Map(), pendingRecords: new Map(), generation: 7, flushTimer: null },
    Core: { recordKey: (record) => record.key },
    recordSignature: (record) => record.value,
    setTimeout(callback, delay) { const id = ++token; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { if (timers.delete(id)) clears += 1; },
    flushRecords() {}
  });
  vm.runInContext(`${productionFunctions("queueRecord", "flushRecords")}
    globalThis.queueRecord = queueRecord;`, context);
  for (let index = 0; index < 100; index += 1) {
    context.queueRecord({ key: `row-${index}`, value: `value-${index}` }, { deferDuringScroll: true });
  }
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].delay, 1250);
  assert.equal(clears, 0, "scroll captures must not reset the bounded flush deadline");
  context.queueRecord({ key: "urgent-edit", value: "urgent" });
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].delay, 180);
  assert.equal(clears, 1, "non-scroll durability work may promote the batch to an immediate flush");
});

test("media frames unload offscreen, re-arm on entry, and leave no routing entry on dispose", () => {
  let observer;
  class FakeIntersectionObserver {
    constructor(callback, options) { this.callback = callback; this.options = options; this.disconnected = false; observer = this; }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
  }
  const attributes = new Map();
  const contentWindow = { postMessage() {} };
  const frame = {
    dataset: {},
    style: { width: "420px", height: "240px" },
    contentWindow,
    addEventListener(type, callback) { if (type === "load") this.load = callback; },
    hasAttribute(name) { return attributes.has(name); },
    removeAttribute(name) { attributes.delete(name); },
    set src(value) { attributes.set("src", value); },
    get src() { return attributes.get("src") || ""; }
  };
  const context = vm.createContext({
    IntersectionObserver: FakeIntersectionObserver,
    state: { mediaFrameWindows: new Map() },
    chrome: { runtime: { id: "extension-id", getURL: (pathValue) => `chrome-extension://extension-id/${pathValue}` } },
    URL,
    T: { CREATE_MEDIA_CAPABILITY: "capability" },
    send: async () => ({ ok: false }),
    extensionFrameOrigin: () => "chrome-extension://extension-id"
  });
  vm.runInContext(`${productionFunctions("configureMediaFrame", "handleMediaFrameSize")}
    globalThis.configureMediaFrame = configureMediaFrame;`, context);
  const dispose = context.configureMediaFrame(frame, "channel:message", null);
  dispose.setEnabled(true);
  assert.equal(frame.hasAttribute("src"), false);
  observer.callback([{ target: frame, isIntersecting: true }]);
  assert.equal(frame.hasAttribute("src"), true);
  assert.equal(context.state.mediaFrameWindows.get(contentWindow), frame);
  observer.callback([{ target: frame, isIntersecting: false }]);
  assert.equal(frame.hasAttribute("src"), false);
  assert.equal(context.state.mediaFrameWindows.size, 0);
  assert.deepEqual(frame.style, { width: "420px", height: "240px" });
  observer.callback([{ target: frame, isIntersecting: true }]);
  assert.equal(frame.hasAttribute("src"), true);
  dispose();
  assert.equal(observer.disconnected, true);
  assert.equal(frame.hasAttribute("src"), false);
  assert.equal(context.state.mediaFrameWindows.size, 0);
});

test("stale media capabilities cannot cross an iframe exit and re-entry boundary", async () => {
  let observer;
  class FakeIntersectionObserver {
    constructor(callback) { this.callback = callback; observer = this; }
    observe() {}
    disconnect() {}
  }
  const attributes = new Map();
  const posts = [];
  const contentWindow = { postMessage(message) { posts.push(message.capability); } };
  const frame = {
    contentWindow,
    addEventListener(type, callback) { if (type === "load") this.load = callback; },
    hasAttribute(name) { return attributes.has(name); },
    removeAttribute(name) { attributes.delete(name); },
    set src(value) { attributes.set("src", value); },
    get src() { return attributes.get("src") || ""; }
  };
  const resolvers = [];
  const context = vm.createContext({
    IntersectionObserver: FakeIntersectionObserver,
    state: { mediaFrameWindows: new Map() },
    chrome: { runtime: { id: "extension-id", getURL: (pathValue) => `chrome-extension://extension-id/${pathValue}` } },
    URL,
    T: { CREATE_MEDIA_CAPABILITY: "capability" },
    send: () => new Promise((resolve) => resolvers.push(resolve)),
    extensionFrameOrigin: () => "chrome-extension://extension-id"
  });
  vm.runInContext(`${productionFunctions("configureMediaFrame", "handleMediaFrameSize")}
    globalThis.configureMediaFrame = configureMediaFrame;`, context);
  const dispose = context.configureMediaFrame(frame, "channel:message", null);
  dispose.setEnabled(true);
  observer.callback([{ target: frame, isIntersecting: true }]);
  frame.load();
  observer.callback([{ target: frame, isIntersecting: false }]);
  observer.callback([{ target: frame, isIntersecting: true }]);
  frame.load();
  assert.equal(resolvers.length, 2);
  resolvers[0]({ ok: true, capability: "stale-A" });
  await Promise.resolve();
  assert.deepEqual(posts, []);
  resolvers[1]({ ok: true, capability: "fresh-B" });
  await Promise.resolve();
  assert.deepEqual(posts, ["fresh-B"]);
  dispose();
});

test("live author controls resolve only on action and use one hover-activated renderer", () => {
  assert.equal((source.match(/type: RESOLVE_MESSAGE_AUTHORS/g) || []).length, 1);
  assert.doesNotMatch(source, /queueAuthorResolution/);
  assert.match(source, /document\.addEventListener\("pointerover", handleLiveAuthorActionInterest, true\)/);
  const activation = productionFunctions("activateLiveAuthorActions", "reconcileLiveAuthorActions");
  assert.match(activation, /for \(const \[otherKey, otherRenderer\] of \[\.\.\.state\.liveActionRenderers\]\)/);
  assert.match(activation, /otherRenderer\.dispose\(\)/);
  const interest = productionFunctions("handleLiveAuthorActionInterest", "storedTime");
  assert.ok(interest.indexOf("performance.now() - state.lastScrollAt") < interest.indexOf("findActiveMessageList()"));
});
