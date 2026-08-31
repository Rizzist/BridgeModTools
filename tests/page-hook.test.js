"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function runHook(options) {
  const settings = options || {};
  const listeners = new Map();
  const dispatched = [];
  const posted = [];
  const subscriptions = new Map();
  const intervals = [];
  const messages = new Map();
  const users = new Map();
  const guildMembers = new Map();
  const guildMemberCalls = [];
  const userActionCalls = { profile: [], until: [] };
  const profileRoots = [];
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
  let guildMemberStoreGeneration = 1;
  const makeGuildMemberStore = (storeDispatcher) => {
    const generation = guildMemberStoreGeneration;
    return {
      _dispatcher: storeDispatcher,
      getName() { return "GuildMemberStore"; },
      getDispatchToken() { return "guild_member_store_token"; },
      getMember(guildId, userId) {
        guildMemberCalls.push({ generation, guildId, userId });
        if (settings.throwGuildMemberLookup) throw new Error("member lookup failed");
        return guildMembers.get(`${guildId}:${userId}`) || null;
      },
      getMembers(guildId) {
        return [...guildMembers.entries()].filter(([key]) => key.startsWith(`${guildId}:`)).map(([, member]) => member);
      }
    };
  };
  let guildMemberStore = makeGuildMemberStore(dispatcher);
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
  const structuralGuildMemberStore = {
    getMember(guildId, userId) { return guildMembers.get(`${guildId}:${userId}`) || null; },
    getMembers() { return [...guildMembers.values()]; }
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
      $$typeof: Symbol.for("react.memo"),
      type: function UserProfilePopout({ children, userId, user }) { return { children, userId, user }; }
    },
    react: {
      version: "19.0.0",
      createElement(type, props) { return { type, props }; },
      memo(value) { return value; },
      useState(value) { return [value, () => {}]; }
    },
    renderer: {
      createRoot(anchor) {
        const generation = actionGeneration;
        const root = {
          anchor, element: null, unmounted: false,
          render(element) {
            if (settings.rejectProfileAction) throw new Error("profile rejected");
            this.element = element;
            userActionCalls.profile.push({
              generation,
              payload: {
                userId: element.props.userId,
                userObjectId: element.props.user?.id,
                guildId: element.props.guildId ?? null,
                channelId: element.props.channelId,
                position: element.props.position,
                spacing: element.props.spacing,
                fixed: element.props.fixed,
                shouldShow: element.props.shouldShow,
                clickTrap: element.props.clickTrap,
                ignoreModalClicks: element.props.ignoreModalClicks,
                anchor
              }
            });
          },
          unmount() { this.unmounted = true; }
        };
        profileRoots.push(root);
        return root;
      },
      hydrateRoot() {}
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
    until: { enumerable: true, get() { return userActionModules?.until || {}; } }
  });
  const profilePopoutExports = {};
  const reactExports = {};
  const rendererExports = {};
  Object.defineProperties(profilePopoutExports, {
    A: { enumerable: true, get() { return userActionModules?.profile || {}; } }
  });
  Object.defineProperties(reactExports, {
    A: { enumerable: true, get() { return userActionModules?.react || {}; } }
  });
  Object.defineProperties(rendererExports, {
    A: { enumerable: true, get() { return userActionModules?.renderer || {}; } }
  });
  let storeAvailable = !settings.delayedStore;
  Object.defineProperty(moduleExports, "Z", { enumerable: true, get() { return storeAvailable ? messageStore : {}; } });
  const guildMemberExports = {};
  Object.defineProperty(guildMemberExports, "Z", {
    enumerable: true,
    get() { return settings.noGuildMemberStore ? {} : guildMemberStore; }
  });
  const wrongGuildMemberDispatcher = {
    dispatch() {}, subscribe() {}, unsubscribe() {}
  };
  const wrongDispatcherGuildMemberStore = makeGuildMemberStore(wrongGuildMemberDispatcher);
  webpackRequire.c = {
    "0": { exports: { rejectingStore } },
    "1": { exports: { fallbackDispatcher } },
    "20": { exports: profilePopoutExports },
    "21": { exports: userActionExports },
    "22": { exports: reactExports },
    "23": { exports: rendererExports },
    "42": { exports: moduleExports },
    "43": { exports: settings.noUserStore ? {} : { Z: settings.structuralUserStoreOnly ? structuralUserStore : userStore } },
    "44": { exports: settings.conflictingStructuralUserStores ? { Z: conflictingStructuralUserStore } : {} },
    "45": { exports: guildMemberExports },
    "46": { exports: settings.structuralGuildMemberStoreOnly ? { Z: structuralGuildMemberStore } : {} },
    "47": { exports: settings.wrongDispatcherGuildMemberStore ? { Z: wrongDispatcherGuildMemberStore } : {} }
  };
  webpackRequire.m = {
    "20": function userProfilePopoutFactory() {
      /* withMutualGuilds disableUserProfileLink targetElementRef type:"popout" messageId */
    }
  };
  const chunks = [];
  chunks.push = function push(chunk) {
    if (typeof chunk[2] === "function") chunk[2](webpackRequire);
    return Array.prototype.push.call(this, chunk);
  };
  const window = {
    location: {
      pathname: settings.dmRoute ? "/channels/@me/777777777777777777" :
        "/channels/777777777777777777/666666666666666666",
      reload() { settings.reloads = (settings.reloads || 0) + 1; }
    },
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
    removeEventListener(type, callback) {
      listeners.set(type, (listeners.get(type) || []).filter((item) => item !== callback));
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
  const documentListeners = new Map();
  const body = {
    children: [],
    append(element) {
      element.isConnected = true;
      element.parentElement = this;
      this.children.push(element);
    }
  };
  const document = {
    body,
    createElement(tagName) {
      const attributes = new Map();
      return {
        tagName: String(tagName).toUpperCase(), style: {}, isConnected: false, parentElement: null,
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute(name) { return attributes.get(name) || null; },
        remove() {
          this.isConnected = false;
          if (this.parentElement?.children) {
            this.parentElement.children = this.parentElement.children.filter((item) => item !== this);
          }
          this.parentElement = null;
        }
      };
    },
    addEventListener(type, callback) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(callback);
    },
    removeEventListener(type, callback) {
      documentListeners.set(type, (documentListeners.get(type) || []).filter((item) => item !== callback));
    }
  };
  const timeouts = [];
  const context = vm.createContext({
    window, document, CustomEvent,
    setInterval(callback) { intervals.push(callback); return intervals.length; },
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timeouts.push(timer);
      return timer;
    },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
    Date, Math, Number, Object, Array, Set, Map, WeakMap, WeakSet, String, Boolean, Symbol, Function
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
    posted, dispatched, subscriptions, fallbackSubscriptions, handlerNode, messages, users, guildMembers,
    guildMemberCalls, dispatcher, window, ready, messageStore,
    reloads: () => settings.reloads || 0,
    legacyRecoveries: () => settings.legacyRecoveries || 0,
    userActionCalls, profileRoots, body,
    invokeUserAction(action, payload) {
      return window[Symbol.for("BridgeModTools.pageHook.v1")].invokeUserAction(action, payload);
    },
    resolveMessageAuthors(channelId, ids, fallbacks) {
      return window[Symbol.for("BridgeModTools.pageHook.v1")].resolveMessageAuthors(channelId, ids, fallbacks);
    },
    resolveMemberTimeouts(guildId, userIds) {
      return window[Symbol.for("BridgeModTools.pageHook.v1")].resolveMemberTimeouts(guildId, userIds);
    },
    setGuildMember(guildId, userId, member) {
      const key = `${guildId}:${userId}`;
      if (member == null) guildMembers.delete(key);
      else guildMembers.set(key, member);
    },
    emitGuildMemberUpdate(action) {
      const listener = subscriptions.get("GUILD_MEMBER_UPDATE");
      if (listener) listener(action);
    },
    emitDocumentEvent(type) {
      for (const callback of documentListeners.get(type) || []) callback({ type });
      for (const timer of timeouts.filter((item) => !item.cleared && item.delay === 0)) {
        timer.cleared = true;
        timer.callback();
      }
    },
    flushZeroTimers() {
      for (const timer of timeouts.filter((item) => !item.cleared && item.delay === 0)) {
        timer.cleared = true;
        timer.callback();
      }
    },
    replaceUserActionModules() {
      actionGeneration += 1;
      userActionModules = makeUserActionModules();
      return actionGeneration;
    },
    removeUserActionModules() { userActionModules = null; },
    replaceGuildMemberStore() {
      guildMemberStoreGeneration += 1;
      guildMemberStore = makeGuildMemberStore(dispatcher);
      return guildMemberStoreGeneration;
    },
    removeGuildMemberStore() {
      settings.noGuildMemberStore = true;
      guildMemberStoreGeneration += 1;
    },
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
  assert.equal(result.window[Symbol.for("BridgeModTools.pageHook.v1")].apiVersion, 7);
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

test("retained deletions expose only bounded verified mention tokens and replay them until acknowledgment", () => {
  const result = runHook({ deferReady: true });
  const channelId = "777777777777777777";
  const messageId = "888888888888888881";
  const firstUserId = "111111111111111111";
  const secondUserId = "222222222222222222";
  const roleId = "333333333333333333";
  const message = result.messages.get(messageId);
  message.content = `ban <@${firstUserId}> and <@&${roleId}> @everyone then <@!${secondUserId}>`;
  message.mentions = [{ id: firstUserId }, { id: secondUserId }];
  message.mentionRoles = [roleId];
  message.mentionEveryone = true;
  result.handlerNode.actionHandler.MESSAGE_DELETE({ channelId, id: messageId });
  assert.equal(result.posted.some((item) => item.kind === "retained"), false);
  result.ready();
  const retained = plain(result.posted.filter((item) => item.kind === "retained").at(-1));
  assert.deepEqual(retained, {
    bridge: "LDMA_BRIDGE_V1", kind: "retained", channelId, ids: [messageId], bulk: false,
    mentions: [{
      messageId,
      tokens: [
        { kind: "user", userId: firstUserId },
        { kind: "role" },
        { kind: "broadcast" },
        { kind: "user", userId: secondUserId }
      ]
    }]
  });
  assert.equal(JSON.stringify(retained).includes(roleId), false, "role identity does not cross the page bridge");
  assert.equal(JSON.stringify(retained).includes("ban "), false, "message content never crosses the page bridge");
  result.ready();
  assert.deepEqual(plain(result.posted.filter((item) => item.kind === "retained").at(-1).mentions), retained.mentions);
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
  const anchor = { left: 120, top: 80, width: 48, height: 48 };
  const rejected = await Promise.all([
    result.invokeUserAction("unknown", { userId, guildId, anchor }),
    result.invokeUserAction("open-profile", { userId: "bad", guildId, anchor }),
    result.invokeUserAction("open-profile", { userId, guildId: "bad", anchor }),
    result.invokeUserAction("open-profile", { userId }),
    result.invokeUserAction("open-profile", { userId, guildId, anchor, username: "must-not-cross" }),
    result.invokeUserAction("open-profile", { userId, guildId, anchor: { left: 0, top: 0, width: 0, height: 48 } }),
    result.invokeUserAction("timeout-7d", { userId, guildId: null })
  ]);
  assert.deepEqual(rejected.map((item) => JSON.parse(JSON.stringify(item))), [
    { ok: false, reason: "invalid-request" },
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
  assert.equal(result.window[Symbol.for("BridgeModTools.pageHook.v1")].upgradeRequired, 7);
  result.reinject();
  assert.equal(result.legacyRecoveries(), 0);
  assert.equal(result.reloads(), 0);
});

test("GuildMemberStore timeout resolution normalizes current production field shapes", () => {
  const result = runHook();
  const guildId = "777777777777777777";
  const isoUserId = "999999999999999991";
  const millisecondsUserId = "999999999999999992";
  const secondsUserId = "999999999999999993";
  const snakeUserId = "999999999999999994";
  const timestampUserId = "999999999999999995";
  const now = Date.now();
  const iso = new Date(now + 60_000).toISOString();
  const milliseconds = now + 120_000;
  const seconds = Math.floor((now + 180_000) / 1000);
  const snake = new Date(now + 240_000).toISOString();
  const timestamp = new Date(now + 300_000).toISOString();
  result.setGuildMember(guildId, isoUserId, { guildId, userId: isoUserId, communicationDisabledUntil: iso });
  result.setGuildMember(guildId, millisecondsUserId,
    { guildId, userId: millisecondsUserId, communicationDisabledUntil: milliseconds });
  result.setGuildMember(guildId, secondsUserId,
    { guildId, userId: secondsUserId, communicationDisabledUntil: seconds });
  result.setGuildMember(guildId, snakeUserId,
    { guild_id: guildId, user_id: snakeUserId, communication_disabled_until: snake });
  result.setGuildMember(guildId, timestampUserId,
    { guildId, user: { id: timestampUserId }, communicationDisabledUntilTimestamp: timestamp });

  assert.deepEqual(plain(result.resolveMemberTimeouts(guildId, [
    isoUserId, millisecondsUserId, secondsUserId, snakeUserId, timestampUserId
  ])), {
    ok: true,
    reason: "member-timeouts-resolved",
    statuses: [
      { userId: isoUserId, timeoutUntil: iso },
      { userId: millisecondsUserId, timeoutUntil: new Date(milliseconds).toISOString() },
      { userId: secondsUserId, timeoutUntil: new Date(seconds * 1000).toISOString() },
      { userId: snakeUserId, timeoutUntil: snake },
      { userId: timestampUserId, timeoutUntil: timestamp }
    ]
  });
  assert.deepEqual(result.guildMemberCalls.map(({ guildId: calledGuildId, userId }) => ({ guildId: calledGuildId, userId })), [
    { guildId, userId: isoUserId },
    { guildId, userId: millisecondsUserId },
    { guildId, userId: secondsUserId },
    { guildId, userId: snakeUserId },
    { guildId, userId: timestampUserId }
  ]);
});

test("GuildMemberStore timeout resolution distinguishes known inactive members from malformed or unavailable state", () => {
  const result = runHook();
  const guildId = "777777777777777777";
  const nullUserId = "999999999999999991";
  const expiredUserId = "999999999999999992";
  const emptyUserId = "999999999999999993";
  const malformedUserId = "999999999999999994";
  const throwingFieldUserId = "999999999999999995";
  const throwingIdentityUserId = "999999999999999996";
  const hugeNumericUserId = "999999999999999997";
  const throwingValueUserId = "999999999999999998";
  const missingUserId = "999999999999999999";
  result.setGuildMember(guildId, nullUserId, { guildId, userId: nullUserId, communicationDisabledUntil: null });
  result.setGuildMember(guildId, expiredUserId, {
    guildId, userId: expiredUserId, communication_disabled_until: new Date(Date.now() - 60_000).toISOString()
  });
  result.setGuildMember(guildId, emptyUserId, { guildId, userId: emptyUserId, communicationDisabledUntil: "" });
  result.setGuildMember(guildId, malformedUserId,
    { guildId, userId: malformedUserId, communicationDisabledUntil: "not-a-date" });
  const throwingField = { guildId, userId: throwingFieldUserId };
  Object.defineProperty(throwingField, "communicationDisabledUntil", { get() { throw new Error("blocked field"); } });
  result.setGuildMember(guildId, throwingFieldUserId, throwingField);
  const throwingIdentity = { guildId, communicationDisabledUntil: new Date(Date.now() + 60_000).toISOString() };
  Object.defineProperty(throwingIdentity, "userId", { get() { throw new Error("blocked identity"); } });
  result.setGuildMember(guildId, throwingIdentityUserId, throwingIdentity);
  result.setGuildMember(guildId, hugeNumericUserId,
    { guildId, userId: hugeNumericUserId, communicationDisabledUntil: 1e20 });
  result.setGuildMember(guildId, throwingValueUserId, {
    guildId,
    userId: throwingValueUserId,
    communicationDisabledUntil: { toString() { throw new Error("blocked timestamp coercion"); } }
  });

  assert.doesNotThrow(() => result.resolveMemberTimeouts(guildId, [throwingIdentityUserId]));
  assert.deepEqual(plain(result.resolveMemberTimeouts(guildId, [
    nullUserId, expiredUserId, emptyUserId, malformedUserId,
    throwingFieldUserId, throwingIdentityUserId, hugeNumericUserId, throwingValueUserId, missingUserId
  ])), {
    ok: true,
    reason: "member-timeouts-resolved",
    statuses: [
      { userId: nullUserId, timeoutUntil: null },
      { userId: expiredUserId, timeoutUntil: null },
      { userId: emptyUserId, timeoutUntil: null }
    ]
  });

  const throwingLookup = runHook({ throwGuildMemberLookup: true });
  assert.deepEqual(plain(throwingLookup.resolveMemberTimeouts(guildId, [nullUserId])), {
    ok: true, reason: "member-timeouts-resolved", statuses: []
  });
});

test("timeout resolution uses only the exact GuildMemberStore on the accepted core dispatcher", () => {
  const guildId = "777777777777777777";
  const userId = "999999999999999991";
  const timeoutUntil = new Date(Date.now() + 60_000).toISOString();

  const missing = runHook({ noGuildMemberStore: true });
  assert.deepEqual(plain(missing.resolveMemberTimeouts(guildId, [userId])), {
    ok: false, reason: "guild-member-store-unavailable", statuses: []
  });

  const structural = runHook({ noGuildMemberStore: true, structuralGuildMemberStoreOnly: true });
  structural.setGuildMember(guildId, userId, { guildId, userId, communicationDisabledUntil: timeoutUntil });
  assert.deepEqual(plain(structural.resolveMemberTimeouts(guildId, [userId])), {
    ok: false, reason: "guild-member-store-unavailable", statuses: []
  });

  const withWrongDispatcherDecoy = runHook({ wrongDispatcherGuildMemberStore: true });
  withWrongDispatcherDecoy.setGuildMember(guildId, userId,
    { guildId, userId, communicationDisabledUntil: timeoutUntil });
  assert.deepEqual(plain(withWrongDispatcherDecoy.resolveMemberTimeouts(guildId, [userId])), {
    ok: true,
    reason: "member-timeouts-resolved",
    statuses: [{ userId, timeoutUntil }]
  });
  assert.equal(withWrongDispatcherDecoy.guildMemberCalls.at(-1).generation, 1);
});

test("timeout resolution rejects missing, mismatched, and cross-guild member identities", () => {
  const result = runHook();
  const guildId = "777777777777777777";
  const otherGuildId = "777777777777777778";
  const missingUserId = "999999999999999991";
  const mismatchedUserId = "999999999999999992";
  const crossGuildUserId = "999999999999999993";
  const nestedUserId = "999999999999999994";
  const timeoutUntil = new Date(Date.now() + 60_000).toISOString();
  result.setGuildMember(guildId, mismatchedUserId,
    { guildId, userId: "999999999999999999", communicationDisabledUntil: timeoutUntil });
  result.setGuildMember(guildId, crossGuildUserId,
    { guildId: otherGuildId, userId: crossGuildUserId, communicationDisabledUntil: timeoutUntil });
  result.setGuildMember(guildId, nestedUserId,
    { guild_id: guildId, user: { id: nestedUserId }, communication_disabled_until: timeoutUntil });

  assert.deepEqual(plain(result.resolveMemberTimeouts(guildId, [
    missingUserId, mismatchedUserId, crossGuildUserId, nestedUserId
  ])), {
    ok: true,
    reason: "member-timeouts-resolved",
    statuses: [{ userId: nestedUserId, timeoutUntil }]
  });
});

test("timeout resolution validates bounded unique string batches before touching Discord stores", () => {
  const result = runHook();
  const guildId = "777777777777777777";
  const ids = Array.from({ length: 200 }, (_value, index) => String(100000000000000 + index));
  for (const userId of ids) result.setGuildMember(guildId, userId, { guildId, userId, communicationDisabledUntil: null });
  assert.equal(result.resolveMemberTimeouts(guildId, ids).statuses.length, 200);
  assert.equal(result.guildMemberCalls.length, 200);

  const invalidRequests = [
    ["bad", [ids[0]]],
    [guildId, null],
    [guildId, []],
    [guildId, [...ids, "100000000000999"]],
    [guildId, [ids[0], ids[0]]],
    [guildId, [ids[0], "bad"]],
    [guildId, [Number(ids[0])]]
  ];
  for (const [receivedGuildId, userIds] of invalidRequests) {
    assert.deepEqual(plain(result.resolveMemberTimeouts(receivedGuildId, userIds)), {
      ok: false, reason: "invalid-request", statuses: []
    });
  }
  assert.equal(result.guildMemberCalls.length, 200, "invalid batches must not reach GuildMemberStore");
});

test("guild member updates and successful timeout actions emit normalized state invalidations", async () => {
  const result = runHook();
  const guildId = "777777777777777777";
  const firstUserId = "999999999999999991";
  const secondUserId = "999999999999999992";
  const dirtyEvents = () => result.posted.filter((message) => message.kind === "timeout-state-dirty");
  const before = dirtyEvents().length;
  result.emitGuildMemberUpdate({ guild_id: guildId, user: { id: firstUserId } });
  result.emitGuildMemberUpdate({ guildId, member: { userId: secondUserId } });
  result.emitGuildMemberUpdate({ guildId: "bad", userId: firstUserId });
  result.emitGuildMemberUpdate({ guildId, userId: "bad" });
  const throwingUpdate = {};
  Object.defineProperty(throwingUpdate, "guildId", { get() { throw new Error("blocked update identity"); } });
  assert.doesNotThrow(() => result.emitGuildMemberUpdate(throwingUpdate),
    "Discord's dispatcher must not be disrupted by an unexpected update object");
  assert.deepEqual(plain(dirtyEvents().slice(before)), [
    { bridge: "LDMA_BRIDGE_V1", kind: "timeout-state-dirty", guildId, userId: firstUserId },
    { bridge: "LDMA_BRIDGE_V1", kind: "timeout-state-dirty", guildId, userId: secondUserId }
  ]);

  const actionBefore = dirtyEvents().length;
  assert.equal((await result.invokeUserAction("timeout-7d", { guildId, userId: firstUserId })).ok, true);
  assert.deepEqual(plain(dirtyEvents().slice(actionBefore)), [
    { bridge: "LDMA_BRIDGE_V1", kind: "timeout-state-dirty", guildId, userId: firstUserId }
  ]);

  const rejected = runHook({ rejectTimeoutAction: true });
  const rejectedBefore = rejected.posted.filter((message) => message.kind === "timeout-state-dirty").length;
  assert.equal((await rejected.invokeUserAction("timeout-7d", { guildId, userId: firstUserId })).ok, false);
  assert.equal(rejected.posted.filter((message) => message.kind === "timeout-state-dirty").length, rejectedBefore);
});

test("timeout resolution rediscovers replaced stores and never calls removed stale exports", () => {
  const result = runHook();
  const guildId = "777777777777777777";
  const userId = "999999999999999991";
  result.setGuildMember(guildId, userId, { guildId, userId, communicationDisabledUntil: null });
  assert.equal(result.resolveMemberTimeouts(guildId, [userId]).ok, true);
  assert.equal(result.guildMemberCalls.at(-1).generation, 1);

  result.replaceGuildMemberStore();
  assert.equal(result.resolveMemberTimeouts(guildId, [userId]).ok, true);
  assert.equal(result.guildMemberCalls.at(-1).generation, 2,
    "the first post-replacement query must not call the stale store");

  result.removeGuildMemberStore();
  assert.deepEqual(plain(result.resolveMemberTimeouts(guildId, [userId])), {
    ok: false, reason: "guild-member-store-unavailable", statuses: []
  });
  assert.equal(result.guildMemberCalls.at(-1).generation, 2, "removed store must not be called again");
});

test("native profile and fixed seven-day timeout actions receive only normalized identity context", async () => {
  const result = runHook();
  const userId = "999999999999999991";
  const guildId = "777777777777777777";
  const anchor = { left: 120, top: 80, width: 48, height: 48 };
  const profile = await result.invokeUserAction("open-profile", { userId, guildId, anchor });
  assert.deepEqual(JSON.parse(JSON.stringify(profile)), { ok: true, reason: "opened-popout" });
  assert.equal(result.userActionCalls.profile.length, 1);
  const profilePayload = result.userActionCalls.profile[0].payload;
  assert.deepEqual({
    generation: result.userActionCalls.profile[0].generation,
    userId: profilePayload.userId,
    userObjectId: profilePayload.userObjectId,
    guildId: profilePayload.guildId,
    channelId: profilePayload.channelId,
    position: profilePayload.position,
    spacing: profilePayload.spacing,
    fixed: profilePayload.fixed,
    shouldShow: profilePayload.shouldShow,
    clickTrap: profilePayload.clickTrap,
    ignoreModalClicks: profilePayload.ignoreModalClicks
  }, {
    generation: 1, userId, userObjectId: "999999999999999991", guildId,
    channelId: "666666666666666666", position: "left", spacing: 16,
    fixed: true, shouldShow: true, clickTrap: true, ignoreModalClicks: true
  });
  assert.equal(profilePayload.anchor.getAttribute("data-ldma-profile-popout-anchor"), "true");
  assert.equal(profilePayload.anchor.style.left, "120px");
  assert.equal(profilePayload.anchor.style.top, "80px");

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

test("compact profile popouts replace and clean up their invisible anchors", async () => {
  const result = runHook();
  const payload = {
    userId: "999999999999999991",
    guildId: "777777777777777777",
    anchor: { left: 120, top: 80, width: 48, height: 48 }
  };
  assert.equal((await result.invokeUserAction("open-profile", payload)).ok, true);
  const firstRoot = result.profileRoots[0];
  assert.equal(result.body.children.length, 1);

  assert.equal((await result.invokeUserAction("open-profile", {
    ...payload, anchor: { left: 300, top: 160, width: 80, height: 24 }
  })).ok, true);
  const secondRoot = result.profileRoots[1];
  assert.equal(firstRoot.unmounted, true, "opening another author must unmount the previous popout");
  assert.equal(result.body.children.length, 1);
  assert.equal(secondRoot.anchor.style.left, "300px");

  secondRoot.element.props.onRequestClose();
  result.flushZeroTimers();
  assert.equal(secondRoot.unmounted, true);
  assert.equal(result.body.children.length, 0);

  assert.equal((await result.invokeUserAction("open-profile", payload)).ok, true);
  const scrollRoot = result.profileRoots[2];
  result.emitDocumentEvent("scroll");
  assert.equal(scrollRoot.unmounted, true, "scrolling must close an anchored popout");
  assert.equal(result.body.children.length, 0);
});

test("compact profile popouts preserve DM context and fail closed across routes", async () => {
  const dm = runHook({ dmRoute: true });
  const payload = {
    userId: "999999999999999991",
    guildId: null,
    anchor: { left: 120, top: 80, width: 48, height: 48 }
  };
  assert.deepEqual(plain(await dm.invokeUserAction("open-profile", payload)), {
    ok: true, reason: "opened-popout"
  });
  assert.equal(dm.userActionCalls.profile[0].payload.guildId, null);
  assert.equal(dm.userActionCalls.profile[0].payload.channelId, "777777777777777777");

  dm.window.location.pathname = "/channels/777777777777777777/666666666666666666";
  assert.deepEqual(plain(await dm.invokeUserAction("open-profile", payload)), {
    ok: false, reason: "profile-popout-unavailable"
  });
});

test("user actions fail closed when Discord's native modules are unavailable or reject", async () => {
  const timeoutPayload = { userId: "999999999999999991", guildId: "777777777777777777" };
  const profilePayload = Object.assign({ anchor: { left: 120, top: 80, width: 48, height: 48 } }, timeoutPayload);
  const unavailable = runHook({ noUserActionModules: true });
  assert.deepEqual(JSON.parse(JSON.stringify(await unavailable.invokeUserAction("open-profile", profilePayload))),
    { ok: false, reason: "profile-popout-unavailable" });
  assert.deepEqual(JSON.parse(JSON.stringify(await unavailable.invokeUserAction("timeout-7d", timeoutPayload))),
    { ok: false, reason: "module-unavailable" });

  const rejected = runHook({ rejectProfileAction: true, rejectTimeoutAction: true });
  assert.deepEqual(JSON.parse(JSON.stringify(await rejected.invokeUserAction("open-profile", profilePayload))),
    { ok: false, reason: "profile-popout-failed" });
  assert.deepEqual(JSON.parse(JSON.stringify(await rejected.invokeUserAction("timeout-7d", timeoutPayload))),
    { ok: false, reason: "action-failed" });
});

test("user actions rediscover replaced modules and never call removed stale exports", async () => {
  const result = runHook();
  const timeoutPayload = { userId: "999999999999999991", guildId: "777777777777777777" };
  const profilePayload = Object.assign({ anchor: { left: 120, top: 80, width: 48, height: 48 } }, timeoutPayload);
  await result.invokeUserAction("open-profile", profilePayload);
  await result.invokeUserAction("timeout-7d", timeoutPayload);
  result.replaceUserActionModules();
  await result.invokeUserAction("open-profile", profilePayload);
  await result.invokeUserAction("timeout-7d", timeoutPayload);
  assert.deepEqual(result.userActionCalls.profile.map((call) => call.generation), [1, 2]);
  assert.deepEqual(result.userActionCalls.until.map((call) => call.generation), [1, 2]);

  result.removeUserActionModules();
  assert.deepEqual(JSON.parse(JSON.stringify(await result.invokeUserAction("open-profile", profilePayload))),
    { ok: false, reason: "profile-popout-unavailable" });
  assert.deepEqual(JSON.parse(JSON.stringify(await result.invokeUserAction("timeout-7d", timeoutPayload))),
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
