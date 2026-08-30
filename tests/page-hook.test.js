"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function runHook(options) {
  const settings = options || {};
  const listeners = new Map();
  const dispatched = [];
  const posted = [];
  const subscriptions = new Map();
  const intervals = [];
  const messages = new Map();
  const users = new Map();
  const userActionCalls = { profile: [], until: [] };
  const makeMessage = (id, deleted, content, editedTimestamp) => {
    const authorId = "999999999999999991";
    const author = settings.messageAuthorAsId
      ? authorId
      : settings.messageAuthorUnboundUsername
        ? { username: "must_not_bind" }
        : Object.assign({ id: authorId }, settings.messageAuthorWithoutUsername ? {} : { username: "curiousbro" });
    const message = {
      id,
      channel_id: "777777777777777777",
      content: content || "retained content",
      editedTimestamp: editedTimestamp || null,
      author,
      deleted: Boolean(deleted),
      set(key, value) {
        const next = makeMessage(this.id, key === "deleted" ? value : this.deleted, this.content, this.editedTimestamp);
        next.author = this.author;
        return next;
      }
    };
    if (settings.messageAuthorUnboundUsername) message.authorId = authorId;
    return message;
  };
  messages.set("888888888888888881", makeMessage("888888888888888881", false));
  users.set("999999999999999991", { id: "999999999999999991", username: "curiousbro" });
  const handlerNode = {
    name: "MessageStore",
    actionHandler: {
      MESSAGE_DELETE(action) { messages.delete(action.id); },
      MESSAGE_DELETE_BULK(action) { for (const id of action.ids) messages.delete(id); },
      MESSAGE_UPDATE(action) {
        const incoming = action.message || action;
        const previous = messages.get(incoming.id);
        if (previous) messages.set(incoming.id, makeMessage(incoming.id, previous.deleted,
          incoming.content || previous.content, incoming.editedTimestamp || incoming.edited_timestamp));
      }
    }
  };
  if (settings.missingUpdateHandler) delete handlerNode.actionHandler.MESSAGE_UPDATE;
  const dispatcher = {
    _actionHandlers: { _dependencyGraph: { nodes: settings.hideHandlerNode ? {} : { message_store_token: handlerNode } } },
    dispatch(action) {
      const handler = handlerNode.actionHandler[action && action.type];
      if (typeof handler === "function") handler(action);
    },
    subscribe(type, callback) { subscriptions.set(type, callback); },
    unsubscribe(type) { subscriptions.delete(type); }
  };
  if (settings.lockDispatcher) Object.defineProperty(dispatcher, "dispatch", {
    value: dispatcher.dispatch,
    writable: false,
    configurable: false
  });
  let fallbackSubscriptions = 0;
  const fallbackDispatcher = {
    dispatch() {},
    subscribe() { fallbackSubscriptions += 1; },
    unsubscribe() {}
  };
  const messageStore = {
    _dispatcher: dispatcher,
    getName() { return "MessageStore"; },
    getDispatchToken() { return "message_store_token"; },
    getMessage(_channelId, id) { return messages.get(id); },
    getMessages() { return { receiveMessage(message) { messages.set(message.id, message); return this; } }; }
  };
  const userStore = {
    _dispatcher: dispatcher,
    getName() { return "UserStore"; },
    getDispatchToken() { return "user_store_token"; },
    getUser(id) { return users.get(id); },
    getUsers() { return Object.fromEntries(users); },
    getCurrentUser() { return users.get("999999999999999991"); }
  };
  const structuralUserStore = {};
  Object.defineProperties(structuralUserStore, {
    getUser: { enumerable: true, get() { return (id) => users.get(id); } },
    getUsers: { enumerable: true, get() { return () => Object.fromEntries(users); } },
    getCurrentUser: { enumerable: true, get() { return () => users.get("999999999999999991"); } }
  });
  const conflictingStructuralUserStore = {
    getUser(id) { return id === "999999999999999991" ? { id, username: "conflicting_name" } : null; },
    getUsers() { return {}; },
    getCurrentUser() { return null; }
  };
  const rejectingDispatcher = {
    dispatch() {},
    subscribe(type) { if (type === "MESSAGE_DELETE_BULK") throw new Error("not this dispatcher"); },
    unsubscribe() {}
  };
  const rejectingStore = { _dispatcher: rejectingDispatcher, getName() { return "MessageStore"; } };
  const webpackRequire = function webpackRequire() {};
  const moduleExports = {};
  let actionGeneration = 1;
  const makeUserActionModules = () => ({
    profile: {
      openUserProfileModal(payload) {
        userActionCalls.profile.push({ generation: actionGeneration, payload });
        if (settings.rejectProfileAction) return Promise.reject(new Error("profile rejected"));
      },
      closeUserProfileModal() {}
    },
    until: {
      setCommunicationDisabledUntil(payload) {
        userActionCalls.until.push({ generation: actionGeneration, payload });
        if (settings.rejectTimeoutAction) return Promise.reject(new Error("timeout rejected"));
      },
      kickUser() {},
      banUser() {}
    }
  });
  let userActionModules = settings.noUserActionModules ? null : makeUserActionModules();
  const userActionExports = {};
  Object.defineProperties(userActionExports, {
    openUserProfileModal: {
      enumerable: true,
      get() { return userActionModules?.profile.openUserProfileModal; }
    },
    closeUserProfileModal: {
      enumerable: true,
      get() { return userActionModules?.profile.closeUserProfileModal; }
    },
    until: { enumerable: true, get() { return userActionModules?.until || {}; } }
  });
  let storeAvailable = !settings.delayedStore;
  Object.defineProperty(moduleExports, "Z", { enumerable: true, get() { return storeAvailable ? messageStore : {}; } });
  webpackRequire.c = {
    "0": { exports: { rejectingStore } },
    "1": { exports: { fallbackDispatcher } },
    "21": { exports: userActionExports },
    "42": { exports: moduleExports },
    "43": { exports: settings.noUserStore ? {} : { Z: settings.structuralUserStoreOnly ? structuralUserStore : userStore } },
    "44": { exports: settings.conflictingStructuralUserStores ? { Z: conflictingStructuralUserStore } : {} }
  };
  const chunks = [];
  chunks.push = function push(chunk) {
    if (typeof chunk[2] === "function") chunk[2](webpackRequire);
    return Array.prototype.push.call(this, chunk);
  };
  const window = {
    location: { reload() { settings.reloads = (settings.reloads || 0) + 1; } },
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
    dispatchEvent(event) {
      dispatched.push(event);
      for (const callback of listeners.get(event.type) || []) callback(event);
      return true;
    },
    postMessage(data) {
      posted.push(data);
      const event = { source: window, data };
      for (const callback of listeners.get("message") || []) callback(event);
    }
  };
  if (settings.legacyController) {
    window[Symbol.for("BridgeModTools.pageHook.v1")] = {
      recover() { settings.legacyRecoveries = (settings.legacyRecoveries || 0) + 1; }
    };
  }
  class CustomEvent {
    constructor(type, options) { this.type = type; this.detail = options?.detail; }
  }
  const context = vm.createContext({
    window, CustomEvent,
    setInterval(callback) { intervals.push(callback); return intervals.length; },
    Date, Math, Object, Array, Set, Map, WeakMap, WeakSet, String, Boolean, Symbol
  });
  if (settings.readyBeforeHook) {
    window.addEventListener("message", (event) => {
      if (event.data?.bridge === "LDMA_BRIDGE_V1" && event.data.kind === "ready-request") {
        window.postMessage({ bridge: "LDMA_BRIDGE_V1", kind: "isolated-ready" }, "*");
      }
    });
    window.postMessage({ bridge: "LDMA_BRIDGE_V1", kind: "isolated-ready" }, "*");
  }
  const source = fs.readFileSync(path.resolve(__dirname, "../src/page-hook.js"), "utf8");
  vm.runInContext(source, context);
  window.webpackChunkdiscord_app = chunks;
  const ready = () => window.postMessage({ bridge: "LDMA_BRIDGE_V1", kind: "isolated-ready" }, "*");
  if (!settings.deferReady && !settings.readyBeforeHook) ready();
  return {
    posted, dispatched, subscriptions, fallbackSubscriptions, handlerNode, messages, users, dispatcher, window, ready, messageStore,
    reloads: () => settings.reloads || 0,
    legacyRecoveries: () => settings.legacyRecoveries || 0,
    userActionCalls,
    profileExportUsesGetter: typeof Object.getOwnPropertyDescriptor(userActionExports, "openUserProfileModal").get === "function",
    invokeUserAction(action, payload) {
      return window[Symbol.for("BridgeModTools.pageHook.v1")].invokeUserAction(action, payload);
    },
    resolveMessageAuthors(channelId, ids, fallbacks) {
      return window[Symbol.for("BridgeModTools.pageHook.v1")].resolveMessageAuthors(channelId, ids, fallbacks);
    },
    replaceUserActionModules() {
      actionGeneration += 1;
      userActionModules = makeUserActionModules();
      return actionGeneration;
    },
    removeUserActionModules() { userActionModules = null; },
    reinject() { vm.runInContext(source, context); },
    makeStoreAvailable() { storeAvailable = true; },
    replaceStoreDispatcher() {
      const replacementSubscriptions = new Map();
      const replacementNode = {
        name: "MessageStore",
        actionHandler: {
          MESSAGE_DELETE(action) { messages.delete(action.id); },
          MESSAGE_DELETE_BULK(action) { for (const id of action.ids) messages.delete(id); },
          MESSAGE_UPDATE(action) {
            const incoming = action.message || action;
            const previous = messages.get(incoming.id);
            if (previous) messages.set(incoming.id, makeMessage(incoming.id, previous.deleted,
              incoming.content || previous.content, incoming.editedTimestamp || incoming.edited_timestamp));
          }
        }
      };
      const replacementDispatcher = {
        _actionHandlers: { _dependencyGraph: { nodes: { message_store_token: replacementNode } } },
        dispatch(action) {
          const handler = replacementNode.actionHandler[action && action.type];
          if (typeof handler === "function") handler(action);
        },
        subscribe(type, callback) { replacementSubscriptions.set(type, callback); },
        unsubscribe(type) { replacementSubscriptions.delete(type); }
      };
      messageStore._dispatcher = replacementDispatcher;
      return { dispatcher: replacementDispatcher, handlerNode: replacementNode, subscriptions: replacementSubscriptions };
    },
    tick(count) {
      for (let index = 0; index < (count || 1); index += 1) for (const callback of [...intervals]) callback();
    },
    intervalCount() { return intervals.length; },
    listenerCount(type) { return (listeners.get(type) || []).length; }
  };
}

test("duplicate page-hook injection recovers in place without duplicate listeners, timers, wrappers, or events", () => {
  const result = runHook();
  const originalDeleteWrapper = result.handlerNode.actionHandler.MESSAGE_DELETE;
  assert.equal(result.window[Symbol.for("BridgeModTools.pageHook.v1")].apiVersion, 4);
  assert.equal(result.intervalCount(), 1);
  assert.equal(result.listenerCount("message"), 1);

  result.reinject();
  assert.equal(result.intervalCount(), 1);
  assert.equal(result.listenerCount("message"), 1);
  assert.equal(result.handlerNode.actionHandler.MESSAGE_DELETE, originalDeleteWrapper);
  assert.equal(result.reloads(), 0);

  result.handlerNode.actionHandler.MESSAGE_DELETE({
    channelId: "777777777777777777",
    id: "888888888888888881"
  });
  assert.equal(result.posted.filter((message) => message.kind === "retained").length, 1);
});

test("cold recovery revisits a previously seen mutable export and activates MessageStore", () => {
  const result = runHook({ delayedStore: true });
  assert.equal(result.posted.some((message) => message.kind === "status" && message.status === "active"), false);
  result.makeStoreAvailable();
  result.tick(4);
  assert.equal(result.posted.some((message) => message.kind === "status" && message.status === "active"), true);
  result.handlerNode.actionHandler.MESSAGE_DELETE({
    channelId: "777777777777777777",
    id: "888888888888888881"
  });
  assert.equal(result.messages.get("888888888888888881").deleted, true);
});

test("reinjection repairs a Discord handler that was replaced after activation", () => {
  const result = runHook();
  result.handlerNode.actionHandler.MESSAGE_DELETE = function replacement(action) { result.messages.delete(action.id); };
  result.reinject();
  result.handlerNode.actionHandler.MESSAGE_DELETE({
    channelId: "777777777777777777",
    id: "888888888888888881"
  });
  assert.equal(result.messages.get("888888888888888881").deleted, true);
  assert.equal(result.posted.filter((message) => message.kind === "retained").length, 1);
});

test("edit lifecycle emitted before isolated readiness is buffered and delivered once", () => {
  const result = runHook({ deferReady: true });
  result.handlerNode.actionHandler.MESSAGE_UPDATE({
    message: {
      channel_id: "777777777777777777",
      id: "888888888888888881",
      content: "early edit",
      edited_timestamp: "2026-08-27T10:11:12.000Z"
    }
  });
  assert.equal(result.dispatched.filter((event) => event.type === "LDMA_EDIT_BEFORE_V1").length, 0);
  result.ready();
  assert.equal(result.posted.filter((message) => message.kind === "edit-before").length, 1);
});

test("a late page hook requests a fresh ready handshake and flushes lifecycle events", () => {
  const result = runHook({ readyBeforeHook: true });
  assert.equal(result.posted.filter((message) => message.kind === "ready-request").length, 1);
  result.handlerNode.actionHandler.MESSAGE_DELETE({
    channelId: "777777777777777777",
    id: "888888888888888881"
  });
  assert.equal(result.posted.filter((message) => message.kind === "retained").length, 1);
});

test("MessageStore dispatcher replacement migrates subscriptions and repairs retention before reporting active", () => {
  const result = runHook();
  const replacement = result.replaceStoreDispatcher();
  result.tick(1);
  assert.equal(result.subscriptions.size, 0);
  assert.equal(typeof replacement.subscriptions.get("MESSAGE_DELETE"), "function");
  assert.equal(typeof replacement.subscriptions.get("MESSAGE_DELETE_BULK"), "function");
  replacement.handlerNode.actionHandler.MESSAGE_DELETE({
    channelId: "777777777777777777",
    id: "888888888888888881"
  });
  assert.equal(result.messages.get("888888888888888881").deleted, true);
  assert.equal(result.posted.filter((message) => message.kind === "retained").length, 1);
  const statuses = result.posted.filter((message) => message.kind === "status");
  assert.equal(statuses.at(-1).status, "active");
});

test("main-world hook discovers Flux structurally and emits only normalized deletion IDs", () => {
  const { posted, subscriptions, fallbackSubscriptions } = runHook();
  assert.equal(fallbackSubscriptions, 0);
  assert.equal(typeof subscriptions.get("MESSAGE_DELETE"), "function");
  assert.equal(typeof subscriptions.get("MESSAGE_DELETE_BULK"), "function");
  subscriptions.get("MESSAGE_DELETE")({ channelId: "777777777777777777", id: "888888888888888881", content: "must not cross" });
  subscriptions.get("MESSAGE_DELETE_BULK")({ channel_id: "777777777777777777", ids: ["888888888888888882", "invalid"] });
  const deletes = posted.filter((message) => message.kind === "delete");
  assert.deepEqual(JSON.parse(JSON.stringify(deletes)), [
    { bridge: "LDMA_BRIDGE_V1", kind: "delete", channelId: "777777777777777777", ids: ["888888888888888881"], bulk: false },
    { bridge: "LDMA_BRIDGE_V1", kind: "delete", channelId: "777777777777777777", ids: ["888888888888888882"], bulk: true }
  ]);
  assert.equal(JSON.stringify(deletes).includes("must not cross"), false);
  assert.equal(posted.some((message) => message.kind === "status" && message.status === "active"), true);
});

test("MessageStore delete handlers retain the current user's native cached message and emit an ID-only event", () => {
  const { posted, handlerNode, messages } = runHook();
  handlerNode.actionHandler.MESSAGE_DELETE({
    channelId: "777777777777777777",
    id: "888888888888888881",
    content: "must not cross"
  });
  assert.equal(messages.get("888888888888888881").deleted, true);
  assert.equal(messages.get("888888888888888881").author.id, "999999999999999991");
  const retained = posted.filter((message) => message.kind === "retained");
  assert.deepEqual(JSON.parse(JSON.stringify(retained)), [{
    bridge: "LDMA_BRIDGE_V1",
    kind: "retained",
    channelId: "777777777777777777",
    ids: ["888888888888888881"],
    bulk: false
  }]);
  assert.equal(JSON.stringify(retained).includes("must not cross"), false);
});

test("MessageStore bulk deletes retain every cached native message", () => {
  const { posted, handlerNode, messages } = runHook();
  const original = messages.get("888888888888888881");
  messages.set("888888888888888882", Object.assign({}, original, { id: "888888888888888882" }));
  handlerNode.actionHandler.MESSAGE_DELETE_BULK({
    channel_id: "777777777777777777",
    ids: ["888888888888888881", "888888888888888882", "invalid"],
    content: "must not cross"
  });
  assert.equal(messages.get("888888888888888881").deleted, true);
  assert.equal(messages.get("888888888888888882").deleted, true);
  const retained = posted.filter((message) => message.kind === "retained");
  assert.deepEqual(JSON.parse(JSON.stringify(retained)), [{
    bridge: "LDMA_BRIDGE_V1",
    kind: "retained",
    channelId: "777777777777777777",
    ids: ["888888888888888881", "888888888888888882"],
    bulk: true
  }]);
  assert.equal(JSON.stringify(retained).includes("must not cross"), false);
});

test("unacknowledged off-route retention replays on channel sync without crossing message content", () => {
  const result = runHook();
  const channelId = "777777777777777777";
  const otherChannelId = "777777777777777778";
  const id = "888888888888888881";
  let activeChannelId = otherChannelId;
  const captured = [];
  result.window.addEventListener("message", (event) => {
    if (event.data.kind === "retained" && event.data.channelId === activeChannelId) captured.push(event.data);
  });
  result.handlerNode.actionHandler.MESSAGE_DELETE({ channelId, id });
  assert.equal(captured.length, 0);
  assert.equal(result.messages.get(id).deleted, true);
  activeChannelId = channelId;
  result.window.postMessage({ bridge: "LDMA_BRIDGE_V1", kind: "sync-deletions", channelId: otherChannelId }, "*");
  assert.equal(captured.length, 0);
  result.window.postMessage({ bridge: "LDMA_BRIDGE_V1", kind: "sync-deletions", channelId }, "*");
  assert.deepEqual(JSON.parse(JSON.stringify(captured)), [{
    bridge: "LDMA_BRIDGE_V1", kind: "retained", channelId, ids: [id], bulk: false
  }]);
  assert.equal(JSON.stringify(captured).includes("retained content"), false);
});

test("retained IDs replay once per ready until acknowledgment, without changing release eligibility", () => {
  const result = runHook({ deferReady: true });
  const channelId = "777777777777777777";
  const id = "888888888888888881";
  result.handlerNode.actionHandler.MESSAGE_DELETE({ channelId, id });
  const retainedCount = () => result.posted.filter((message) => message.kind === "retained").length;
  assert.equal(retainedCount(), 0);
  result.ready();
  assert.equal(retainedCount(), 1, "initial readiness must not deliver both buffered and replay copies");
  result.ready();
  assert.equal(retainedCount(), 2, "lack of durable acknowledgment keeps the ID replayable");
  result.window.postMessage({ bridge: "LDMA_BRIDGE_V1", kind: "deletion-ack", channelId, ids: [id] }, "*");
  result.ready();
  result.window.postMessage({ bridge: "LDMA_BRIDGE_V1", kind: "sync-deletions", channelId }, "*");
  assert.equal(retainedCount(), 2);
  // A native rehydration can drop the deleted property, but ACK must not drop
  // retainedKeys: explicit archive removal still owns this cached native row.
  result.messages.set(id, Object.assign({}, result.messages.get(id), { deleted: false }));
  result.window.postMessage({ bridge: "LDMA_BRIDGE_V1", kind: "release", channelId, ids: [id] }, "*");
  assert.equal(result.messages.has(id), false);
});

test("acknowledgment is scoped to validated channel IDs and at most 200 message IDs", () => {
  const result = runHook();
  const channelId = "777777777777777777";
  const original = result.messages.values().next().value;
  const ids = Array.from({ length: 201 }, (_, index) => String(888888888888888000n + BigInt(index)));
  for (const id of ids) {
    result.messages.set(id, Object.assign({}, original, { id }));
    result.handlerNode.actionHandler.MESSAGE_DELETE({ channelId, id });
  }
  for (const message of [
    { channelId: "invalid", ids },
    { channelId: "777777777777777778", ids },
    { channelId, ids: "not-an-array" }
  ]) result.window.postMessage(Object.assign({ bridge: "LDMA_BRIDGE_V1", kind: "deletion-ack" }, message), "*");
  let start = result.posted.length;
  result.window.postMessage({ bridge: "LDMA_BRIDGE_V1", kind: "sync-deletions", channelId }, "*");
  assert.equal(result.posted.slice(start).filter((message) => message.kind === "retained").flatMap((message) => message.ids).length, 201);
  result.window.postMessage({ bridge: "LDMA_BRIDGE_V1", kind: "deletion-ack", channelId, ids }, "*");
  start = result.posted.length;
  result.window.postMessage({ bridge: "LDMA_BRIDGE_V1", kind: "sync-deletions", channelId }, "*");
  assert.deepEqual(Array.from(result.posted.slice(start).filter((message) => message.kind === "retained").flatMap((message) => message.ids)), [ids[200]]);
});

test("release discards evicted-cache retries and reset releases only unacknowledged native messages", () => {
  const result = runHook();
  const channelId = "777777777777777777";
  const id = "888888888888888881";
  const secondId = "888888888888888882";
  const archivedId = "888888888888888883";
  result.messages.set(secondId, Object.assign({}, result.messages.get(id), { id: secondId }));
  result.messages.set(archivedId, Object.assign({}, result.messages.get(id), { id: archivedId }));
  result.handlerNode.actionHandler.MESSAGE_DELETE_BULK({ channelId, ids: [id, secondId, archivedId] });
  result.window.postMessage({ bridge: "LDMA_BRIDGE_V1", kind: "deletion-ack", channelId, ids: [archivedId] }, "*");
  result.messages.delete(id);
  result.window.postMessage({ bridge: "LDMA_BRIDGE_V1", kind: "release", channelId, ids: [id] }, "*");
  let start = result.posted.length;
  result.ready();
  assert.deepEqual(Array.from(result.posted.slice(start).filter((message) => message.kind === "retained").flatMap((message) => message.ids)), [secondId]);
  result.window.postMessage({ bridge: "LDMA_BRIDGE_V1", kind: "reset-deletions" }, "*");
  assert.equal(result.messages.has(secondId), false, "reset removes an unarchived retained native row");
  assert.equal(result.messages.get(archivedId).deleted, true, "ACKed rows are outside the pending-reset lifecycle");
  assert.equal(result.posted.filter((message) => message.kind === "deletions-reset").length, 1);
  start = result.posted.length;
  result.ready();
  assert.equal(result.posted.slice(start).some((message) => message.kind === "retained"), false);
  result.messages.set(archivedId, Object.assign({}, result.messages.get(archivedId), { deleted: false }));
  result.window.postMessage({ bridge: "LDMA_BRIDGE_V1", kind: "release", channelId, ids: [archivedId] }, "*");
  assert.equal(result.messages.has(archivedId), false);
});

test("reset acknowledges once and discards retries even when native release cannot be verified", () => {
  const result = runHook();
  const channelId = "777777777777777777";
  const id = "888888888888888881";
  result.handlerNode.actionHandler.MESSAGE_DELETE({ channelId, id });
  result.messageStore.getMessage = () => { throw new Error("native cache unavailable"); };
  result.window.postMessage({ bridge: "LDMA_BRIDGE_V1", kind: "reset-deletions" }, "*");
  assert.equal(result.posted.filter((message) => message.kind === "deletions-reset").length, 1);
  const start = result.posted.length;
  result.ready();
  result.tick(20);
  assert.equal(result.posted.slice(start).some((message) => message.kind === "retained"), false);
  const status = result.posted.filter((message) => message.kind === "status").at(-1);
  assert.equal(status.status, "degraded");
  assert.match(status.detail, /could not be released/);
  result.window.postMessage({ bridge: "LDMA_BRIDGE_V1", kind: "reset-deletions" }, "*");
  assert.equal(result.posted.filter((message) => message.kind === "deletions-reset").length, 2);
});

test("a pre-ready reset discards buffered deletion signals as well as retained retries", () => {
  const result = runHook({ deferReady: true });
  const channelId = "777777777777777777";
  const id = "888888888888888881";
  result.handlerNode.actionHandler.MESSAGE_DELETE({ channelId, id });
  result.subscriptions.get("MESSAGE_DELETE")({ channelId, id });
  result.window.postMessage({ bridge: "LDMA_BRIDGE_V1", kind: "reset-deletions" }, "*");
  result.ready();
  assert.equal(result.messages.has(id), false);
  assert.equal(result.posted.some((message) => ["retained", "delete"].includes(message.kind)), false);
  assert.equal(result.posted.filter((message) => message.kind === "deletions-reset").length, 1);
});

test("a full 5000-ID ledger preserves unresolved IDs and lets overflowing native deletions proceed", () => {
  const result = runHook({ deferReady: true });
  const channelId = "777777777777777777";
  const original = result.messages.values().next().value;
  const ids = Array.from({ length: 5003 }, (_, index) => String(888888888888800000n + BigInt(index)));
  for (let offset = 0; offset < ids.length; offset += 200) {
    const batch = ids.slice(offset, offset + 200);
    for (const id of batch) result.messages.set(id, Object.assign({}, original, { id }));
    result.handlerNode.actionHandler.MESSAGE_DELETE_BULK({ channelId, ids: batch });
  }
  const start = result.posted.length;
  result.ready();
  const retained = result.posted.slice(start).filter((message) => message.kind === "retained");
  assert.equal(retained.length, 25);
  assert.equal(retained.every((message) => message.ids.length <= 200 && message.channelId === channelId && message.bulk === true), true);
  const replayedIds = retained.flatMap((message) => message.ids);
  assert.equal(replayedIds.length, 5000);
  assert.equal(new Set(replayedIds).size, 5000);
  assert.equal(replayedIds.includes(ids[0]), true, "the oldest unresolved ID must remain replayable");
  assert.equal(ids.slice(5000).every((id) => !replayedIds.includes(id) && !result.messages.has(id)), true,
    "overflowed messages must follow the native deletion path rather than become untracked retained rows");
  result.tick(20);
  assert.equal(result.posted.filter((message) => message.kind === "status").at(-1).status, "degraded");
  result.window.postMessage({ bridge: "LDMA_BRIDGE_V1", kind: "reset-deletions", resetToken: 1 }, "*");
  const reset = result.posted.filter((message) => message.kind === "deletions-reset").at(-1);
  assert.equal(reset.discarded.flatMap((batch) => batch.ids).length, 5000);
  assert.equal(reset.discarded.some((batch) => batch.ids.includes(ids[0])), true);
  assert.equal(ids.some((id) => result.messages.has(id)), false, "reset must not leave an evicted-ID ghost behind");
  result.ready();
  assert.equal(result.posted.filter((message) => message.kind === "status").at(-1).status, "active");
});

test("native and fallback bulk admission count earlier successes at the retry limit", () => {
  const channelId = "777777777777777777";
  for (const hideHandlerNode of [false, true]) {
    const result = runHook({ deferReady: true, hideHandlerNode });
    const template = result.messages.values().next().value;
    const ids = Array.from({ length: 5002 }, (_, index) => String(888888888888700000n + BigInt(index)));
    const dispatchBulk = (batch) => {
      for (const id of batch) result.messages.set(id, Object.assign({}, template, { id }));
      result.dispatcher.dispatch({ type: "MESSAGE_DELETE_BULK", channelId, ids: batch });
    };
    for (let offset = 0; offset < 4999; offset += 200) dispatchBulk(ids.slice(offset, Math.min(4999, offset + 200)));
    dispatchBulk(ids.slice(4999));
    assert.equal(result.messages.get(ids[4999])?.deleted, true, "the final available slot should retain its message");
    assert.equal(result.messages.has(ids[5000]), false, "the second item in the same batch must be deleted natively");
    assert.equal(result.messages.has(ids[5001]), false);
    result.ready();
    const replay = result.posted.filter((message) => message.kind === "retained").flatMap((message) => message.ids);
    assert.equal(replay.length, 5000);
    assert.equal(replay.includes(ids[0]), true);
    result.window.postMessage({ bridge: "LDMA_BRIDGE_V1", kind: "deletion-ack", channelId, ids: [ids[0]] }, "*");
    dispatchBulk([ids[5000]]);
    assert.equal(result.messages.get(ids[5000])?.deleted, true, "an acknowledgment frees admission capacity");
  }
});

test("failed native retention never suppresses the original single-message deletion or queues retries", () => {
  for (const getMessages of [
    () => { throw new Error("collection unavailable"); },
    () => ({}),
    () => ({ receiveMessage() { throw new Error("receive failed"); } }),
    () => ({ receiveMessage() {} })
  ]) {
    const result = runHook();
    const channelId = "777777777777777777";
    const id = "888888888888888881";
    result.messageStore.getMessages = getMessages;
    result.handlerNode.actionHandler.MESSAGE_DELETE({ channelId, id });
    result.ready();
    assert.equal(result.messages.has(id), false);
    assert.equal(result.posted.some((message) => message.kind === "retained"), false);
  }
});

test("mixed bulk retention passes failures and uncaptured IDs to the native handler without deleting successes", () => {
  const result = runHook();
  const channelId = "777777777777777777";
  const retainedId = "888888888888888881";
  const failedId = "888888888888888882";
  const uncapturedId = "888888888888888883";
  result.messages.set(failedId, Object.assign({}, result.messages.get(retainedId), { id: failedId }));
  result.messageStore.getMessages = () => ({
    receiveMessage(message) {
      if (message.id === failedId) throw new Error("one message failed");
      result.messages.set(message.id, message);
    }
  });
  const action = { channelId, ids: [retainedId, failedId, uncapturedId] };
  result.handlerNode.actionHandler.MESSAGE_DELETE_BULK(action);
  assert.equal(result.messages.get(retainedId).deleted, true);
  assert.equal(result.messages.has(failedId), false);
  assert.equal(result.messages.has(uncapturedId), false);
  assert.deepEqual(action.ids, [retainedId, failedId, uncapturedId], "do not mutate Discord's action payload");
  const retained = result.posted.filter((message) => message.kind === "retained");
  assert.deepEqual(Array.from(retained[0].ids), [retainedId]);
});

test("bulk retention cap does not suppress native deletion of IDs beyond the capture limit", () => {
  const result = runHook();
  const channelId = "777777777777777777";
  const original = result.messages.values().next().value;
  const ids = Array.from({ length: 201 }, (_, index) => String(888888888888888000n + BigInt(index)));
  for (const id of ids) result.messages.set(id, Object.assign({}, original, { id }));
  result.handlerNode.actionHandler.MESSAGE_DELETE_BULK({ channelId, ids });
  assert.equal(ids.slice(0, 200).every((id) => result.messages.get(id)?.deleted === true), true);
  assert.equal(result.messages.has(ids[200]), false);
  const retained = result.posted.filter((message) => message.kind === "retained");
  assert.equal(retained.length, 1);
  assert.equal(retained[0].ids.length, 200);
});

test("dispatcher fallback leaves failed restores deleted while replaying only successful restores", () => {
  const result = runHook({ hideHandlerNode: true });
  const channelId = "777777777777777777";
  const retainedId = "888888888888888881";
  const failedId = "888888888888888882";
  result.messages.set(failedId, Object.assign({}, result.messages.get(retainedId), { id: failedId }));
  result.messageStore.getMessages = () => ({
    receiveMessage(message) {
      if (message.id === failedId) throw new Error("restore failed");
      result.messages.set(message.id, message);
    }
  });
  result.dispatcher.dispatch({ type: "MESSAGE_DELETE_BULK", channelId, ids: [retainedId, failedId] });
  assert.equal(result.messages.get(retainedId).deleted, true);
  assert.equal(result.messages.has(failedId), false);
  result.ready();
  assert.equal(result.posted.filter((message) => message.kind === "retained").every((message) => message.ids.length === 1 && message.ids[0] === retainedId), true);
});

test("MessageStore update handlers emit an ID-only synchronous edit lifecycle before applying a genuine edit", () => {
  const { dispatched, handlerNode, messages } = runHook();
  const channelId = "777777777777777777";
  const messageId = "888888888888888881";
  handlerNode.actionHandler.MESSAGE_UPDATE({
    message: {
      channel_id: channelId,
      id: messageId,
      content: "edited content must not cross",
      edited_timestamp: "2026-08-27T10:11:12.000Z"
    }
  });
  assert.equal(messages.get(messageId).content, "edited content must not cross");
  const edits = dispatched.filter((event) => event.type === "LDMA_EDIT_BEFORE_V1").map((event) => JSON.parse(event.detail));
  assert.equal(edits.length, 1);
  assert.equal(edits[0].bridge, "LDMA_BRIDGE_V1");
  assert.equal(edits[0].kind, "edit-before");
  assert.equal(edits[0].channelId, channelId);
  assert.deepEqual(Array.from(edits[0].ids), [messageId]);
  assert.equal(edits[0].editedAt, Date.parse("2026-08-27T10:11:12.000Z"));
  assert.equal(JSON.stringify(edits[0]).includes("edited content must not cross"), false);

  handlerNode.actionHandler.MESSAGE_UPDATE({
    message: { channel_id: channelId, id: messageId, content: "duplicate", edited_timestamp: "2026-08-27T10:11:12.000Z" }
  });
  handlerNode.actionHandler.MESSAGE_UPDATE({
    message: { channel_id: channelId, id: messageId, content: "stale", edited_timestamp: "2026-08-27T10:11:11.000Z" }
  });
  handlerNode.actionHandler.MESSAGE_UPDATE({
    message: { channel_id: channelId, id: messageId, content: "hydration only" }
  });
  assert.equal(dispatched.filter((event) => event.type === "LDMA_EDIT_BEFORE_V1").length, 1);
});

test("self edits stage the rendered baseline at edit start and confirm it once after success", () => {
  const result = runHook();
  const channelId = "777777777777777777";
  const messageId = "888888888888888881";
  const start = result.subscriptions.get("MESSAGE_START_EDIT");
  const end = result.subscriptions.get("MESSAGE_END_EDIT");
  assert.equal(typeof start, "function");
  assert.equal(typeof end, "function");

  start({ type: "MESSAGE_START_EDIT", channelId, messageId, content: "must not cross" });
  let lifecycle = result.dispatched.filter((event) => event.type === "LDMA_EDIT_BEFORE_V1")
    .map((event) => JSON.parse(event.detail));
  assert.equal(lifecycle.length, 1);
  assert.equal(lifecycle[0].kind, "edit-stage");
  assert.equal(lifecycle[0].channelId, channelId);
  assert.deepEqual(lifecycle[0].ids, [messageId]);
  assert.equal(JSON.stringify(lifecycle[0]).includes("must not cross"), false);

  result.handlerNode.actionHandler.MESSAGE_UPDATE({
    message: {
      channel_id: channelId,
      id: messageId,
      content: "new self-edited content",
      edited_timestamp: "2026-08-28T01:02:03.000Z"
    }
  });
  lifecycle = result.dispatched.filter((event) => event.type === "LDMA_EDIT_BEFORE_V1")
    .map((event) => JSON.parse(event.detail));
  assert.equal(lifecycle.length, 1);

  end({
    type: "MESSAGE_END_EDIT",
    channelId,
    response: { body: { edited_timestamp: "2026-08-28T01:02:03.000Z", content: "must not cross" } }
  });
  lifecycle = result.dispatched.filter((event) => event.type === "LDMA_EDIT_BEFORE_V1")
    .map((event) => JSON.parse(event.detail));
  assert.equal(lifecycle.length, 2);
  assert.equal(lifecycle[1].kind, "edit-before");
  assert.equal(lifecycle[1].editSequence, lifecycle[0].editSequence);
  assert.equal(lifecycle[1].editedAt, Date.parse("2026-08-28T01:02:03.000Z"));
  assert.equal(JSON.stringify(lifecycle[1]).includes("must not cross"), false);

  result.handlerNode.actionHandler.MESSAGE_UPDATE({
    message: {
      channel_id: channelId,
      id: messageId,
      content: "new self-edited content",
      edited_timestamp: "2026-08-28T01:02:03.000Z"
    }
  });
  assert.equal(result.dispatched.filter((event) => event.type === "LDMA_EDIT_BEFORE_V1").length, 2);
});

test("cancelled or failed self edits discard their staged baseline without creating history", () => {
  const result = runHook();
  const channelId = "777777777777777777";
  const messageId = "888888888888888881";
  result.subscriptions.get("MESSAGE_START_EDIT")({ type: "MESSAGE_START_EDIT", channelId, messageId });
  result.subscriptions.get("MESSAGE_END_EDIT")({ type: "MESSAGE_END_EDIT", channelId });
  const lifecycle = result.dispatched.filter((event) => event.type === "LDMA_EDIT_BEFORE_V1")
    .map((event) => JSON.parse(event.detail));
  assert.deepEqual(lifecycle.map((event) => event.kind), ["edit-stage", "edit-cancel"]);
  assert.equal(lifecycle[1].editSequence, lifecycle[0].editSequence);
  assert.equal(lifecycle.some((event) => event.kind === "edit-before"), false);
});

test("MessageStore hydration without a cached predecessor does not fabricate an edit", () => {
  const { dispatched, handlerNode, messages } = runHook();
  const channelId = "777777777777777777";
  const messageId = "999999999999999999";
  messages.delete(messageId);
  handlerNode.actionHandler.MESSAGE_UPDATE({
    message: {
      channel_id: channelId,
      id: messageId,
      content: "already edited before hydration",
      edited_timestamp: "2026-08-27T10:11:12.000Z"
    }
  });
  assert.equal(dispatched.filter((event) => event.type === "LDMA_EDIT_BEFORE_V1").length, 0);
});

test("missing exact update handler uses edit-only dispatcher fallback without overstating partial support", () => {
  const fallback = runHook({ missingUpdateHandler: true });
  fallback.dispatcher.dispatch({
    type: "MESSAGE_UPDATE",
    message: {
      channel_id: "777777777777777777",
      id: "888888888888888881",
      content: "fallback edit",
      edited_timestamp: "2026-08-27T10:11:12.000Z"
    }
  });
  assert.equal(fallback.dispatched.filter((event) => event.type === "LDMA_EDIT_BEFORE_V1").length, 1);
  assert.equal(fallback.posted.some((message) => message.kind === "status" && message.status === "active"), true);

  const partial = runHook({ missingUpdateHandler: true, lockDispatcher: true });
  assert.equal(partial.posted.some((message) => message.kind === "status" && message.status === "active"), false);
  assert.equal(partial.posted.some((message) => message.kind === "status" && ["degraded", "searching"].includes(message.status)), true);
});

test("dispatcher compatibility fallback restores a message when handler metadata is hidden", () => {
  const { posted, dispatcher, messages } = runHook({ hideHandlerNode: true });
  dispatcher.dispatch({
    type: "MESSAGE_DELETE",
    channelId: "777777777777777777",
    id: "888888888888888881",
    content: "must not cross"
  });
  assert.equal(messages.get("888888888888888881").deleted, true);
  const retained = posted.filter((message) => message.kind === "retained");
  assert.deepEqual(JSON.parse(JSON.stringify(retained)), [{
    bridge: "LDMA_BRIDGE_V1",
    kind: "retained",
    channelId: "777777777777777777",
    ids: ["888888888888888881"],
    bulk: false
  }]);
  assert.equal(JSON.stringify(retained).includes("must not cross"), false);
});

test("user actions reject unrecognized operations, malformed IDs, missing guilds, and extra payload fields", async () => {
  const result = runHook();
  const userId = "888888888888888881";
  const guildId = "777777777777777777";
  const rejected = await Promise.all([
    result.invokeUserAction("unknown", { userId, guildId }),
    result.invokeUserAction("open-profile", { userId: "bad", guildId }),
    result.invokeUserAction("open-profile", { userId, guildId: "bad" }),
    result.invokeUserAction("open-profile", { userId }),
    result.invokeUserAction("open-profile", { userId, guildId, username: "must-not-cross" }),
    result.invokeUserAction("timeout-7d", { userId, guildId: null })
  ]);
  assert.deepEqual(rejected.map((item) => JSON.parse(JSON.stringify(item))), [
    { ok: false, reason: "invalid-request" },
    { ok: false, reason: "invalid-request" },
    { ok: false, reason: "invalid-request" },
    { ok: false, reason: "invalid-request" },
    { ok: false, reason: "invalid-request" },
    { ok: false, reason: "invalid-request" }
  ]);
  assert.deepEqual(result.userActionCalls, { profile: [], until: [] });
});

test("author resolution returns exact IDs and usernames for current, retained, or trusted deleted messages", () => {
  const result = runHook();
  const channelId = "777777777777777777";
  const messageId = "888888888888888881";
  assert.deepEqual(JSON.parse(JSON.stringify(result.resolveMessageAuthors(channelId, [messageId]))), {
    ok: true,
    reason: "resolved",
    authors: [{ messageId, userId: "999999999999999991", username: "curiousbro" }]
  });
  result.handlerNode.actionHandler.MESSAGE_DELETE({ channelId, id: messageId });
  assert.equal(result.messages.get(messageId).deleted, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.resolveMessageAuthors(channelId, [messageId]))), {
    ok: true,
    reason: "resolved",
    authors: [{ messageId, userId: "999999999999999991", username: "curiousbro" }]
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result.resolveMessageAuthors(channelId, ["888888888888888889"]))), {
    ok: true,
    reason: "resolved",
    authors: []
  });
  result.messages.set(messageId, {
    id: "888888888888888882",
    channel_id: channelId,
    author: { id: "999999999999999992" }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result.resolveMessageAuthors(channelId, [messageId]))), {
    ok: true,
    reason: "resolved",
    authors: []
  });
  result.users.delete("999999999999999991");
  assert.deepEqual(JSON.parse(JSON.stringify(result.resolveMessageAuthors(channelId, [messageId], [{
    messageId,
    userId: "999999999999999991",
    username: "archive_name"
  }]))), {
    ok: true,
    reason: "resolved",
    authors: [{ messageId, userId: "999999999999999991", username: "archive_name" }]
  });
  result.messages.set(messageId, {
    id: messageId,
    channel_id: channelId,
    author: { id: "999999999999999992" }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result.resolveMessageAuthors(channelId, [messageId], [{
    messageId,
    userId: "999999999999999991",
    username: "must_not_cross"
  }]))), {
    ok: true,
    reason: "resolved-author-ids-only",
    authors: [{ messageId, userId: "999999999999999992" }]
  });
  result.messages.set(messageId, {
    id: messageId,
    channel_id: "777777777777777778",
    author: { id: "999999999999999992" }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result.resolveMessageAuthors(channelId, [messageId]))), {
    ok: true,
    reason: "resolved",
    authors: []
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result.resolveMessageAuthors(channelId, ["bad"]))), {
    ok: false,
    reason: "invalid-request",
    authors: []
  });
});

test("author resolution accepts an ID-only message and a structurally discovered UserStore", () => {
  const result = runHook({ messageAuthorAsId: true, structuralUserStoreOnly: true });
  const channelId = "777777777777777777";
  const messageId = "888888888888888881";
  assert.deepEqual(JSON.parse(JSON.stringify(result.resolveMessageAuthors(channelId, [messageId]))), {
    ok: true,
    reason: "resolved",
    authors: [{ messageId, userId: "999999999999999991", username: "curiousbro" }]
  });
});

test("author resolution refuses an unbound embedded username and conflicting structural stores", () => {
  const unbound = runHook({ messageAuthorUnboundUsername: true, noUserStore: true });
  const channelId = "777777777777777777";
  const messageId = "888888888888888881";
  assert.deepEqual(JSON.parse(JSON.stringify(unbound.resolveMessageAuthors(channelId, [messageId]))), {
    ok: true,
    reason: "resolved-author-ids-only",
    authors: [{ messageId, userId: "999999999999999991" }]
  });

  const conflicting = runHook({
    messageAuthorAsId: true,
    structuralUserStoreOnly: true,
    conflictingStructuralUserStores: true
  });
  assert.deepEqual(JSON.parse(JSON.stringify(conflicting.resolveMessageAuthors(channelId, [messageId]))), {
    ok: true,
    reason: "resolved-author-ids-only",
    authors: [{ messageId, userId: "999999999999999991" }]
  });
});

test("author resolution reports an exact author ID when no username cache is available", () => {
  const result = runHook({ messageAuthorAsId: true, noUserStore: true });
  const channelId = "777777777777777777";
  const messageId = "888888888888888881";
  assert.deepEqual(JSON.parse(JSON.stringify(result.resolveMessageAuthors(channelId, [messageId]))), {
    ok: true,
    reason: "resolved-author-ids-only",
    authors: [{ messageId, userId: "999999999999999991" }]
  });
});

test("a trusted deleted archive identity resolves even while MessageStore is unavailable", () => {
  const result = runHook({ delayedStore: true, noUserStore: true });
  const channelId = "777777777777777777";
  const messageId = "888888888888888881";
  assert.deepEqual(JSON.parse(JSON.stringify(result.resolveMessageAuthors(channelId, [messageId], [{
    messageId,
    userId: "999999999999999991",
    username: "curiousbro"
  }]))), {
    ok: true,
    reason: "resolved-from-trusted-archive",
    authors: [{ messageId, userId: "999999999999999991", username: "curiousbro" }]
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result.resolveMessageAuthors(channelId, [messageId]))), {
    ok: false,
    reason: "message-store-unavailable",
    authors: []
  });

  const idOnlyArchive = runHook({ delayedStore: true });
  assert.deepEqual(JSON.parse(JSON.stringify(idOnlyArchive.resolveMessageAuthors(channelId, [messageId], [{
    messageId,
    userId: "999999999999999991"
  }]))), {
    ok: true,
    reason: "resolved-from-trusted-archive",
    authors: [{ messageId, userId: "999999999999999991", username: "curiousbro" }]
  });

  const idOnlyWithoutUserStore = runHook({ delayedStore: true, noUserStore: true });
  assert.deepEqual(JSON.parse(JSON.stringify(idOnlyWithoutUserStore.resolveMessageAuthors(channelId, [messageId], [{
    messageId,
    userId: "999999999999999991"
  }]))), {
    ok: true,
    reason: "resolved-author-ids-only",
    authors: [{ messageId, userId: "999999999999999991" }]
  });
});

test("a newer page hook never self-reloads an older controller contract", () => {
  const settings = { legacyController: true };
  const result = runHook(settings);
  assert.equal(result.legacyRecoveries(), 0);
  assert.equal(result.reloads(), 0);
  assert.equal(result.window[Symbol.for("BridgeModTools.pageHook.v1")].upgradeRequired, 4);
  result.reinject();
  assert.equal(result.legacyRecoveries(), 0);
  assert.equal(result.reloads(), 0);
});

test("native profile and fixed seven-day timeout actions receive only normalized identity context", async () => {
  const result = runHook();
  assert.equal(result.profileExportUsesGetter, true);
  const userId = "888888888888888881";
  const guildId = "777777777777777777";
  const profile = await result.invokeUserAction("open-profile", { userId, guildId });
  assert.deepEqual(JSON.parse(JSON.stringify(profile)), { ok: true, reason: "opened" });
  assert.deepEqual(JSON.parse(JSON.stringify(result.userActionCalls.profile)), [{
    generation: 1,
    payload: { userId, guildId }
  }]);

  const before = Date.now();
  const timeout = await result.invokeUserAction("timeout-7d", { userId, guildId });
  const after = Date.now();
  assert.deepEqual(JSON.parse(JSON.stringify(timeout)), { ok: true, reason: "timed-out-7d" });
  assert.equal(result.userActionCalls.until.length, 1);
  const timeoutPayload = result.userActionCalls.until[0].payload;
  assert.deepEqual(Object.keys(timeoutPayload).sort(), [
    "communicationDisabledUntilTimestamp", "duration", "guildId", "reason", "userId"
  ]);
  assert.equal(timeoutPayload.userId, userId);
  assert.equal(timeoutPayload.guildId, guildId);
  assert.equal(timeoutPayload.duration, 604800);
  assert.equal(timeoutPayload.reason, "");
  const deadline = Date.parse(timeoutPayload.communicationDisabledUntilTimestamp);
  assert.ok(deadline >= before + 604800000);
  assert.ok(deadline <= after + 604800000);
});

test("user actions fail closed when Discord's native modules are unavailable or reject", async () => {
  const payload = { userId: "888888888888888881", guildId: "777777777777777777" };
  const unavailable = runHook({ noUserActionModules: true });
  assert.deepEqual(JSON.parse(JSON.stringify(await unavailable.invokeUserAction("open-profile", payload))),
    { ok: false, reason: "module-unavailable" });
  assert.deepEqual(JSON.parse(JSON.stringify(await unavailable.invokeUserAction("timeout-7d", payload))),
    { ok: false, reason: "module-unavailable" });

  const rejected = runHook({ rejectProfileAction: true, rejectTimeoutAction: true });
  assert.deepEqual(JSON.parse(JSON.stringify(await rejected.invokeUserAction("open-profile", payload))),
    { ok: false, reason: "action-failed" });
  assert.deepEqual(JSON.parse(JSON.stringify(await rejected.invokeUserAction("timeout-7d", payload))),
    { ok: false, reason: "action-failed" });
});

test("user actions rediscover replaced modules and never call removed stale exports", async () => {
  const result = runHook();
  const payload = { userId: "888888888888888881", guildId: "777777777777777777" };
  await result.invokeUserAction("open-profile", payload);
  await result.invokeUserAction("timeout-7d", payload);
  result.replaceUserActionModules();
  await result.invokeUserAction("open-profile", payload);
  await result.invokeUserAction("timeout-7d", payload);
  assert.deepEqual(result.userActionCalls.profile.map((call) => call.generation), [1, 2]);
  assert.deepEqual(result.userActionCalls.until.map((call) => call.generation), [1, 2]);

  result.removeUserActionModules();
  assert.deepEqual(JSON.parse(JSON.stringify(await result.invokeUserAction("open-profile", payload))),
    { ok: false, reason: "module-unavailable" });
  assert.deepEqual(JSON.parse(JSON.stringify(await result.invokeUserAction("timeout-7d", payload))),
    { ok: false, reason: "module-unavailable" });
  assert.deepEqual(result.userActionCalls.profile.map((call) => call.generation), [1, 2]);
  assert.deepEqual(result.userActionCalls.until.map((call) => call.generation), [1, 2]);
});

test("release removes only a message previously retained by the hook", () => {
  const { handlerNode, messages, window } = runHook();
  const channelId = "777777777777777777";
  const retainedId = "888888888888888881";
  handlerNode.actionHandler.MESSAGE_DELETE({ channelId, id: retainedId });
  assert.equal(messages.get(retainedId).deleted, true);
  window.postMessage({ bridge: "LDMA_BRIDGE_V1", kind: "release", channelId, ids: [retainedId] }, "*");
  assert.equal(messages.has(retainedId), false);

  const liveId = "888888888888888889";
  messages.set(liveId, {
    id: liveId, deleted: false,
    set(key, value) { return Object.assign({}, this, { [key]: value }); }
  });
  window.postMessage({ bridge: "LDMA_BRIDGE_V1", kind: "release", channelId, ids: [liveId] }, "*");
  assert.equal(messages.has(liveId), true);
});
