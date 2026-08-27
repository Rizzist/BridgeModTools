"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function eventSlot() {
  return {
    listener: null,
    addListener(callback) { this.listener = callback; }
  };
}

function backgroundHarness() {
  const calls = [];
  const events = {
    message: eventSlot(), connect: eventSlot(), installed: eventSlot(), startup: eventSlot(),
    committed: eventSlot(), history: eventSlot(), replaced: eventSlot(), activated: eventSlot()
  };
  let isolatedInstalled = false;
  let styleInstalled = false;
  let queriedTabs = [];
  let context;
  const storageWrites = [];
  const networkCalls = [];
  const chrome = {
    runtime: {
      id: "extension-id",
      getURL(relative) { return `chrome-extension://extension-id/${relative}`; },
      onMessage: events.message,
      onConnect: events.connect,
      onInstalled: events.installed,
      onStartup: events.startup,
      sendMessage: async () => ({ ok: true })
    },
    scripting: {
      async executeScript(options) {
        calls.push({ kind: "script", options });
        if (typeof options.func === "function") {
          if (/invokeUserAction/.test(String(options.func))) {
            return [{ result: await options.func(...(options.args || [])) }];
          }
          if (/contentStyle\.v1"\)\]\s*=\s*true/.test(String(options.func))) {
            styleInstalled = true;
            return [{ result: true }];
          }
          return [{ result: { contentInstalled: isolatedInstalled, styleInstalled } }];
        }
        return [];
      },
      async insertCSS(options) { calls.push({ kind: "css", options }); }
    },
    webNavigation: {
      onCommitted: events.committed,
      onHistoryStateUpdated: events.history,
      onTabReplaced: events.replaced,
      async getFrame({ tabId }) {
        return { documentId: `document-${tabId}`, url: "https://discord.com/app" };
      }
    },
    tabs: {
      onActivated: events.activated,
      async query() { return queriedTabs; },
      async reload(tabId) { calls.push({ kind: "reload", tabId }); }
    },
    storage: { local: { async get() { return {}; }, async set(value) { storageWrites.push(value); } } },
    offscreen: { async createDocument() {}, async closeDocument() {} },
    permissions: { async contains() { return false; } }
  };
  const TYPES = {
    GET_ARCHIVE: "GET", UPSERT_RECORDS: "UPSERT", CONFIRM_EDIT: "EDIT", CONFIRM_DELETED: "DELETE",
    INFER_DELETED: "INFER", RETRACT_MESSAGE: "RETRACT", SET_HEALTH: "HEALTH", SET_PAUSED: "PAUSE",
    CLEAR_ARCHIVE: "CLEAR", DELETE_RECORD: "DELETE_RECORD", GET_RECORD: "GET_RECORD", CACHE_MEDIA: "CACHE_MEDIA",
    CACHE_ALL_MEDIA: "CACHE_ALL_MEDIA", GET_MEDIA_STATS: "MEDIA_STATS", CREATE_MEDIA_CAPABILITY: "CREATE_CAP",
    REDEEM_MEDIA_CAPABILITY: "REDEEM_CAP"
  };
  context = vm.createContext({
    chrome,
    importScripts() {},
    self: { clients: { async matchAll() { return []; } } },
    crypto: { getRandomValues(bytes) { bytes.fill(1); return bytes; } },
    URL, Date, Promise, Map, Set, WeakMap, Uint8Array, Object, Array, String, Number, Boolean, RegExp,
    location: { href: "https://discord.com/channels/@me/777777777777777777" },
    async fetch(...args) { networkCalls.push(args); return { ok: true }; },
    LocalDiscordArchiveProtocol: { TYPES, normalizeArchive: (value) => value || { records: [], generation: 0 } },
    LocalDiscordArchiveCore: {
      normalizeText: (value) => String(value || "").replace(/\s+/g, " ").trim(),
      recordKey: (record) => `${record.channelId}:${record.messageId}`,
      isDeletedStatus: () => false,
      hasEdits: () => false,
      sanitizeMediaItems: () => [],
      sanitizeRecordPresentation: (value) => value
    },
    BridgeModToolsMediaStore: {}
  });
  const source = fs.readFileSync(path.resolve(__dirname, "../src/background.js"), "utf8");
  vm.runInContext(`${source}\n;globalThis.__testApi = { ensureDiscordBootstrap, discordContentSender, discordChannelContentSender, discordChannelContext, extensionSenderPath, reportLiveHealth, bestLiveHealth, pruneLiveHealth, liveHealthByDocument, handleUserAction, userActionRateLimits };`, context);
  return {
    api: context.__testApi,
    calls,
    storageWrites,
    networkCalls,
    events,
    setLocation(href) { context.location.href = href; },
    setMainController(controller) { context[Symbol.for("BridgeModTools.pageHook.v1")] = controller; },
    setIsolatedInstalled(value) { isolatedInstalled = value; styleInstalled = value; },
    setQueriedTabs(value) { queriedTabs = value; }
  };
}

function discordSender(overrides) {
  return Object.assign({
    id: "extension-id",
    origin: "https://discord.com",
    url: "https://discord.com/app",
    frameId: 0,
    documentId: "document-1",
    tab: { id: 1, url: "https://discord.com/channels/@me/777777777777777777" }
  }, overrides || {});
}

test("document-bound full bootstrap installs once and later recovers without duplicate CSS", async () => {
  const harness = backgroundHarness();
  const first = await harness.api.ensureDiscordBootstrap(1, "document-1", true);
  assert.equal(first.ok, true);
  assert.deepEqual(harness.calls.map((call) => call.kind), ["script", "script", "css", "script", "script"]);
  for (const call of harness.calls) {
    assert.deepEqual(Array.from(call.options.target.documentIds), ["document-1"]);
    assert.equal("frameIds" in call.options.target, false);
  }

  harness.calls.length = 0;
  harness.setIsolatedInstalled(true);
  const second = await harness.api.ensureDiscordBootstrap(1, "document-1", true);
  assert.equal(second.ok, true);
  assert.deepEqual(harness.calls.map((call) => call.kind), ["script", "script"]);
  assert.equal(harness.calls.some((call) => call.kind === "css"), false);
});

test("a content watchdog request performs full hook, style, and isolated-world recovery", async () => {
  const harness = backgroundHarness();
  const response = await new Promise((resolve) => {
    const asyncResponse = harness.events.message.listener(
      { type: "LDMA_ENSURE_BOOTSTRAP", reason: "content-start" },
      discordSender(),
      resolve
    );
    assert.equal(asyncResponse, true);
  });
  assert.equal(response.ok, true);
  assert.deepEqual(harness.calls.map((call) => call.kind), ["script", "script", "css", "script", "script"]);
});

test("Discord and extension sender authorization rejects route, origin, frame, and lookalike confusion", () => {
  const { api } = backgroundHarness();
  const good = discordSender();
  assert.equal(api.discordContentSender(good), true);
  assert.equal(api.discordChannelContentSender(good), true);
  assert.equal(api.discordChannelContentSender(discordSender({ tab: { id: 1, url: "https://discord.com/app" } })), false);
  assert.equal(api.discordContentSender(discordSender({ origin: "http://discord.com", url: "http://discord.com/app" })), false);
  assert.equal(api.discordContentSender(discordSender({ origin: "https://discord.com:444", url: "https://discord.com:444/app" })), false);
  assert.equal(api.discordContentSender(discordSender({ origin: "https://discord.com.evil.test", url: "https://discord.com.evil.test/app" })), false);
  assert.equal(api.discordContentSender(discordSender({ frameId: 2 })), false);
  assert.equal(api.discordContentSender(discordSender({ documentId: "" })), false);
  assert.equal(api.discordContentSender(discordSender({ documentId: { toString: () => "document-1" } })), false);

  assert.equal(api.extensionSenderPath({ id: "extension-id", url: "chrome-extension://extension-id/popup/popup.html" }), "/popup/popup.html");
  assert.equal(api.extensionSenderPath({ id: "extension-id", url: "https://discord.com/popup/popup.html" }), null);
});

test("live health is document-scoped, active wins, and inactive removes the document", () => {
  const { api } = backgroundHarness();
  const degraded = discordSender({ documentId: "degraded", tab: { id: 1, url: "https://discord.com/channels/@me/777777777777777777" } });
  const active = discordSender({ documentId: "active", tab: { id: 2, url: "https://discord.com/channels/111111111111111111/777777777777777777" } });
  assert.equal(api.reportLiveHealth({ status: "degraded", detail: "searching" }, degraded).ok, true);
  assert.equal(api.reportLiveHealth({ status: "active", detail: "retention active" }, active).ok, true);
  assert.equal(api.bestLiveHealth().status, "active");
  api.reportLiveHealth({ status: "inactive", detail: "left channel" }, active);
  assert.equal(api.bestLiveHealth().status, "degraded");

  const stale = api.liveHealthByDocument.get("1:degraded");
  stale.updatedAt = Date.now() - 46000;
  assert.equal(api.bestLiveHealth(), null);
  assert.equal(api.liveHealthByDocument.size, 0);

  api.reportLiveHealth({ status: "active", detail: "clock skew" }, active);
  api.liveHealthByDocument.get("2:active").updatedAt = Date.now() + 6000;
  assert.equal(api.bestLiveHealth(), null);
  assert.equal(api.liveHealthByDocument.size, 0);
});

test("activating a restored or discarded Discord tab resolves its current document and performs full bootstrap", async () => {
  const harness = backgroundHarness();
  harness.events.activated.listener({ tabId: 8, windowId: 3 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.calls.map((call) => call.kind), ["script", "script", "css", "script", "script"]);
  for (const call of harness.calls) assert.deepEqual(Array.from(call.options.target.documentIds), ["document-8"]);
});

test("extension update automatically reloads legacy open Discord documents once", async () => {
  const harness = backgroundHarness();
  harness.setQueriedTabs([{ id: 9 }, { id: 10 }]);
  harness.events.installed.listener({ reason: "update", previousVersion: "2.3.0" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.calls.filter((call) => call.kind === "reload").map((call) => call.tabId), [9, 10]);
  assert.equal(harness.calls.some((call) => call.kind === "script"), false);
});

test("user action broker derives route context and invokes the document-bound MAIN controller", async () => {
  const harness = backgroundHarness();
  const invocations = [];
  harness.setLocation("https://discord.com/channels/111111111111111111/777777777777777777");
  harness.setMainController({
    invokeUserAction(action, payload) {
      invocations.push({ action, payload });
      return { ok: true, reason: "profile-opened", secret: "must-not-cross" };
    }
  });
  const sender = discordSender({
    tab: { id: 4, url: "https://discord.com/channels/111111111111111111/777777777777777777" },
    documentId: "document-4"
  });
  const result = await new Promise((resolve) => {
    const asyncResponse = harness.events.message.listener({
      type: "LDMA_USER_ACTION",
      action: "open-profile",
      userId: "222222222222222222",
      guildId: "999999999999999999"
    }, sender, resolve);
    assert.equal(asyncResponse, true);
  });
  assert.deepEqual(plain(result), { ok: true, reason: "profile-opened" });
  assert.deepEqual(plain(invocations), [{
    action: "open-profile",
    payload: { userId: "222222222222222222", guildId: "111111111111111111" }
  }]);
  const call = harness.calls.at(-1);
  assert.equal(call.options.world, "MAIN");
  assert.deepEqual(Array.from(call.options.target.documentIds), ["document-4"]);
  assert.equal("frameIds" in call.options.target, false);
  assert.equal(harness.storageWrites.length, 0);
  assert.equal(harness.networkCalls.length, 0);
});

test("user action broker rejects untrusted origins, routes, actions, snowflakes, and guild spoofing", async () => {
  const harness = backgroundHarness();
  const base = { type: "LDMA_USER_ACTION", action: "open-profile", userId: "222222222222222222" };
  assert.equal((await harness.api.handleUserAction(base, discordSender({ frameId: 1 }))).reason, "untrusted-user-action-sender");
  assert.equal((await harness.api.handleUserAction(base, discordSender({ origin: "https://discord.com.evil.test" }))).reason, "untrusted-user-action-sender");
  assert.equal((await harness.api.handleUserAction(base, discordSender({ tab: { id: 1, url: "https://discord.com/app" } }))).reason, "untrusted-user-action-sender");
  assert.equal((await harness.api.handleUserAction({ ...base, action: "arbitrary-call" }, discordSender())).reason, "unsupported-user-action");
  assert.equal((await harness.api.handleUserAction({ ...base, userId: "12-not-a-snowflake" }, discordSender())).reason, "invalid-user-id");

  const dmSender = discordSender();
  assert.equal((await harness.api.handleUserAction({ ...base, action: "timeout-7d", guildId: "111111111111111111" }, dmSender)).reason, "timeout-requires-guild");
  const guildSender = discordSender({ tab: { id: 1, url: "https://discord.com/channels/111111111111111111/777777777777777777" } });
  assert.equal((await harness.api.handleUserAction({ ...base, action: "timeout-7d", guildId: "999999999999999999" }, guildSender)).reason, "guild-context-mismatch");
  assert.equal(harness.calls.length, 0);
});

test("timeout action is fixed to the current numeric guild and the allowlisted arguments", async () => {
  const harness = backgroundHarness();
  const invocations = [];
  harness.setLocation("https://discord.com/channels/111111111111111111/777777777777777777");
  harness.setMainController({
    invokeUserAction(action, payload) { invocations.push({ action, payload }); return { ok: true, reason: "timeout-dialog-opened" }; }
  });
  const sender = discordSender({ tab: { id: 3, url: "https://discord.com/channels/111111111111111111/777777777777777777" }, documentId: "document-3" });
  const response = await harness.api.handleUserAction({
    type: "LDMA_USER_ACTION", action: "timeout-7d", userId: "222222222222222222", guildId: "111111111111111111",
    duration: 1, arbitrary: { method: "DELETE", token: "nope" }
  }, sender);
  assert.deepEqual(plain(response), { ok: true, reason: "timeout-dialog-opened" });
  assert.deepEqual(plain(invocations), [{ action: "timeout-7d", payload: { userId: "222222222222222222", guildId: "111111111111111111" } }]);
});

test("user action broker reports missing controllers and binds execution to the still-current route", async () => {
  const harness = backgroundHarness();
  const sender = discordSender();
  const missing = await harness.api.handleUserAction({
    type: "LDMA_USER_ACTION", action: "open-profile", userId: "222222222222222222"
  }, sender);
  assert.deepEqual(plain(missing), { ok: false, reason: "user-action-controller-unavailable" });

  harness.setLocation("https://discord.com/channels/@me/888888888888888888");
  harness.setMainController({ invokeUserAction() { throw new Error("must not run on a changed route"); } });
  const changed = await harness.api.handleUserAction({
    type: "LDMA_USER_ACTION", action: "open-profile", userId: "222222222222222222"
  }, sender);
  assert.deepEqual(plain(changed), { ok: false, reason: "user-action-route-changed" });
});

test("user action broker rate limits each document and keeps limiter state bounded", async () => {
  const harness = backgroundHarness();
  harness.setMainController({ invokeUserAction() { return { ok: true, reason: "profile-opened" }; } });
  const command = { type: "LDMA_USER_ACTION", action: "open-profile", userId: "222222222222222222" };
  const sender = discordSender();
  for (let index = 0; index < 8; index += 1) assert.equal((await harness.api.handleUserAction(command, sender)).ok, true);
  const throttled = await harness.api.handleUserAction(command, sender);
  assert.deepEqual(plain(throttled), { ok: false, reason: "user-action-throttled" });
  assert.equal(harness.calls.length, 8);

  for (let index = 0; index < 550; index += 1) {
    const other = discordSender({ tab: { id: index + 10, url: "https://discord.com/channels/@me/777777777777777777" }, documentId: `document-${index + 10}` });
    await harness.api.handleUserAction(command, other);
  }
  assert.ok(harness.api.userActionRateLimits.size <= 500);
});
