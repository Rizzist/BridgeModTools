"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

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
    storage: { local: { async get() { return {}; }, async set() {} } },
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
  const context = vm.createContext({
    chrome,
    importScripts() {},
    self: { clients: { async matchAll() { return []; } } },
    crypto: { getRandomValues(bytes) { bytes.fill(1); return bytes; } },
    URL, Date, Promise, Map, Set, WeakMap, Uint8Array, Object, Array, String, Number, Boolean, RegExp,
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
  vm.runInContext(`${source}\n;globalThis.__testApi = { ensureDiscordBootstrap, discordContentSender, discordChannelContentSender, extensionSenderPath, reportLiveHealth, bestLiveHealth, pruneLiveHealth, liveHealthByDocument };`, context);
  return {
    api: context.__testApi,
    calls,
    events,
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
