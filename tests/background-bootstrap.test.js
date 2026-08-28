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

function backgroundHarness(options) {
  const calls = [];
  const events = {
    message: eventSlot(), connect: eventSlot(), installed: eventSlot(), startup: eventSlot(),
    committed: eventSlot(), history: eventSlot(), replaced: eventSlot(), activated: eventSlot(), removed: eventSlot()
  };
  const sessionData = options?.sessionData || {};
  let isolatedInstalled = false;
  let styleInstalled = false;
  let pageHookProbeState = { apiVersion: 3, ready: true };
  let pageHookFileInstallController = null;
  let queriedTabs = [];
  let storedArchive = null;
  let storageBytesInUse = 0;
  let mediaStats = { cached: 0, pending: 0, failed: 0, permissionRequired: 0, bytes: 0, origins: [] };
  let context;
  const storageWrites = [];
  const networkCalls = [];
  const chrome = {
    runtime: {
      id: "extension-id",
      getManifest() { return { version: options?.version || "2.6.5" }; },
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
        if (Array.isArray(options.files) && options.files.includes("src/page-hook.js") &&
          pageHookFileInstallController && !context[Symbol.for("BridgeModTools.pageHook.v1")]) {
          context[Symbol.for("BridgeModTools.pageHook.v1")] = pageHookFileInstallController;
        }
        if (typeof options.func === "function") {
          if (/expectedApiVersion/.test(String(options.func)) && /BridgeModTools\.pageHook\.v1/.test(String(options.func))) {
            return [{ result: pageHookProbeState }];
          }
          if (/invokeUserAction|resolveMessageAuthors/.test(String(options.func))) {
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
      onRemoved: events.removed,
      async query() { return queriedTabs; },
      async reload(tabId) { calls.push({ kind: "reload", tabId }); }
    },
    storage: { session: {
      async get(key) {
        return Object.prototype.hasOwnProperty.call(sessionData, key) ? { [key]: sessionData[key] } : {};
      },
      async set(value) { Object.assign(sessionData, value); }
    }, local: {
      async get() { return storedArchive ? { ldmaArchive: storedArchive } : {}; },
      async getBytesInUse() { return storageBytesInUse; },
      async set(value) {
        storageWrites.push(value);
        if (value && Object.prototype.hasOwnProperty.call(value, "ldmaArchive")) storedArchive = value.ldmaArchive;
      }
    } },
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
      isDeletedStatus: (status) => status === "confirmed_deleted" || status === "inferred_deleted",
      snowflakeValue: (value) => /^\d{15,25}$/.test(String(value || "")) ? String(value) : null,
      discordUsernameValue: (value) => typeof value === "string" && /^[a-z0-9._]{1,32}$/i.test(value.trim())
        ? value.trim() : null,
      hasEdits: () => false,
      sanitizeMediaItems: () => [],
      sanitizeRecordPresentation: (value) => value
    },
    BridgeModToolsMediaStore: {
      async setGeneration() {},
      async getStats() { return mediaStats; }
    }
  });
  const source = fs.readFileSync(path.resolve(__dirname, "../src/background.js"), "utf8");
  vm.runInContext(`${source}\n;globalThis.__testApi = { ensureDiscordBootstrap, discordContentSender, discordChannelContentSender, discordChannelContext, extensionSenderPath, reportLiveHealth, bestLiveHealth, pruneLiveHealth, liveHealthByDocument, handleUserAction, handleResolveMessageAuthors, handleMediaCommand, userActionRateLimits, timeoutActionsInFlight };`, context);
  return {
    api: context.__testApi,
    calls,
    storageWrites,
    networkCalls,
    events,
    setLocation(href) { context.location.href = href; },
    setMainController(controller) { context[Symbol.for("BridgeModTools.pageHook.v1")] = controller; },
    setStoredArchive(value) { storedArchive = value; },
    setStorageBytesInUse(value) { storageBytesInUse = value; },
    setMediaStats(value) { mediaStats = value; },
    setPageHookProbeState(value) { pageHookProbeState = value; },
    setPageHookFileInstallController(value) { pageHookFileInstallController = value; },
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
  assert.deepEqual(harness.calls.map((call) => call.kind), ["script", "script", "script", "css", "script", "script"]);
  for (const call of harness.calls) {
    assert.deepEqual(Array.from(call.options.target.documentIds), ["document-1"]);
    assert.equal("frameIds" in call.options.target, false);
  }

  harness.calls.length = 0;
  harness.setIsolatedInstalled(true);
  const second = await harness.api.ensureDiscordBootstrap(1, "document-1", true);
  assert.equal(second.ok, true);
  assert.deepEqual(harness.calls.map((call) => call.kind), ["script", "script", "script"]);
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
  assert.deepEqual(harness.calls.map((call) => call.kind), ["script", "script", "script", "css", "script", "script"]);
});

test("a stale page controller gets one bounded background reload and never loops", async () => {
  const harness = backgroundHarness();
  harness.setPageHookProbeState({ apiVersion: 2, ready: false });
  const first = await harness.api.ensureDiscordBootstrap(12, "document-12", true);
  assert.deepEqual(plain(first), { ok: false, reason: "page-hook-upgrade-reload-scheduled" });
  assert.deepEqual(harness.calls.map((call) => call.kind), ["script", "script", "reload"]);

  harness.calls.length = 0;
  const pending = await harness.api.ensureDiscordBootstrap(12, "document-12", true);
  assert.deepEqual(plain(pending), { ok: false, reason: "page-hook-upgrade-pending" });
  assert.deepEqual(harness.calls.map((call) => call.kind), ["script", "script"]);
  assert.equal(harness.calls.some((call) => call.kind === "reload"), false);

  harness.calls.length = 0;
  harness.setPageHookProbeState({ apiVersion: 3, ready: true });
  const recovered = await harness.api.ensureDiscordBootstrap(12, "document-13", true);
  assert.equal(recovered.ok, true);
  assert.equal(harness.calls.some((call) => call.kind === "reload"), false);
});

test("the stale-controller reload latch survives a service-worker restart and clears on tab close", async () => {
  const sessionData = {};
  const firstWorker = backgroundHarness({ sessionData });
  firstWorker.setPageHookProbeState({ apiVersion: 2, ready: false });
  assert.equal((await firstWorker.api.ensureDiscordBootstrap(21, "document-21", true)).reason,
    "page-hook-upgrade-reload-scheduled");
  assert.equal(firstWorker.calls.filter((call) => call.kind === "reload").length, 1);

  const restartedWorker = backgroundHarness({ sessionData });
  restartedWorker.setPageHookProbeState({ apiVersion: 2, ready: false });
  assert.equal((await restartedWorker.api.ensureDiscordBootstrap(21, "document-22", true)).reason,
    "page-hook-upgrade-pending");
  assert.equal(restartedWorker.calls.some((call) => call.kind === "reload"), false);

  restartedWorker.events.removed.listener(21, { windowId: 1, isWindowClosing: false });
  await new Promise((resolve) => setImmediate(resolve));
  const reusedTabWorker = backgroundHarness({ sessionData });
  reusedTabWorker.setPageHookProbeState({ apiVersion: 2, ready: false });
  assert.equal((await reusedTabWorker.api.ensureDiscordBootstrap(21, "document-23", true)).reason,
    "page-hook-upgrade-reload-scheduled");
});

test("extension update and stale-controller recovery share one reload gate", async () => {
  const harness = backgroundHarness();
  harness.setQueriedTabs([{ id: 22 }]);
  harness.setPageHookProbeState({ apiVersion: 2, ready: false });
  harness.events.installed.listener({ reason: "update", previousVersion: "2.6.3" });
  const bootstrap = harness.api.ensureDiscordBootstrap(22, "document-22", true);
  await bootstrap;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.calls.filter((call) => call.kind === "reload").length, 1);
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

test("popup media stats include message metadata and combined local data bytes", async () => {
  const harness = backgroundHarness();
  const mediaBytes = 65 * 1024 * 1024;
  const archiveBytes = 768 * 1024;
  harness.setMediaStats({
    cached: 183,
    pending: 2,
    failed: 1,
    permissionRequired: 7,
    bytes: mediaBytes,
    origins: ["https://media1.tenor.com"]
  });
  harness.setStorageBytesInUse(archiveBytes);
  const result = await harness.api.handleMediaCommand({ type: "MEDIA_STATS" }, {
    id: "extension-id",
    url: "chrome-extension://extension-id/popup/popup.html"
  });
  assert.deepEqual(plain(result), {
    ok: true,
    stats: {
      cached: 183,
      pending: 2,
      failed: 1,
      permissionRequired: 7,
      bytes: mediaBytes,
      origins: ["https://media1.tenor.com"],
      archiveBytes,
      totalBytes: mediaBytes + archiveBytes
    }
  });
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
  assert.deepEqual(harness.calls.map((call) => call.kind), ["script", "script", "script", "css", "script", "script"]);
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
  const resolutions = [];
  const messageId = "888888888888888881";
  harness.setLocation("https://discord.com/channels/111111111111111111/777777777777777777");
  harness.setMainController({
    resolveMessageAuthors(channelId, ids) {
      resolutions.push({ channelId, ids });
      return { ok: true, authors: [{ messageId, userId: "222222222222222222" }] };
    },
    invokeUserAction(action, payload) { invocations.push({ action, payload }); return { ok: true, reason: "timeout-dialog-opened" }; }
  });
  const sender = discordSender({ tab: { id: 3, url: "https://discord.com/channels/111111111111111111/777777777777777777" }, documentId: "document-3" });
  const response = await harness.api.handleUserAction({
    type: "LDMA_USER_ACTION", action: "timeout-7d", userId: "222222222222222222", guildId: "111111111111111111", messageId,
    duration: 1, arbitrary: { method: "DELETE", token: "nope" }
  }, sender);
  assert.deepEqual(plain(response), { ok: true, reason: "timeout-dialog-opened" });
  assert.deepEqual(plain(invocations), [{ action: "timeout-7d", payload: { userId: "222222222222222222", guildId: "111111111111111111" } }]);
  assert.deepEqual(plain(resolutions), [{ channelId: "777777777777777777", ids: [messageId] }]);
});

test("timeout action rejects stale author identity and deduplicates concurrent requests", async () => {
  const harness = backgroundHarness();
  const messageId = "888888888888888881";
  const sender = discordSender({
    tab: { id: 3, url: "https://discord.com/channels/111111111111111111/777777777777777777" },
    documentId: "document-3"
  });
  harness.setLocation(sender.tab.url);
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let invocations = 0;
  harness.setMainController({
    resolveMessageAuthors() { return { ok: true, authors: [{ messageId, userId: "333333333333333333" }] }; },
    invokeUserAction() { invocations += 1; return blocked; }
  });
  const stale = await harness.api.handleUserAction({
    type: "LDMA_USER_ACTION", action: "timeout-7d", userId: "222222222222222222",
    guildId: "111111111111111111", messageId
  }, sender);
  assert.deepEqual(plain(stale), { ok: false, reason: "message-author-mismatch" });
  assert.equal(invocations, 0);

  harness.setMainController({
    resolveMessageAuthors() { return { ok: true, authors: [{ messageId, userId: "222222222222222222" }] }; },
    invokeUserAction() { invocations += 1; return blocked; }
  });
  const command = {
    type: "LDMA_USER_ACTION", action: "timeout-7d", userId: "222222222222222222",
    guildId: "111111111111111111", messageId
  };
  const first = harness.api.handleUserAction(command, sender);
  await new Promise((resolve) => setImmediate(resolve));
  const duplicate = await harness.api.handleUserAction(command, sender);
  assert.deepEqual(plain(duplicate), { ok: false, reason: "timeout-already-in-progress" });
  assert.equal(invocations, 1);
  release({ ok: true, reason: "timed-out-7d" });
  assert.equal((await first).ok, true);
  assert.equal(harness.api.timeoutActionsInFlight.size, 0);
});

test("timeout action uses an exact deleted archive identity when MessageStore no longer has the message", async () => {
  const harness = backgroundHarness();
  const channelId = "777777777777777777";
  const messageId = "888888888888888881";
  const userId = "222222222222222222";
  const guildId = "111111111111111111";
  harness.setStoredArchive({
    generation: 2,
    records: [{ channelId, messageId, authorId: userId, status: "confirmed_deleted" }]
  });
  const pageUrl = "https://discord.com/channels/" + guildId + "/" + channelId;
  harness.setLocation(pageUrl);
  const invocations = [];
  harness.setMainController({
    resolveMessageAuthors() { return { ok: true, authors: [] }; },
    invokeUserAction(action, payload) {
      invocations.push({ action, payload });
      return { ok: true, reason: "timed-out-7d" };
    }
  });
  const sender = discordSender({
    tab: { id: 7, url: pageUrl },
    documentId: "document-7"
  });
  const result = await harness.api.handleUserAction({
    type: "LDMA_USER_ACTION", action: "timeout-7d", userId, guildId, messageId
  }, sender);
  assert.deepEqual(plain(result), { ok: true, reason: "timed-out-7d" });
  assert.deepEqual(plain(invocations), [{
    action: "timeout-7d",
    payload: { userId, guildId }
  }]);
  const mismatch = await harness.api.handleUserAction({
    type: "LDMA_USER_ACTION",
    action: "timeout-7d",
    userId: "222222222222222223",
    guildId,
    messageId
  }, sender);
  assert.deepEqual(plain(mismatch), { ok: false, reason: "message-author-mismatch" });
  assert.equal(invocations.length, 1);
});

test("message author resolution is document-bound, route-bound, and returns only sanitized requested identities", async () => {
  const harness = backgroundHarness();
  const requested = [];
  const channelId = "777777777777777777";
  const firstMessageId = "888888888888888881";
  const secondMessageId = "888888888888888882";
  harness.setLocation(`https://discord.com/channels/111111111111111111/${channelId}`);
  harness.setMainController({
    resolveMessageAuthors(receivedChannelId, ids, fallbackUsers) {
      requested.push({ receivedChannelId, ids, fallbackUsers });
      return {
        ok: true,
        authors: [
          { messageId: firstMessageId, userId: "999999999999999991", username: "curiousbro", content: "must-not-cross" },
          { messageId: secondMessageId, userId: "not-a-snowflake" },
          { messageId: "888888888888888899", userId: "999999999999999999" }
        ],
        secret: "must-not-cross"
      };
    }
  });
  const sender = discordSender({
    tab: { id: 6, url: `https://discord.com/channels/111111111111111111/${channelId}` },
    documentId: "document-6"
  });
  const result = await harness.api.handleResolveMessageAuthors({
    type: "LDMA_RESOLVE_MESSAGE_AUTHORS",
    messageIds: [firstMessageId, secondMessageId]
  }, sender);
  assert.deepEqual(plain(result), {
    ok: true,
    reason: "message-authors-resolved",
    authors: [{ messageId: firstMessageId, userId: "999999999999999991", username: "curiousbro" }]
  });
  assert.deepEqual(plain(requested), [{
    receivedChannelId: channelId,
    ids: [firstMessageId, secondMessageId],
    fallbackUsers: []
  }]);
  const call = harness.calls.at(-1);
  assert.equal(call.options.world, "MAIN");
  assert.deepEqual(Array.from(call.options.target.documentIds), ["document-6"]);
});

test("message author resolution repairs a missing page controller and retries the same copy request", async () => {
  const harness = backgroundHarness();
  const channelId = "777777777777777777";
  const messageId = "888888888888888881";
  const userId = "999999999999999991";
  const pageUrl = `https://discord.com/channels/111111111111111111/${channelId}`;
  harness.setLocation(pageUrl);
  harness.setPageHookFileInstallController({
    apiVersion: 3,
    recover() {},
    invokeUserAction() { return { ok: true }; },
    resolveMessageAuthors() {
      return { ok: true, reason: "resolved", authors: [{ messageId, userId, username: "curiousbro" }] };
    }
  });
  const result = await harness.api.handleResolveMessageAuthors({
    type: "LDMA_RESOLVE_MESSAGE_AUTHORS",
    messageIds: [messageId]
  }, discordSender({ tab: { id: 19, url: pageUrl }, documentId: "document-19" }));
  assert.deepEqual(plain(result), {
    ok: true,
    reason: "message-authors-resolved",
    authors: [{ messageId, userId, username: "curiousbro" }]
  });
  const resolverCalls = harness.calls.filter((call) =>
    typeof call.options.func === "function" && /author-resolution-controller-unavailable/.test(String(call.options.func)));
  assert.equal(resolverCalls.length, 2);
  assert.equal(harness.calls.some((call) => call.kind === "reload"), false);
});

test("direct-message author resolution uses the exact @me channel route", async () => {
  const harness = backgroundHarness();
  const channelId = "777777777777777777";
  const messageId = "888888888888888881";
  const userId = "999999999999999991";
  const pageUrl = `https://discord.com/channels/@me/${channelId}`;
  harness.setLocation(pageUrl);
  const received = [];
  harness.setMainController({
    resolveMessageAuthors(receivedChannelId, ids, fallbackUsers) {
      received.push({ receivedChannelId, ids, fallbackUsers });
      return {
        ok: true,
        reason: "resolved",
        authors: [{ messageId, userId, username: "curiousbro" }]
      };
    }
  });
  const result = await harness.api.handleResolveMessageAuthors({
    type: "LDMA_RESOLVE_MESSAGE_AUTHORS",
    messageIds: [messageId]
  }, discordSender({ tab: { id: 16, url: pageUrl }, documentId: "document-16" }));
  assert.deepEqual(plain(result), {
    ok: true,
    reason: "message-authors-resolved",
    authors: [{ messageId, userId, username: "curiousbro" }]
  });
  assert.deepEqual(plain(received), [{ receivedChannelId: channelId, ids: [messageId], fallbackUsers: [] }]);
  assert.equal(harness.calls.at(-1).options.args[1].guildId, null);
});

test("deleted message username resolution receives only the exact trusted archive author fallback", async () => {
  const harness = backgroundHarness();
  const guildId = "111111111111111111";
  const channelId = "777777777777777777";
  const messageId = "888888888888888881";
  const seenMessageId = "888888888888888882";
  const userId = "999999999999999991";
  harness.setStoredArchive({
    generation: 3,
    records: [
      { channelId, messageId, authorId: userId, authorUsername: "curiousbro", status: "confirmed_deleted" },
      { channelId, messageId: seenMessageId, authorId: "999999999999999992", status: "seen" }
    ]
  });
  const pageUrl = "https://discord.com/channels/" + guildId + "/" + channelId;
  harness.setLocation(pageUrl);
  const received = [];
  harness.setMainController({
    resolveMessageAuthors(receivedChannelId, ids, fallbackUsers) {
      received.push({ receivedChannelId, ids, fallbackUsers });
      return { ok: true, authors: [{ messageId, userId, username: "curiousbro" }] };
    }
  });
  const result = await harness.api.handleResolveMessageAuthors({
    type: "LDMA_RESOLVE_MESSAGE_AUTHORS",
    messageIds: [messageId, seenMessageId]
  }, discordSender({ tab: { id: 8, url: pageUrl }, documentId: "document-8" }));
  assert.deepEqual(plain(result), {
    ok: true,
    reason: "message-authors-resolved",
    authors: [{ messageId, userId, username: "curiousbro" }]
  });
  assert.deepEqual(plain(received), [{
    receivedChannelId: channelId,
    ids: [messageId, seenMessageId],
    fallbackUsers: [{ messageId, userId, username: "curiousbro" }]
  }]);
});

test("message author resolution preserves safe username-stage diagnostics", async () => {
  const harness = backgroundHarness();
  const channelId = "777777777777777777";
  const messageId = "888888888888888881";
  const userId = "999999999999999991";
  const pageUrl = `https://discord.com/channels/111111111111111111/${channelId}`;
  harness.setLocation(pageUrl);
  harness.setMainController({
    resolveMessageAuthors() {
      return {
        ok: true,
        reason: "resolved-author-ids-only",
        authors: [{ messageId, userId }]
      };
    }
  });
  const result = await harness.api.handleResolveMessageAuthors({
    type: "LDMA_RESOLVE_MESSAGE_AUTHORS",
    messageIds: [messageId]
  }, discordSender({ tab: { id: 18, url: pageUrl }, documentId: "document-18" }));
  assert.deepEqual(plain(result), {
    ok: true,
    reason: "message-usernames-unavailable",
    authors: [{ messageId, userId }]
  });
});

test("message author resolution rejects malformed, untrusted, and route-stale requests", async () => {
  const harness = backgroundHarness();
  const valid = { type: "LDMA_RESOLVE_MESSAGE_AUTHORS", messageIds: ["888888888888888881"] };
  assert.equal((await harness.api.handleResolveMessageAuthors(valid, discordSender({ frameId: 1 }))).reason,
    "untrusted-author-resolution-sender");
  assert.equal((await harness.api.handleResolveMessageAuthors({ ...valid, messageIds: ["bad"] }, discordSender())).reason,
    "invalid-message-ids");
  assert.equal((await harness.api.handleResolveMessageAuthors({ ...valid, messageIds: [valid.messageIds[0], valid.messageIds[0]] }, discordSender())).reason,
    "invalid-message-ids");
  harness.setLocation("https://discord.com/channels/@me/888888888888888888");
  harness.setMainController({ resolveMessageAuthors() { throw new Error("must not run"); } });
  const changed = await harness.api.handleResolveMessageAuthors(valid, discordSender());
  assert.deepEqual(plain(changed), { ok: false, reason: "message-author-resolution-failed", authors: [] });
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
