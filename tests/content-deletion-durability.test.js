"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Core = require("../src/core.js");
const Protocol = require("../src/protocol.js");

const source = fs.readFileSync(path.join(__dirname, "../src/content.js"), "utf8");
const CHANNEL_ID = "777777777777777777";
const OTHER_CHANNEL_ID = "777777777777777778";
const MESSAGE_ID = "888888888888888881";
const GUILD_ID = "666666666666666666";
const T = Protocol.TYPES;

function productionFunction(name) {
  const start = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(source);
  assert.ok(start, `production function exists: ${name}`);
  const remainder = source.slice(start.index);
  const end = /^  }\r?$/m.exec(remainder);
  assert.ok(end, `production function ends: ${name}`);
  return remainder.slice(0, end.index + end[0].length);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// Execute the production capture/lifecycle/broker code together. The fake DOM
// supplies only native rows, and the broker runs the real archive reducer. No
// lifecycle state transition is reimplemented by this harness.
function createHarness(options = {}) {
  let now = 1000;
  const epoch = Date.now();
  let timerId = 0;
  let sendOverride = null;
  let archive = options.archive || Protocol.emptyArchive();
  const timers = new Map();
  const requests = [];
  const posts = [];
  const listeners = new Map();
  const extractionRoutes = [];
  const domQueries = [];
  const scheduledFrames = [];
  let retainedLookups = 0;
  const rows = new Map();
  const lists = new Map();
  const routeFor = (channelId) => Core.parseDiscordRoute(`/channels/${GUILD_ID}/${channelId}`);
  const keyFor = (channelId, messageId) => `${channelId}:${messageId}`;
  const location = { pathname: `/channels/${GUILD_ID}/${CHANNEL_ID}` };
  const setTimer = (callback, delay = 0) => {
    const id = ++timerId;
    timers.set(id, { callback, due: now + Math.max(0, Number(delay) || 0) });
    return id;
  };
  const record = (overrides = {}) => Object.assign({
    channelId: CHANNEL_ID,
    guildId: GUILD_ID,
    messageId: MESSAGE_ID,
    author: "Native author",
    content: "original native payload",
    status: "seen",
    capturedAt: epoch,
    updatedAt: epoch,
    captureSessionId: "test-capture-session",
    captureSequence: 1,
    attachments: [],
    media: []
  }, overrides);
  const listFor = (channelId) => {
    if (!lists.has(channelId)) {
      lists.set(channelId, {
        channelId, isConnected: true, nodeType: 1, tagName: "OL",
        matches: () => false,
        closest: () => null,
        contains: (row) => row?.channelId === channelId && row.isConnected,
        getBoundingClientRect: () => ({ top: 0, bottom: 700, width: 800, height: 700 })
      });
    }
    return lists.get(channelId);
  };
  const rowIdentity = (row) => row?.messageId ? { channelId: row.channelId, messageId: row.messageId } : null;
  function addRow(overrides = {}) {
    const value = record(overrides);
    const row = {
      ...value,
      nodeType: 1,
      isConnected: true,
      id: `chat-messages-${value.channelId}-${value.messageId}`,
      dataset: {},
      parentElement: listFor(value.channelId),
      matches: (selector) => selector.includes("chat-messages"),
      closest: (selector) => selector.includes("chat-messages") ? row : null,
      querySelector: () => null,
      getBoundingClientRect: () => ({ top: 200, bottom: 240, width: 600, height: 40 }),
      setAttribute(name, value) {
        if (name.startsWith("data-")) row.dataset[name.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = String(value);
      },
      removeAttribute(name) {
        if (name.startsWith("data-")) delete row.dataset[name.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())];
      }
    };
    const classes = new Set();
    row.classList = {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name)
    };
    rows.set(keyFor(value.channelId, value.messageId), row);
    return row;
  }
  const findActiveMessageList = () => {
    const route = Core.parseDiscordRoute(location.pathname);
    if (!route) return null;
    const visibleRows = [...rows.values()].filter((row) => row.isConnected && row.channelId === route.channelId);
    if (!visibleRows.length) return null;
    return { node: listFor(route.channelId), route, identity: `${route.routeKey}|chat-messages`, rows: visibleRows };
  };
  const initialState = /^  const state = ({[\s\S]*?^  });/m.exec(source);
  assert.ok(initialState, "production content state initializer exists");
  const state = vm.runInNewContext(`(${initialState[1]})`, {
    Core, Protocol, location, performance: { now: () => now }, Map, Set, WeakMap
  });
  state.activeList = listFor(CHANNEL_ID);
  state.listIdentity = `${routeFor(CHANNEL_ID).routeKey}|chat-messages`;
  const document = {
    visibilityState: options.hidden ? "hidden" : "visible",
    querySelectorAll(selector) {
      domQueries.push(selector);
      if (selector.includes("li[id^='chat-messages-']")) return [...rows.values()].filter((row) => row.isConnected);
      if (selector === ".ldma-retained-deleted") {
        return [...rows.values()].filter((row) => row.classList.contains("ldma-retained-deleted"));
      }
      if (selector === "[data-ldma-native-replaced]") {
        return [...rows.values()].filter((row) => row.dataset.ldmaNativeReplaced === "true");
      }
      return [];
    }
  };
  const windowValue = {
    postMessage: (message) => posts.push(message),
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    }
  };
  const context = vm.createContext({
    Core, Protocol, T, state, location, document, Date, Map, Set, WeakMap,
    SNOWFLAKE: /^\d{15,25}$/,
    BRIDGE: "LDMA_BRIDGE_V1", EDIT_EVENT: "LDMA_EDIT_BEFORE_V1", LIVE_HEALTH: "LDMA_REPORT_LIVE_HEALTH",
    MESSAGE_SELECTOR: "li[id^='chat-messages-'], [data-list-item-id^='chat-messages___']",
    SCROLL_CAPTURE_INTERVAL_MS: 250, SCROLL_CAPTURE_ROWS_PER_FRAME: 4, SCROLL_CAPTURE_FRAME_BUDGET_MS: 5,
    captureSessionId: "test-capture-session", captureSequence: 0,
    Node: { ELEMENT_NODE: 1 }, performance: { now: () => now }, innerHeight: 800,
    setTimeout: setTimer, clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame: (callback) => {
      const id = setTimer(callback, 16);
      scheduledFrames.push(id);
      return id;
    }, cancelAnimationFrame: (id) => timers.delete(id),
    window: windowValue,
    rowIdentity, rawRowId: (row) => row.id,
    retainedRow: (channelId, messageId, activeRoot) => {
      retainedLookups += 1;
      const row = rows.get(keyFor(channelId, messageId));
      return row?.isConnected && (!activeRoot || activeRoot.contains(row)) ? row : null;
    },
    liveMessageExists: (channelId, messageId) => Boolean(rows.get(keyFor(channelId, messageId))?.isConnected),
    findActiveMessageList,
    updateActiveList() {
      const active = findActiveMessageList();
      state.activeList = active?.node || null;
      state.listIdentity = active?.identity || null;
      return active;
    },
    uniqueMessageNodes(root, route) {
      return [...rows.values()].filter((row) => (row === root || row.parentElement === root) &&
        (!route || row.channelId === route.channelId));
    },
    extensionManagedNode: () => false,
    captureMedia: () => [],
    allContent: (row) => row.content,
    captureReply: () => null,
    capturedReply: (_record, reply) => reply,
    groupRootFromNode: (_row, messageId) => messageId,
    visibleChannelName: () => "Native channel",
    authorNameElement: (row) => ({ textContent: row.author }),
    visibleElementText: (element) => element?.textContent || "",
    firstText: () => "", authorFromAriaLabelledBy: () => "", AUTHOR_SELECTORS: [],
    presentationFromNode: (row) => {
      extractionRoutes.push({ rowChannelId: row.channelId, currentChannelId: Core.parseDiscordRoute(location.pathname)?.channelId });
      return {};
    },
    recordHasCacheableMedia: () => false,
    findChatScrollContainer: () => null,
    verifyPendingEditsForRecord() {}, retractIfReappeared() {},
    reconcileTombstones() {}, reconcileEditHistories() {}, reconcileLiveAuthorActions() {},
    removeTombstone() {}, removeEditHistories() {}, removeLiveAuthorActions() {},
    replaceVisibleRetainedRows() {}, requestMediaRecovery() {},
    stageSelfEditLifecycle() {}, confirmEditLifecycle() {}, cancelSelfEditLifecycle() {}, reportCombinedHealth() {},
    queueConfirmedMounts() {}, scheduleSnapshot() {}, requestPageHook: async () => {},
    send: async (command) => {
      requests.push(command);
      const normal = () => {
        const result = Protocol.applyCommand(archive, command, epoch + now);
        archive = result.archive;
        return { ok: result.accepted, reason: result.reason, archive: result.archive };
      };
      return sendOverride ? sendOverride(command, normal) : normal();
    }
  });
  const functions = [
    "recordFromNode", "recordSignature", "queueRecord", "flushRecords", "flushAllRecords", "applyArchive", "refreshArchive",
    "retainedRowsByKey", "scheduleRetainedStyles", "applyRetainedStyles", "snapshotRenderedMessages", "captureScrollMessageNode", "capturePendingScrollRows",
    "scheduleScrollingCapture", "collectScrollCaptureRows", "rememberRecentRemovedMessages", "trimPendingScrollRows",
    "findMessage", "evaluateCandidate", "discardPendingEdit", "commitPendingEdit", "verifyPendingEdit", "editLifecycleIdentity",
    "knownDeletion", "acknowledgeDeletion", "discardDeletionKey", "fresherDeletionRecord", "captureRetainedMessage", "scheduleDeletionDrain", "queueLifecycleDeletions", "drainPendingDeletions",
    "confirmLifecycleDeletion", "confirmRetainedDeletion", "installPageBridge", "signalPageBridgeReady", "checkRoute"
  ];
  vm.runInContext(functions.map(productionFunction).join("\n"), context);
  context.installPageBridge();
  if (!options.uninitialized) context.applyArchive(archive);

  async function settle() {
    for (let index = 0; index < 30; index += 1) await Promise.resolve();
  }
  async function tick(milliseconds, limit = 100) {
    const target = now + milliseconds;
    for (let iteration = 0; iteration < limit; iteration += 1) {
      const next = [...timers.entries()].filter(([, timer]) => timer.due <= target)
        .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
      if (!next) { now = target; await settle(); return; }
      timers.delete(next[0]);
      now = next[1].due;
      const result = next[1].callback();
      if (result?.then) await result;
      await settle();
    }
    assert.fail("durability harness exceeded bounded timer drain");
  }
  return {
    context, state, document, requests, posts, rows, timers, extractionRoutes, domQueries, scheduledFrames, record, addRow, settle, tick,
    get retainedLookups() { return retainedLookups; },
    resetMetrics() { domQueries.length = 0; scheduledFrames.length = 0; extractionRoutes.length = 0; retainedLookups = 0; },
    get archive() { return archive; },
    setSendOverride(value) { sendOverride = value; },
    setArchive(value) { archive = value; context.applyArchive(value); },
    seedSnapshot(value) {
      state.snapshotsByKey.set(Core.recordKey(value), {
        record: value, messageId: value.messageId, routeKey: routeFor(value.channelId).routeKey,
        listNode: listFor(value.channelId), listIdentity: `${routeFor(value.channelId).routeKey}|chat-messages`,
        parentNode: listFor(value.channelId), previousId: null, nextId: null, tailCandidate: true,
        capturedAtPerf: now, wasAtBottom: true, visibleRatio: 1
      });
    },
    navigate(channelId) { location.pathname = `/channels/${GUILD_ID}/${channelId}`; context.checkRoute(); },
    async dispatchBridge(message, eventSource = windowValue) {
      const event = { source: eventSource, data: { bridge: "LDMA_BRIDGE_V1", ...message } };
      for (const listener of listeners.get("message") || []) listener(event);
      await settle();
    },
    userCommand(command, notify = true) {
      archive = Protocol.applyCommand(archive, command, epoch + now).archive;
      if (notify) context.applyArchive(archive);
      return archive;
    },
    async drain() { await context.drainPendingDeletions(); await settle(); }
  };
}

test("retained deletion captures an exact hidden native row before acknowledging persistence", async () => {
  const harness = createHarness({ hidden: true });
  harness.addRow();
  harness.context.snapshotRenderedMessages(true);
  assert.equal(harness.state.pendingRecords.size, 0, "ordinary hidden-page snapshots remain visibility-gated");
  await harness.context.confirmRetainedDeletion(CHANNEL_ID, [MESSAGE_ID]);
  await harness.drain();
  const archived = harness.archive.records.find((item) => item.messageId === MESSAGE_ID);
  assert.equal(archived?.content, "original native payload");
  assert.equal(archived?.status, "confirmed_deleted");
  assert.equal(harness.state.pendingDeletions.size, 0);
  assert.equal(harness.posts.filter((message) => message.kind === "deletion-ack").length, 1);
});

test("a retained event before initial archive loading binds to the first known generation", async () => {
  const harness = createHarness({ uninitialized: true });
  harness.addRow();
  await harness.context.confirmRetainedDeletion(CHANNEL_ID, [MESSAGE_ID]);
  assert.equal(harness.state.pendingDeletions.size, 1);
  assert.equal(harness.requests.filter((command) => command.type === T.CONFIRM_DELETED).length, 0);
  harness.setArchive({ ...Protocol.emptyArchive(), generation: 3 });
  assert.equal(harness.state.pendingRetainedKeys.has(`${CHANNEL_ID}:${MESSAGE_ID}`), true,
    "initial generation discovery must not discard the queued native retention marker");
  await harness.drain();
  assert.equal(harness.archive.records[0]?.status, "confirmed_deleted");
  assert.equal(harness.requests.find((command) => command.type === T.CONFIRM_DELETED)?.generation, 3);
  assert.equal(harness.posts.filter((message) => message.kind === "reset-deletions").length, 0);
});

test("an early retained event owns its detached row across first archive loading and navigation", async () => {
  const harness = createHarness({ uninitialized: true, archive: { ...Protocol.emptyArchive(), generation: 3 } });
  const row = harness.addRow();
  await harness.dispatchBridge({ kind: "retained", channelId: CHANNEL_ID, ids: [MESSAGE_ID] });
  assert.equal(harness.extractionRoutes.length, 0, "startup queues a row reference without rich extraction");
  row.isConnected = false;
  harness.navigate(OTHER_CHANNEL_ID);
  await harness.settle();
  await harness.drain();
  assert.equal(harness.archive.records[0]?.channelId, CHANNEL_ID);
  assert.equal(harness.archive.records[0]?.content, "original native payload");
  assert.equal(harness.archive.records[0]?.status, "confirmed_deleted");
  assert.equal(harness.state.generation, 3);
});

test("a retained event without a payload remains pending until its native row appears", async () => {
  const harness = createHarness();
  await harness.context.confirmRetainedDeletion(CHANNEL_ID, [MESSAGE_ID]);
  assert.equal(harness.state.pendingDeletions.size, 1);
  assert.equal(harness.requests.filter((command) => command.type === T.CONFIRM_DELETED).length, 0);
  assert.equal(harness.posts.filter((message) => message.kind === "deletion-ack").length, 0);
  harness.addRow();
  await harness.tick(600);
  assert.equal(harness.archive.records[0]?.status, "confirmed_deleted");
  assert.equal(harness.state.pendingDeletions.size, 0);
});

test("a fresh content instance hydrates a serialized confirmed deletion without a native row", async () => {
  const first = createHarness({ hidden: true });
  first.addRow();
  await first.context.confirmRetainedDeletion(CHANNEL_ID, [MESSAGE_ID]);
  const serialized = JSON.parse(JSON.stringify(first.archive));
  assert.equal(serialized.records[0]?.status, "confirmed_deleted");

  const reloaded = createHarness({ uninitialized: true, archive: serialized });
  assert.equal(reloaded.rows.size, 0);
  assert.equal(reloaded.state.archive.records.length, 0);
  await reloaded.context.refreshArchive();
  assert.equal(reloaded.state.archiveByKey.get(`${CHANNEL_ID}:${MESSAGE_ID}`)?.content, "original native payload");
  assert.equal(reloaded.state.archiveByKey.get(`${CHANNEL_ID}:${MESSAGE_ID}`)?.status, "confirmed_deleted");
  assert.equal(reloaded.requests.filter((command) => command.type === T.GET_ARCHIVE).length, 1);
  assert.equal(reloaded.requests.filter((command) => command.type === T.UPSERT_RECORDS).length, 0);
});

test("known off-channel deletion survives navigation and confirms its original snapshot", async () => {
  const harness = createHarness();
  harness.seedSnapshot(harness.record());
  harness.navigate(OTHER_CHANNEL_ID);
  await harness.settle();
  await harness.context.confirmRetainedDeletion(CHANNEL_ID, [MESSAGE_ID]);
  await harness.drain();
  assert.equal(harness.archive.records.find((item) => item.messageId === MESSAGE_ID)?.status, "confirmed_deleted");
  assert.equal(harness.archive.records[0].channelId, CHANNEL_ID);
});

test("ordinary lifecycle confirmation preserves observed removal evidence across navigation", async () => {
  const harness = createHarness();
  const record = harness.record();
  harness.setArchive({ ...Protocol.emptyArchive(), revision: 1, records: [record] });
  harness.seedSnapshot(record);
  harness.state.recentRemovals.set(`${CHANNEL_ID}:${MESSAGE_ID}`, 1000);
  harness.navigate(OTHER_CHANNEL_ID);
  await harness.settle();
  await harness.context.confirmLifecycleDeletion(CHANNEL_ID, [MESSAGE_ID]);
  await harness.drain();
  assert.equal(harness.archive.records[0]?.status, "confirmed_deleted");
  assert.equal(harness.archive.records[0]?.deletionSource, "discord_lifecycle");
  assert.equal(harness.state.pendingDeletions.size, 0);
});

test("ordinary lifecycle confirmation still requires observed native removal", async () => {
  const harness = createHarness();
  const record = harness.record();
  harness.setArchive({ ...Protocol.emptyArchive(), revision: 1, records: [record] });
  harness.seedSnapshot(record);
  await harness.context.confirmLifecycleDeletion(CHANNEL_ID, [MESSAGE_ID]);
  await harness.tick(600);
  assert.equal(harness.archive.records[0]?.status, "seen");
  assert.equal(harness.requests.filter((command) => command.type === T.CONFIRM_DELETED).length, 0);
  assert.equal(harness.posts.filter((message) => message.kind === "deletion-ack").length, 0);
});

test("broker errors keep deletion work pending across channel away/back", async () => {
  const harness = createHarness();
  const row = harness.addRow();
  harness.setSendOverride((command, normal) => command.type === T.CONFIRM_DELETED
    ? { ok: false, reason: "broker-error" } : normal());
  await harness.context.confirmRetainedDeletion(CHANNEL_ID, [MESSAGE_ID]);
  await harness.drain();
  await harness.tick(16);
  assert.equal(harness.state.pendingDeletions.size, 1);
  assert.equal(row.dataset.ldmaSavePending, "true", "temporary native retention is explicitly labeled unsaved");
  harness.navigate(OTHER_CHANNEL_ID);
  harness.navigate(CHANNEL_ID);
  await harness.settle();
  assert.equal(harness.state.pendingDeletions.size, 1);
  harness.setSendOverride(null);
  await harness.tick(600);
  assert.equal(harness.archive.records.find((item) => item.messageId === MESSAGE_ID)?.status, "confirmed_deleted");
  assert.equal(harness.state.pendingDeletions.size, 0);
  assert.equal(row.dataset.ldmaSavePending, undefined);
});

test("successful broker responses do not acknowledge missing or unconfirmed archive records", async () => {
  const harness = createHarness();
  harness.addRow();
  harness.setSendOverride((command, normal) => command.type === T.CONFIRM_DELETED
    ? { ok: true, reason: "accepted-without-record", archive: harness.archive } : normal());
  await harness.context.confirmRetainedDeletion(CHANNEL_ID, [MESSAGE_ID]);
  await harness.drain();
  assert.equal(harness.state.pendingDeletions.size, 1);
  assert.equal(harness.posts.filter((message) => message.kind === "deletion-ack").length, 0);
  assert.equal(harness.archive.records.length, 0);

  harness.setSendOverride(null);
  await harness.tick(600);
  const acknowledgments = harness.posts.filter((message) => message.kind === "deletion-ack");
  assert.equal(acknowledgments.length, 1);
  assert.equal(acknowledgments[0].channelId, CHANNEL_ID);
  assert.deepEqual([...acknowledgments[0].ids], [MESSAGE_ID]);
  assert.equal(harness.archive.records[0].status, "confirmed_deleted");
});

for (const boundary of [
  { name: "pause", command: { type: T.SET_PAUSED, paused: true } },
  { name: "clear", command: { type: T.CLEAR_ARCHIVE } },
  { name: "record deletion", command: { type: T.DELETE_RECORD, key: `${CHANNEL_ID}:${MESSAGE_ID}` } }
]) {
  test(`${boundary.name} invalidates pending deletion retries without adopting the new generation`, async () => {
    const harness = createHarness();
    harness.addRow();
    harness.setSendOverride((command, normal) => command.type === T.CONFIRM_DELETED
      ? { ok: false, reason: "broker-error" } : normal());
    await harness.context.confirmRetainedDeletion(CHANNEL_ID, [MESSAGE_ID]);
    assert.equal(harness.state.pendingDeletions.size, 1);
    const confirmationsBeforeReset = harness.requests.filter((command) => command.type === T.CONFIRM_DELETED).length;
    harness.userCommand(boundary.command);
    assert.equal(harness.state.pendingDeletions.size, 0);
    assert.equal(harness.state.generation, 1);
    harness.setSendOverride(null);
    await harness.tick(2000);
    assert.equal(harness.requests.filter((command) => command.type === T.CONFIRM_DELETED).length, confirmationsBeforeReset);
    assert.equal(harness.archive.records.length, 0);
    assert.equal(harness.posts.filter((message) => message.kind === "deletion-ack").length, 0);
  });

  test(`a stale-generation response after ${boundary.name} cancels rather than retags deletion work`, async () => {
    const harness = createHarness();
    harness.addRow();
    harness.setSendOverride((command, normal) => {
      if (command.type !== T.CONFIRM_DELETED) return normal();
      harness.userCommand(boundary.command, false);
      return { ok: false, reason: "stale-generation", archive: harness.archive };
    });
    await harness.context.confirmRetainedDeletion(CHANNEL_ID, [MESSAGE_ID]);
    assert.equal(harness.state.generation, 1);
    assert.equal(harness.state.pendingDeletions.size, 0);
    harness.setSendOverride(null);
    await harness.tick(2000);
    const confirmations = harness.requests.filter((command) => command.type === T.CONFIRM_DELETED);
    assert.equal(confirmations.length, 1);
    assert.equal(confirmations[0].generation, 0);
    assert.equal(harness.state.archive.records.length, 0);
    assert.equal(harness.posts.filter((message) => message.kind === "deletion-ack").length, 0);
  });
}

test("a late successful deletion response cannot ACK or restore a record after clear", async () => {
  const harness = createHarness();
  harness.addRow();
  const reply = deferred();
  let oldResponse;
  harness.setSendOverride((command, normal) => {
    if (command.type !== T.CONFIRM_DELETED) return normal();
    oldResponse = normal();
    return reply.promise;
  });
  const deletion = harness.context.confirmRetainedDeletion(CHANNEL_ID, [MESSAGE_ID]);
  await harness.settle();
  assert.equal(oldResponse?.archive.records[0]?.status, "confirmed_deleted");
  harness.userCommand({ type: T.CLEAR_ARCHIVE });
  reply.resolve(oldResponse);
  await deletion;
  await harness.tick(1000);
  assert.equal(harness.archive.records.length, 0);
  assert.equal(harness.state.archive.records.length, 0);
  assert.equal(harness.state.pendingDeletions.size, 0);
  assert.equal(harness.posts.filter((message) => message.kind === "deletion-ack").length, 0);
});

test("the installed bridge accepts only the latest same-window reset acknowledgment", async () => {
  const harness = createHarness();
  harness.addRow();
  harness.userCommand({ type: T.CLEAR_ARCHIVE });
  const firstReset = harness.posts.filter((message) => message.kind === "reset-deletions").at(-1);
  harness.userCommand({ type: T.CLEAR_ARCHIVE });
  const secondReset = harness.posts.filter((message) => message.kind === "reset-deletions").at(-1);
  assert.notEqual(firstReset.resetToken, secondReset.resetToken);

  await harness.dispatchBridge({ kind: "retained", channelId: CHANNEL_ID, ids: [MESSAGE_ID] });
  assert.equal(harness.state.pendingDeletions.size, 0, "pre-reset lifecycle replay must not cross a generation boundary");
  await harness.dispatchBridge({ kind: "deletions-reset", resetToken: firstReset.resetToken });
  await harness.dispatchBridge({ kind: "deletions-reset" });
  await harness.dispatchBridge({ kind: "deletions-reset", resetToken: secondReset.resetToken }, {});
  assert.equal(harness.state.deletionResetPending, true);
  assert.equal(harness.posts.filter((message) => message.kind === "isolated-ready").length, 0);

  await harness.dispatchBridge({ kind: "deletions-reset", resetToken: secondReset.resetToken });
  assert.equal(harness.state.deletionResetPending, false);
  assert.equal(harness.posts.filter((message) => message.kind === "isolated-ready").length, 1);
  assert.equal(harness.posts.filter((message) => message.kind === "sync-deletions").length, 1);
});

test("clear suppresses ordinary capture both during reset and while a discarded native row lingers", async () => {
  const harness = createHarness();
  const row = harness.addRow();
  harness.setSendOverride((command, normal) => command.type === T.CONFIRM_DELETED
    ? { ok: false, reason: "broker-error" } : normal());
  await harness.dispatchBridge({ kind: "retained", channelId: CHANNEL_ID, ids: [MESSAGE_ID] });
  assert.equal(harness.state.pendingDeletions.size, 1);
  harness.userCommand({ type: T.CLEAR_ARCHIVE });
  harness.setSendOverride(null);
  assert.equal(harness.state.deletionResetPending, true);
  harness.context.snapshotRenderedMessages(true);
  harness.context.captureScrollMessageNode(row, harness.state.route, true);
  harness.context.queueRecord(harness.record());
  await harness.context.flushAllRecords();
  assert.equal(harness.archive.records.length, 0, "scheduled ordinary captures cannot repopulate a reset archive");

  const reset = harness.posts.filter((message) => message.kind === "reset-deletions").at(-1);
  await harness.dispatchBridge({ kind: "deletions-reset", resetToken: reset.resetToken });
  assert.equal(harness.state.deletionResetPending, false);
  assert.equal(row.isConnected, true, "Discord has not reconciled the released native DOM row yet");
  harness.context.snapshotRenderedMessages(true);
  harness.context.captureScrollMessageNode(row, harness.state.route, true);
  harness.context.queueRecord(harness.record());
  await harness.context.flushAllRecords();
  assert.equal(harness.archive.records.length, 0, "discarded deletion IDs remain uncapturable after reset acknowledgment");

  const freshId = "888888888888888882";
  harness.addRow({ messageId: freshId, content: "unrelated fresh message" });
  harness.context.snapshotRenderedMessages(true);
  await harness.context.flushAllRecords();
  assert.deepEqual(harness.archive.records.map((item) => item.messageId), [freshId]);
});

test("reset acknowledgments suppress hook-only discarded IDs before capture resumes", async () => {
  const harness = createHarness();
  harness.addRow();
  assert.equal(harness.state.pendingRetainedKeys.size, 0, "the isolated script never received this retained event");
  harness.userCommand({ type: T.CLEAR_ARCHIVE });
  const reset = harness.posts.filter((message) => message.kind === "reset-deletions").at(-1);
  assert.equal(harness.state.discardedDeletionKeys.has(`${CHANNEL_ID}:${MESSAGE_ID}`), false);
  await harness.dispatchBridge({
    kind: "deletions-reset", resetToken: reset.resetToken,
    discarded: [{ channelId: CHANNEL_ID, ids: [MESSAGE_ID] }]
  });
  assert.equal(harness.state.deletionResetPending, false);
  assert.equal(harness.state.discardedDeletionKeys.has(`${CHANNEL_ID}:${MESSAGE_ID}`), true);
  harness.context.snapshotRenderedMessages(true);
  await harness.context.flushAllRecords();
  await harness.dispatchBridge({ kind: "retained", channelId: CHANNEL_ID, ids: [MESSAGE_ID] });
  assert.equal(harness.archive.records.length, 0);
  assert.equal(harness.state.pendingDeletions.size, 0);
  assert.equal(harness.posts.some((message) => message.kind === "release" && message.ids.includes(MESSAGE_ID)), true);
});

test("suppression overflow fails closed without forgetting an older lingering native row", async () => {
  const harness = createHarness();
  harness.addRow();
  const oldestKey = `${CHANNEL_ID}:${MESSAGE_ID}`;
  harness.context.discardDeletionKey(oldestKey);
  harness.context.queueRecord(harness.record({ messageId: "999999999999999999", content: "queued before overflow" }));
  assert.equal(harness.state.pendingRecords.size, 1);
  const ids = Array.from({ length: 5000 }, (_, index) => `8${String(index).padStart(17, "0")}`);
  for (const id of ids) harness.context.discardDeletionKey(`${CHANNEL_ID}:${id}`);
  assert.equal(harness.state.captureSafetySuspended, true);
  assert.equal(harness.state.discardedDeletionKeys.size, 5000);
  assert.equal(harness.state.discardedDeletionKeys.has(oldestKey), true);
  assert.equal(harness.state.pendingRecords.size, 0);
  harness.context.snapshotRenderedMessages(true);
  harness.context.queueRecord(harness.record());
  harness.context.queueRecord(harness.record({ messageId: ids.at(-1) }));
  await harness.context.flushAllRecords();
  assert.equal(harness.state.pendingRecords.size, 0);
  assert.equal(harness.archive.records.length, 0);
  assert.equal(harness.requests.filter((command) => command.type === T.UPSERT_RECORDS).length, 0);
});

test("pending detached scroll rows retain their original channel during navigation", async () => {
  const harness = createHarness();
  const row = harness.addRow();
  harness.context.collectScrollCaptureRows([
    { target: row.parentElement, addedNodes: [row], removedNodes: [] }
  ], harness.state.route);
  assert.equal(harness.state.pendingScrollRows.size, 1);
  row.isConnected = false;
  harness.navigate(OTHER_CHANNEL_ID);
  await harness.settle();
  harness.context.capturePendingScrollRows(true);
  await harness.context.flushAllRecords();
  const archived = harness.archive.records.find((item) => item.messageId === MESSAGE_ID);
  assert.equal(archived?.content, "original native payload");
  assert.equal(archived?.channelId, CHANNEL_ID);
  assert.equal(archived?.guildId, GUILD_ID);
  assert.equal(harness.state.pendingScrollRows.size, 0);
});

test("retrying an older failed capture cannot replace a newer queued payload", async () => {
  const harness = createHarness();
  const reply = deferred();
  harness.setSendOverride((command, normal) => command.type === T.UPSERT_RECORDS ? reply.promise : normal());
  harness.context.queueRecord(harness.record({ content: "older payload", captureSequence: 1 }));
  const firstFlush = harness.context.flushRecords();
  await harness.settle();
  harness.context.queueRecord(harness.record({ content: "newer payload", captureSequence: 2 }));
  reply.resolve({ ok: false, reason: "broker-error" });
  await firstFlush;
  const pending = harness.state.pendingRecords.get(`${CHANNEL_ID}:${MESSAGE_ID}`);
  assert.equal(pending?.record.content, "newer payload");
  harness.setSendOverride(null);
  await harness.context.flushAllRecords();
  assert.equal(harness.archive.records[0]?.content, "newer payload");
});

test("deletion retries preserve the newer pinned payload after its DOM snapshot is evicted", async () => {
  const harness = createHarness();
  const older = harness.record({ content: "older archived payload", captureSequence: 1 });
  const newer = harness.record({ content: "newer pinned payload", captureSequence: 2 });
  harness.setArchive({ ...Protocol.emptyArchive(), revision: 1, records: [older] });
  harness.seedSnapshot(newer);
  harness.setSendOverride((command, normal) => command.type === T.CONFIRM_DELETED
    ? { ok: false, reason: "broker-error" } : normal());
  await harness.context.confirmRetainedDeletion(CHANNEL_ID, [MESSAGE_ID]);
  harness.state.snapshotsByKey.clear();
  await harness.tick(600);
  const confirmations = harness.requests.filter((command) => command.type === T.CONFIRM_DELETED);
  assert.equal(confirmations.at(-1)?.deletions[0]?.record.content, "newer pinned payload");
  assert.equal(harness.state.pendingDeletions.get(`${CHANNEL_ID}:${MESSAGE_ID}`)?.record.content, "newer pinned payload");

  harness.setSendOverride(null);
  await harness.tick(1100);
  assert.equal(harness.archive.records[0]?.status, "confirmed_deleted");
  assert.equal(harness.archive.records[0]?.content, "newer pinned payload");
});

test("a 5000-ID replay coalesces styling and drains only one bounded native capture batch", async () => {
  const harness = createHarness();
  const ids = Array.from({ length: 5000 }, (_, index) => `8${String(index).padStart(17, "0")}`);
  for (const messageId of ids.slice(0, 12)) harness.addRow({ messageId });
  harness.setSendOverride((command, normal) => command.type === T.CONFIRM_DELETED
    ? { ok: false, reason: "broker-error" } : normal());
  harness.resetMetrics();
  let styleFrame;
  for (let offset = 0; offset < ids.length; offset += 200) {
    harness.context.queueLifecycleDeletions(CHANNEL_ID, ids.slice(offset, offset + 200), "message_store_preserved");
    if (offset === 0) styleFrame = harness.state.pendingRetainedStyleFrame;
    assert.equal(harness.state.pendingRetainedStyleFrame, styleFrame);
  }
  assert.equal(harness.state.pendingDeletions.size, 5000);
  assert.equal(harness.retainedLookups, 0);
  assert.equal(harness.domQueries.length, 0, "queue replay uses snapshots and maps, not per-ID document searches");
  assert.equal(harness.extractionRoutes.length, 0);
  assert.equal(harness.scheduledFrames.length, 1);

  await harness.drain();
  assert.equal(harness.retainedLookups, 0);
  assert.equal(harness.domQueries.length, 1, "one drain indexes native rows once");
  assert.equal(harness.extractionRoutes.length, 4);
  assert.equal(harness.requests.filter((command) => command.type === T.CONFIRM_DELETED).at(-1)?.deletions.length, 4);
  assert.equal(harness.state.pendingRetainedStyleFrame, styleFrame, "drain joins the same pending style frame");
});

function pendingEditFixture(harness, messageId = MESSAGE_ID) {
  const baseline = harness.record({ messageId, content: "before edit" });
  const pendingId = `${CHANNEL_ID}:${messageId}|edit-test-session:1`;
  const pending = {
    baseline,
    baselineSignature: Core.editPayloadSignature(baseline),
    recordKey: Core.recordKey(baseline), channelId: CHANNEL_ID, messageId,
    generation: harness.state.generation, editedAt: baseline.capturedAt + 1,
    editSessionId: "edit-test-session", editSequence: 1,
    sending: false, attempts: 0, expiresAt: 10000
  };
  harness.state.pendingEdits.set(pendingId, pending);
  return { pendingId, pending };
}

function removalCandidateFixture(harness) {
  const previous = harness.addRow({ messageId: "888888888888888880" });
  const next = harness.addRow({ messageId: "888888888888888882" });
  const record = harness.record();
  harness.seedSnapshot(record);
  const snapshot = {
    ...harness.state.snapshotsByKey.get(Core.recordKey(record)),
    previousId: previous.messageId, nextId: next.messageId,
    previousTop: previous.getBoundingClientRect().top,
    innerViewport: true, tailCandidate: false
  };
  return {
    snapshot, routeKeyAtMutation: harness.state.route.routeKey,
    generationAtMutation: harness.state.generation,
    rootReplacement: false, removedMessageCount: 1, totalRemovedElementCount: 5, addedMessageCount: 0
  };
}

for (const guard of [
  { name: "safety suspension", apply(harness) { harness.state.captureSafetySuspended = true; } },
  { name: "reset barrier", apply(harness) { harness.state.deletionResetPending = true; } },
  { name: "discarded message key", apply(harness) { harness.state.discardedDeletionKeys.add(`${CHANNEL_ID}:${MESSAGE_ID}`); } }
]) {
  test(`${guard.name} blocks direct and scheduled edit/inference work`, async () => {
    const harness = createHarness();
    const candidate = removalCandidateFixture(harness);
    const { pendingId, pending } = pendingEditFixture(harness);
    harness.setSendOverride((command, normal) => command.type === T.CONFIRM_EDIT
      ? { ok: false, reason: "broker-error" } : normal());
    harness.context.commitPendingEdit(pendingId, pending);
    await harness.settle();
    assert.equal(harness.requests.filter((command) => command.type === T.CONFIRM_EDIT).length, 1);
    assert.equal(pending.attempts, 1, "a genuine broker-error retry is already scheduled");
    harness.context.evaluateCandidate(candidate);
    guard.apply(harness);
    harness.context.commitPendingEdit(pendingId, pending);
    await harness.tick(Core.DEFAULTS.reappearanceGraceMs + 20);
    assert.equal(harness.requests.filter((command) => command.type === T.CONFIRM_EDIT).length, 1);
    assert.equal(harness.requests.filter((command) => command.type === T.INFER_DELETED).length, 0);
    assert.equal(harness.archive.records.length, 0);

    harness.context.verifyPendingEdit(pendingId, pending, harness.record({ content: "after edit" }));
    assert.equal(harness.state.pendingEdits.has(pendingId), false);
    assert.equal(harness.context.editLifecycleIdentity({
      channelId: CHANNEL_ID, ids: [MESSAGE_ID], editSessionId: "edit-test-session", editSequence: 1
    }), null);
  });
}

test("a legitimate pending edit still commits after an unrelated deletion key is discarded", async () => {
  const harness = createHarness();
  harness.context.discardDeletionKey(`${CHANNEL_ID}:888888888888888899`);
  const { pendingId, pending } = pendingEditFixture(harness);
  harness.addRow({ content: "after edit" });
  harness.context.verifyPendingEdit(pendingId, pending, harness.record({ content: "after edit" }));
  await harness.settle();
  assert.equal(harness.requests.filter((command) => command.type === T.CONFIRM_EDIT).length, 1);
  assert.equal(harness.archive.records[0]?.editHistory?.[0]?.content, "before edit");
  assert.equal(harness.state.pendingEdits.has(pendingId), false);
});

test("a legitimate stationary DOM-removal candidate still reaches the inference broker", async () => {
  const harness = createHarness();
  harness.context.discardDeletionKey(`${CHANNEL_ID}:888888888888888899`);
  harness.context.evaluateCandidate(removalCandidateFixture(harness));
  await harness.tick(Core.DEFAULTS.reappearanceGraceMs + 20);
  assert.equal(harness.requests.filter((command) => command.type === T.INFER_DELETED).length, 1);
  assert.equal(harness.archive.records.find((record) => record.messageId === MESSAGE_ID)?.status, "inferred_deleted");
});

test("discarding a deletion key purges matching edit work and overflow clears the remaining edit queues", () => {
  const harness = createHarness();
  const matching = pendingEditFixture(harness);
  const unrelated = pendingEditFixture(harness, "999999999999999999");
  harness.state.stagedSelfEdits.set(matching.pendingId, { baseline: matching.pending.baseline });
  harness.state.stagedSelfEdits.set(unrelated.pendingId, { baseline: unrelated.pending.baseline });
  harness.context.discardDeletionKey(matching.pending.recordKey);
  assert.equal(harness.state.pendingEdits.has(matching.pendingId), false);
  assert.equal(harness.state.stagedSelfEdits.has(matching.pendingId), false);
  assert.equal(harness.state.pendingEdits.has(unrelated.pendingId), true);
  assert.equal(harness.state.stagedSelfEdits.has(unrelated.pendingId), true);
  for (let index = 0; index < 5000; index += 1) {
    harness.context.discardDeletionKey(`${CHANNEL_ID}:8${String(index).padStart(17, "0")}`);
  }
  assert.equal(harness.state.captureSafetySuspended, true);
  assert.equal(harness.state.pendingEdits.size, 0);
  assert.equal(harness.state.stagedSelfEdits.size, 0);
});
