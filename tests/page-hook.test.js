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
  const messages = new Map();
  const makeMessage = (id, deleted, content, editedTimestamp) => ({
    id,
    channel_id: "777777777777777777",
    content: content || "retained content",
    editedTimestamp: editedTimestamp || null,
    author: { id: "current-user" },
    deleted: Boolean(deleted),
    set(key, value) {
      const next = makeMessage(this.id, key === "deleted" ? value : this.deleted, this.content, this.editedTimestamp);
      next.author = this.author;
      return next;
    }
  });
  messages.set("888888888888888881", makeMessage("888888888888888881", false));
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
  const rejectingDispatcher = {
    dispatch() {},
    subscribe(type) { if (type === "MESSAGE_DELETE_BULK") throw new Error("not this dispatcher"); },
    unsubscribe() {}
  };
  const rejectingStore = { _dispatcher: rejectingDispatcher, getName() { return "MessageStore"; } };
  const webpackRequire = function webpackRequire() {};
  const moduleExports = {};
  Object.defineProperty(moduleExports, "Z", { enumerable: true, get() { return messageStore; } });
  webpackRequire.c = {
    "0": { exports: { rejectingStore } },
    "1": { exports: { fallbackDispatcher } },
    "42": { exports: moduleExports }
  };
  const chunks = [];
  chunks.push = function push(chunk) {
    if (typeof chunk[2] === "function") chunk[2](webpackRequire);
    return Array.prototype.push.call(this, chunk);
  };
  const window = {
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
  class CustomEvent {
    constructor(type, options) { this.type = type; this.detail = options?.detail; }
  }
  const context = vm.createContext({ window, CustomEvent, setInterval() { return 1; }, Date, Math, Object, Array, Set, Map, WeakMap, WeakSet, String, Boolean });
  const source = fs.readFileSync(path.resolve(__dirname, "../src/page-hook.js"), "utf8");
  vm.runInContext(source, context);
  window.webpackChunkdiscord_app = chunks;
  window.postMessage({ bridge: "LDMA_BRIDGE_V1", kind: "isolated-ready" }, "*");
  return { posted, dispatched, subscriptions, fallbackSubscriptions, handlerNode, messages, dispatcher, window };
}

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
  assert.equal(messages.get("888888888888888881").author.id, "current-user");
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
