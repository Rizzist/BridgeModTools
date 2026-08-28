"use strict";

importScripts("core.js", "protocol.js", "media-store.js");

const Protocol = globalThis.LocalDiscordArchiveProtocol;
const Core = globalThis.LocalDiscordArchiveCore;
const MediaStore = globalThis.BridgeModToolsMediaStore;
const STORAGE_KEY = "ldmaArchive";
const ports = new Set();
let brokerQueue = Promise.resolve();
let mediaQueue = Promise.resolve();
let mediaMetadataQueue = Promise.resolve();
let archiveCache = null;
let creatingOffscreen = null;
const playbackCapabilities = new Map();
const BOOTSTRAP_COMMAND = "LDMA_ENSURE_BOOTSTRAP";
const REPORT_LIVE_HEALTH = "LDMA_REPORT_LIVE_HEALTH";
const GET_LIVE_HEALTH = "LDMA_GET_LIVE_HEALTH";
const USER_ACTION_COMMAND = "LDMA_USER_ACTION";
const RESOLVE_MESSAGE_AUTHORS_COMMAND = "LDMA_RESOLVE_MESSAGE_AUTHORS";
const DISCORD_TAB_PATTERN = "https://discord.com/*";
const bootstrapJobs = new Map();
const liveHealthByDocument = new Map();
const userActionRateLimits = new Map();
const timeoutActionsInFlight = new Set();
const USER_ACTION_RATE_WINDOW_MS = 10000;
const USER_ACTION_RATE_MAX = 8;
const USER_ACTION_RATE_BUCKET_MAX = 500;
const SNOWFLAKE_PATTERN = /^\d{15,25}$/;

function injectionTarget(tabId, documentId) {
  if (!Number.isInteger(tabId) || !documentId) return null;
  return { tabId, documentIds: [documentId] };
}

async function ensureDiscordBootstrap(tabId, documentId, full) {
  const target = injectionTarget(tabId, documentId);
  if (!target) return { ok: false, reason: "invalid-bootstrap-target" };
  const key = `${tabId}:${documentId || "top"}:${full ? "full" : "hook"}`;
  if (bootstrapJobs.has(key)) return bootstrapJobs.get(key);
  const operation = (async () => {
    await chrome.scripting.executeScript({
      target,
      files: ["src/page-hook.js"],
      world: "MAIN",
      injectImmediately: true
    });
    if (full) {
      const probe = await chrome.scripting.executeScript({
        target,
        world: "ISOLATED",
        func() {
          const controller = globalThis[Symbol.for("BridgeModTools.contentScript.v1")];
          const contentInstalled = Boolean(controller && typeof controller.recover === "function");
          if (contentInstalled) controller.recover("background-bootstrap");
          return {
            contentInstalled,
            styleInstalled: globalThis[Symbol.for("BridgeModTools.contentStyle.v1")] === true
          };
        }
      });
      const state = probe.find((result) => result && result.result)?.result || {};
      if (!state.styleInstalled) {
        await chrome.scripting.insertCSS({ target, files: ["src/content.css"] });
        await chrome.scripting.executeScript({
          target,
          world: "ISOLATED",
          func() {
            globalThis[Symbol.for("BridgeModTools.contentStyle.v1")] = true;
          }
        });
      }
      if (!state.contentInstalled) {
        await chrome.scripting.executeScript({
          target,
          files: ["src/core.js", "src/protocol.js", "src/content.js"],
          world: "ISOLATED"
        });
      }
    }
    return { ok: true, reason: full ? "document-bootstrap-ensured" : "page-hook-ensured" };
  })().catch((error) => ({
    ok: false,
    reason: "bootstrap-injection-failed",
    error: String(error && error.message || error)
  })).finally(() => bootstrapJobs.delete(key));
  bootstrapJobs.set(key, operation);
  return operation;
}

async function bootstrapOpenDiscordTabs() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: [DISCORD_TAB_PATTERN] }); } catch (_error) {}
  await Promise.allSettled(tabs.filter((tab) => Number.isInteger(tab.id))
    .map((tab) => bootstrapDiscordTab(tab.id, true)));
}

async function reloadOpenDiscordTabs() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: [DISCORD_TAB_PATTERN] }); } catch (_error) {}
  await Promise.allSettled(tabs.filter((tab) => Number.isInteger(tab.id))
    .map((tab) => chrome.tabs.reload(tab.id)));
}

async function bootstrapDiscordTab(tabId, full) {
  if (!Number.isInteger(tabId)) return { ok: false, reason: "invalid-bootstrap-tab" };
  let frame;
  try { frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 }); } catch (_error) {}
  if (!frame?.documentId) return { ok: false, reason: "discord-document-unavailable" };
  try {
    const url = new URL(String(frame.url || ""));
    if (url.protocol !== "https:" || url.hostname !== "discord.com" || url.port !== "") {
      return { ok: false, reason: "not-discord-document" };
    }
  } catch (_error) {
    return { ok: false, reason: "invalid-document-url" };
  }
  return ensureDiscordBootstrap(tabId, frame.documentId, full);
}

function mutateMediaMetadata(operation) {
  mediaMetadataQueue = mediaMetadataQueue.catch(() => undefined).then(operation);
  return mediaMetadataQueue;
}

async function readArchive() {
  if (archiveCache) return archiveCache;
  const value = await chrome.storage.local.get(STORAGE_KEY);
  archiveCache = Protocol.normalizeArchive(value[STORAGE_KEY]);
  await MediaStore.setGeneration(archiveCache.generation);
  return archiveCache;
}

async function writeArchive(archive) {
  await chrome.storage.local.set({ [STORAGE_KEY]: archive });
  archiveCache = archive;
}

async function closeOffscreen() {
  if (creatingOffscreen) {
    try { await creatingOffscreen; } catch (_error) {}
  }
  try {
    if (await offscreenExists()) await chrome.offscreen.closeDocument();
  } catch (_error) {}
}

function broadcast(result) {
  const message = {
    type: "LDMA_ARCHIVE_CHANGED",
    generation: result.archive.generation,
    paused: result.archive.paused,
    reason: result.reason
  };
  for (const port of [...ports]) {
    try { port.postMessage(message); } catch (_error) { ports.delete(port); }
  }
}

function broadcastMedia(summary) {
  for (const port of [...ports]) {
    try { port.postMessage({ type: "LDMA_MEDIA_CHANGED", summary: summary || null }); }
    catch (_error) { ports.delete(port); }
  }
}

async function reconcileMediaUnlocked(command, archive) {
  if (!MediaStore) return;
  if (command.type === Protocol.TYPES.CLEAR_ARCHIVE) {
    await MediaStore.clearAll();
    broadcastMedia({ cleared: true });
    return;
  }
  const recordMutations = new Set([
    Protocol.TYPES.UPSERT_RECORDS,
    Protocol.TYPES.CONFIRM_EDIT,
    Protocol.TYPES.CONFIRM_DELETED,
    Protocol.TYPES.INFER_DELETED,
    Protocol.TYPES.RETRACT_MESSAGE,
    Protocol.TYPES.DELETE_RECORD
  ]);
  if (recordMutations.has(command.type)) {
    await MediaStore.reconcileArchive(archive.records, { generation: archive.generation });
  }
}

function dispatch(command) {
  brokerQueue = brokerQueue.catch(() => undefined).then(async () => {
    const current = await readArchive();
    const result = Protocol.applyCommand(current, command);
    if (result.changed) {
      await mutateMediaMetadata(async () => {
        await writeArchive(result.archive);
        if (result.archive.generation !== current.generation) {
          // Invalidate offscreen download leases before any destructive media
          // cleanup. A late old-generation job can no longer resurrect bytes.
          await MediaStore.setGeneration(result.archive.generation);
          // Terminating the sole downloader closes the tiny CacheStorage/IDB
          // commit window too; a killed old-generation document cannot put a
          // body after clear/delete/pause has returned.
          await closeOffscreen();
        }
        await reconcileMediaUnlocked(command, result.archive);
      });
      broadcast(result);
    }
    const singleRecordRead = command && command.type === Protocol.TYPES.GET_RECORD;
    return {
      ok: result.accepted,
      reason: result.reason,
      archive: singleRecordRead ? undefined : result.data || result.archive,
      record: singleRecordRead ? result.data : undefined,
      generation: result.archive.generation
    };
  });
  return brokerQueue;
}

async function offscreenExists() {
  const documentUrl = chrome.runtime.getURL("media/offscreen.html");
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [documentUrl]
    });
    return contexts.length > 0;
  }
  const clients = await self.clients.matchAll();
  return clients.some((client) => client.url === documentUrl);
}

async function ensureOffscreen() {
  if (await offscreenExists()) return;
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = chrome.offscreen.createDocument({
    url: "media/offscreen.html",
    reasons: ["BLOBS"],
    justification: "Download rendered Discord media into the extension-owned local cache."
  }).catch(async (error) => {
    if (!await offscreenExists()) throw error;
  }).finally(() => { creatingOffscreen = null; });
  return creatingOffscreen;
}

function mediaRefs(records, generation) {
  const refs = [];
  for (const record of Array.isArray(records) ? records : []) {
    const ownerKey = Core.recordKey(record);
    const deleted = Core.isDeletedStatus(record.status) || Core.hasEdits(record);
    for (const version of [record, ...(record.editHistory || [])]) {
      for (const media of Core.sanitizeMediaItems(version.media)) {
        if (MediaStore.fetchableMedia(media)) refs.push({ ownerKey, deleted, generation, media });
        if (media.posterUrl) refs.push({
          ownerKey,
          deleted,
          generation,
          media: {
            url: media.posterUrl,
            kind: "image",
            source: "embed",
            name: `${media.name || "Video"} preview`,
            cacheable: true,
            spoiler: media.spoiler
          }
        });
      }
    }
  }
  return refs;
}

async function hasOriginPermission(url) {
  const origin = MediaStore.permissionOrigin(url);
  if (!origin) return false;
  return chrome.permissions.contains({ origins: [`${origin}/*`] });
}

async function cacheArchiveRecords(records, force) {
  const archive = await readArchive();
  const refs = mediaRefs(records, archive.generation);
  if (!refs.length) return { cached: 0, failed: 0, ignored: 0, bytes: 0 };
  const permissionByOrigin = new Map();
  for (const ref of refs) {
    const origin = MediaStore.permissionOrigin(ref.media.url);
    if (origin && !permissionByOrigin.has(origin)) permissionByOrigin.set(origin, hasOriginPermission(ref.media.url));
  }
  for (const [origin, pending] of permissionByOrigin) permissionByOrigin.set(origin, await pending);
  let allowed = refs.filter((ref) => permissionByOrigin.get(MediaStore.permissionOrigin(ref.media.url)));
  const denied = refs.filter((ref) => !permissionByOrigin.get(MediaStore.permissionOrigin(ref.media.url)));
  if (denied.length) await mutateMediaMetadata(() => MediaStore.markPermissionRequired(denied));
  allowed = await MediaStore.refsNeedingCache(allowed, { force: Boolean(force) });
  let summary = { cached: 0, failed: 0, ignored: 0, bytes: 0, permissionRequired: denied.length };
  for (const ref of allowed) {
    const reserved = await mutateMediaMetadata(async () => {
      const current = await readArchive();
      if (current.generation !== ref.generation) return false;
      await MediaStore.prune({
        generation: current.generation,
        maxTotalBytes: MediaStore.DEFAULT_LIMITS.maxTotalBytes - MediaStore.DEFAULT_LIMITS.maxAssetBytes,
        maxAssets: MediaStore.DEFAULT_LIMITS.maxAssets - 1
      });
      return true;
    });
    if (!reserved) { summary.ignored += 1; continue; }
    await ensureOffscreen();
    let result;
    try {
      result = await chrome.runtime.sendMessage({
        target: "ldma-offscreen-media",
        type: "CACHE_REFS",
        refs: [ref],
        force: Boolean(force)
      });
    } catch (_error) {
      summary.ignored += 1;
      continue;
    }
    if (result?.ok && result.summary) {
      summary.cached += Number(result.summary.cached) || 0;
      summary.failed += Number(result.summary.failed) || 0;
      summary.ignored += Number(result.summary.ignored) || 0;
      summary.bytes += Number(result.summary.bytes) || 0;
    }
    await mutateMediaMetadata(async () => {
      const current = await readArchive();
      await MediaStore.reconcileArchive(current.records, { generation: current.generation });
    });
  }
  await mutateMediaMetadata(async () => {
    const current = await readArchive();
    await MediaStore.reconcileArchive(current.records, { generation: current.generation });
  });
  broadcastMedia(summary);
  return summary;
}

function scheduleMediaRecovery(records) {
  mediaQueue = mediaQueue.catch(() => undefined).then(() => cacheArchiveRecords(records, false));
  return mediaQueue;
}

function extensionSenderPath(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return null;
  try {
    const url = new URL(String(sender.url || ""));
    return url.protocol === "chrome-extension:" && url.hostname === chrome.runtime.id && url.port === ""
      ? url.pathname
      : null;
  } catch (_error) { return null; }
}

function popupSender(sender) {
  return extensionSenderPath(sender) === "/popup/popup.html";
}

function historySender(sender) {
  return extensionSenderPath(sender) === "/history/history.html";
}

function mediaViewerSender(sender) {
  return extensionSenderPath(sender) === "/media/view.html" && Number.isInteger(sender.frameId) && sender.frameId > 0;
}

function discordContentSender(sender) {
  if (sender?.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id) ||
    sender.tab.id < 0 || typeof sender.documentId !== "string" || !sender.documentId ||
    sender.origin !== "https://discord.com" || sender.frameId !== 0) return false;
  try {
    const url = new URL(String(sender.url || ""));
    return url.protocol === "https:" && url.hostname === "discord.com" && url.port === "";
  } catch (_error) {
    return false;
  }
}

function discordChannelContentSender(sender) {
  if (!discordContentSender(sender)) return false;
  try {
    const url = new URL(String(sender.tab.url || ""));
    return url.protocol === "https:" && url.hostname === "discord.com" && url.port === "" &&
      /^\/channels\/[^/]+\/[^/?#]+/.test(url.pathname);
  } catch (_error) {
    return false;
  }
}

function discordChannelContext(sender) {
  if (!discordContentSender(sender)) return null;
  try {
    const url = new URL(String(sender.tab.url || ""));
    if (url.protocol !== "https:" || url.hostname !== "discord.com" || url.port !== "") return null;
    const match = /^\/channels\/(@me|\d{15,25})\/(\d{15,25})\/?$/.exec(url.pathname);
    if (!match) return null;
    return {
      guildId: match[1] === "@me" ? null : match[1],
      channelId: match[2]
    };
  } catch (_error) {
    return null;
  }
}

function consumeUserActionRateLimit(sender) {
  const now = Date.now();
  for (const [key, item] of userActionRateLimits) {
    if (!item || item.resetAt <= now) userActionRateLimits.delete(key);
  }
  const key = `${sender.tab.id}:${sender.documentId}`;
  let bucket = userActionRateLimits.get(key);
  if (!bucket) {
    while (userActionRateLimits.size >= USER_ACTION_RATE_BUCKET_MAX) {
      userActionRateLimits.delete(userActionRateLimits.keys().next().value);
    }
    bucket = { count: 0, resetAt: now + USER_ACTION_RATE_WINDOW_MS };
    userActionRateLimits.set(key, bucket);
  }
  if (bucket.count >= USER_ACTION_RATE_MAX) return false;
  bucket.count += 1;
  return true;
}

function safeUserActionResult(value) {
  const ok = value?.ok === true;
  const reason = typeof value?.reason === "string"
    ? value.reason.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160)
    : "";
  return { ok, reason: reason || (ok ? "user-action-invoked" : "user-action-rejected") };
}

async function handleUserAction(command, sender) {
  const context = discordChannelContext(sender);
  if (!context) return { ok: false, reason: "untrusted-user-action-sender" };
  const action = command?.action;
  if (action !== "open-profile" && action !== "timeout-7d") {
    return { ok: false, reason: "unsupported-user-action" };
  }
  if (typeof command?.userId !== "string" || !SNOWFLAKE_PATTERN.test(command.userId)) {
    return { ok: false, reason: "invalid-user-id" };
  }
  if (action === "timeout-7d") {
    if (!context.guildId) return { ok: false, reason: "timeout-requires-guild" };
    if (typeof command?.guildId !== "string" || command.guildId !== context.guildId) {
      return { ok: false, reason: "guild-context-mismatch" };
    }
    if (typeof command?.messageId !== "string" || !SNOWFLAKE_PATTERN.test(command.messageId)) {
      return { ok: false, reason: "timeout-requires-message" };
    }
  }
  let archivedTimeoutAuthorId = null;
  if (action === "timeout-7d") {
    try {
      const archive = await readArchive();
      const key = `${context.channelId}:${command.messageId}`;
      const record = archive.records.find((candidate) => Core.recordKey(candidate) === key);
      if (record && Core.isDeletedStatus(record.status)) archivedTimeoutAuthorId = Core.snowflakeValue(record.authorId);
    } catch (_error) {}
    if (archivedTimeoutAuthorId && archivedTimeoutAuthorId !== command.userId) {
      return { ok: false, reason: "message-author-mismatch" };
    }
  }
  const timeoutActionKey = action === "timeout-7d" ? `${context.guildId}:${command.userId}` : null;
  if (timeoutActionKey && timeoutActionsInFlight.has(timeoutActionKey)) {
    return { ok: false, reason: "timeout-already-in-progress" };
  }
  if (!consumeUserActionRateLimit(sender)) return { ok: false, reason: "user-action-throttled" };
  if (timeoutActionKey) timeoutActionsInFlight.add(timeoutActionKey);

  const payload = {
    userId: command.userId,
    guildId: context.guildId,
    messageId: action === "timeout-7d" ? command.messageId : null
  };
  const expectedRoute = { guildId: context.guildId, channelId: context.channelId };
  let execution;
  try {
    execution = await chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, documentIds: [sender.documentId] },
      world: "MAIN",
      async func(actionName, actionPayload, route, trustedArchivedAuthorId) {
        try {
          const current = new URL(globalThis.location.href);
          const match = /^\/channels\/(@me|\d{15,25})\/(\d{15,25})\/?$/.exec(current.pathname);
          const currentGuildId = match && match[1] !== "@me" ? match[1] : null;
          if (current.protocol !== "https:" || current.hostname !== "discord.com" || current.port !== "" ||
            !match || currentGuildId !== route.guildId || match[2] !== route.channelId) {
            return { ok: false, reason: "user-action-route-changed" };
          }
          const controller = globalThis[Symbol.for("BridgeModTools.pageHook.v1")];
          if (!controller || typeof controller.invokeUserAction !== "function") {
            return { ok: false, reason: "user-action-controller-unavailable" };
          }
          let verifiedPayload = { userId: actionPayload.userId, guildId: actionPayload.guildId };
          if (actionName === "timeout-7d") {
            let resolvedUserId = null;
            if (typeof controller.resolveMessageAuthors === "function") {
              try {
                const resolution = await Promise.resolve(
                  controller.resolveMessageAuthors(route.channelId, [actionPayload.messageId]));
                const author = Array.isArray(resolution?.authors)
                  ? resolution.authors.find((item) => item?.messageId === actionPayload.messageId) : null;
                if (author?.userId && author.userId !== actionPayload.userId) {
                  return { ok: false, reason: "message-author-mismatch" };
                }
                if (resolution?.ok === true && author?.userId === actionPayload.userId) resolvedUserId = author.userId;
              } catch (_error) {}
            }
            if (!resolvedUserId && trustedArchivedAuthorId === actionPayload.userId) {
              resolvedUserId = trustedArchivedAuthorId;
            }
            if (!resolvedUserId) return { ok: false, reason: "message-author-resolution-unavailable" };
            verifiedPayload = { userId: resolvedUserId, guildId: actionPayload.guildId };
          }
          return Promise.resolve(controller.invokeUserAction(actionName, verifiedPayload)).then(
            (result) => ({
              ok: result?.ok === true,
              reason: typeof result?.reason === "string" ? result.reason : ""
            }),
            () => ({ ok: false, reason: "user-action-controller-error" })
          );
        } catch (_error) {
          return { ok: false, reason: "user-action-controller-error" };
        }
      },
      args: [action, payload, expectedRoute, archivedTimeoutAuthorId]
    });
  } catch (_error) {
    if (timeoutActionKey) timeoutActionsInFlight.delete(timeoutActionKey);
    return { ok: false, reason: "user-action-injection-failed" };
  }
  const result = Array.isArray(execution)
    ? execution.find((item) => item && Object.prototype.hasOwnProperty.call(item, "result"))?.result
    : null;
  if (timeoutActionKey) timeoutActionsInFlight.delete(timeoutActionKey);
  return safeUserActionResult(result);
}

function safeResolvedAuthors(value, requestedIds) {
  const requested = new Set(requestedIds);
  const authors = [];
  const seen = new Set();
  for (const item of Array.isArray(value?.authors) ? value.authors : []) {
    const messageId = typeof item?.messageId === "string" && SNOWFLAKE_PATTERN.test(item.messageId)
      ? item.messageId : null;
    const userId = typeof item?.userId === "string" && SNOWFLAKE_PATTERN.test(item.userId)
      ? item.userId : null;
    if (!messageId || !userId || !requested.has(messageId) || seen.has(messageId)) continue;
    seen.add(messageId);
    const username = Core.discordUsernameValue(item?.username);
    authors.push(Object.assign({ messageId, userId }, username ? { username } : {}));
  }
  const safeReasons = new Map([
    ["resolved", "message-authors-resolved"],
    ["resolved-from-trusted-archive", "message-authors-resolved-from-archive"],
    ["resolved-author-ids-only", "message-usernames-unavailable"],
    ["message-store-unavailable", "message-store-unavailable"]
  ]);
  return {
    ok: value?.ok === true,
    reason: value?.ok === true
      ? safeReasons.get(value?.reason) || "message-authors-resolved"
      : safeReasons.get(value?.reason) || "message-author-resolution-failed",
    authors
  };
}

async function handleResolveMessageAuthors(command, sender) {
  const context = discordChannelContext(sender);
  if (!context) return { ok: false, reason: "untrusted-author-resolution-sender", authors: [] };
  if (!Array.isArray(command?.messageIds) || command.messageIds.length < 1 || command.messageIds.length > 200) {
    return { ok: false, reason: "invalid-message-ids", authors: [] };
  }
  const messageIds = [...new Set(command.messageIds.map((value) =>
    typeof value === "string" && SNOWFLAKE_PATTERN.test(value) ? value : null).filter(Boolean))];
  if (!messageIds.length || messageIds.length !== command.messageIds.length) {
    return { ok: false, reason: "invalid-message-ids", authors: [] };
  }
  const expectedRoute = { guildId: context.guildId, channelId: context.channelId };
  let trustedFallbacks = [];
  try {
    const archive = await readArchive();
    const requested = new Set(messageIds);
    trustedFallbacks = archive.records.map((record) => {
      if (!Core.isDeletedStatus(record.status) || record.channelId !== context.channelId ||
        !requested.has(record.messageId)) return null;
      const userId = Core.snowflakeValue(record.authorId);
      if (!userId) return null;
      const username = Core.discordUsernameValue(record.authorUsername);
      return Object.assign({ messageId: record.messageId, userId }, username ? { username } : {});
    }).filter(Boolean);
  } catch (_error) {}
  let execution;
  try {
    execution = await chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, documentIds: [sender.documentId] },
      world: "MAIN",
      func(ids, route, fallbackUsers) {
        try {
          const current = new URL(globalThis.location.href);
          const match = /^\/channels\/(@me|\d{15,25})\/(\d{15,25})\/?$/.exec(current.pathname);
          const currentGuildId = match && match[1] !== "@me" ? match[1] : null;
          if (current.protocol !== "https:" || current.hostname !== "discord.com" || current.port !== "" ||
            !match || currentGuildId !== route.guildId || match[2] !== route.channelId) {
            return { ok: false, reason: "author-resolution-route-changed", authors: [] };
          }
          const controller = globalThis[Symbol.for("BridgeModTools.pageHook.v1")];
          if (!controller || typeof controller.resolveMessageAuthors !== "function") {
            return { ok: false, reason: "author-resolution-controller-unavailable", authors: [] };
          }
          return Promise.resolve(controller.resolveMessageAuthors(route.channelId, ids, fallbackUsers)).then(
            (result) => result,
            () => ({ ok: false, reason: "author-resolution-controller-error", authors: [] })
          );
        } catch (_error) {
          return { ok: false, reason: "author-resolution-controller-error", authors: [] };
        }
      },
      args: [messageIds, expectedRoute, trustedFallbacks]
    });
  } catch (_error) {
    return { ok: false, reason: "author-resolution-injection-failed", authors: [] };
  }
  const result = Array.isArray(execution)
    ? execution.find((item) => item && Object.prototype.hasOwnProperty.call(item, "result"))?.result
    : null;
  return safeResolvedAuthors(result, messageIds);
}

function documentHealthKey(sender) {
  return discordContentSender(sender) ? `${sender.tab.id}:${sender.documentId}` : null;
}

function pruneLiveHealth() {
  const now = Date.now();
  const cutoff = now - 45000;
  for (const [key, item] of liveHealthByDocument) {
    if (!Number.isFinite(item.updatedAt) || item.updatedAt < cutoff || item.updatedAt > now + 5000) {
      liveHealthByDocument.delete(key);
    }
  }
}

function broadcastLiveHealth() {
  for (const port of [...ports]) {
    try { port.postMessage({ type: "LDMA_LIVE_HEALTH_CHANGED" }); }
    catch (_error) { ports.delete(port); }
  }
}

function reportLiveHealth(command, sender) {
  const key = documentHealthKey(sender);
  const statuses = new Set(["active", "searching", "degraded", "starting", "inactive"]);
  if (!key || !statuses.has(command.status)) return { ok: false, reason: "untrusted-live-health" };
  if (command.status === "inactive") liveHealthByDocument.delete(key);
  else liveHealthByDocument.set(key, {
    status: command.status,
    detail: Core.normalizeText(command.detail).slice(0, 300) || "Discord capture status unavailable.",
    updatedAt: Date.now(),
    tabId: sender.tab.id,
    documentId: sender.documentId
  });
  pruneLiveHealth();
  broadcastLiveHealth();
  return { ok: true, reason: "live-health-updated" };
}

function bestLiveHealth() {
  pruneLiveHealth();
  const ranked = [...liveHealthByDocument.values()].sort((left, right) => {
    const leftRank = left.status === "active" ? 2 : 1;
    const rightRank = right.status === "active" ? 2 : 1;
    return rightRank - leftRank || right.updatedAt - left.updatedAt;
  });
  return ranked[0] || null;
}

function randomCapability() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function pruneCapabilities(nowValue) {
  const now = nowValue || Date.now();
  for (const [capability, item] of playbackCapabilities) {
    if (item.expiresAt <= now) playbackCapabilities.delete(capability);
  }
  while (playbackCapabilities.size > 500) playbackCapabilities.delete(playbackCapabilities.keys().next().value);
}

async function handlePlaybackCommand(command, sender) {
  pruneCapabilities();
  if (command.type === Protocol.TYPES.CREATE_MEDIA_CAPABILITY) {
    if (!discordChannelContentSender(sender) && !historySender(sender)) return { ok: false, reason: "untrusted-capability-issuer" };
    const key = String(command.key || "");
    if (!/^\d{15,25}:\d{15,25}$/.test(key)) return { ok: false, reason: "invalid-record-key" };
    const archive = await readArchive();
    if (!archive.records.some((record) => Core.recordKey(record) === key)) return { ok: false, reason: "record-missing" };
    const capability = randomCapability();
    const revisionId = command.revisionId == null ? null : Core.normalizeText(command.revisionId).slice(0, 160);
    const record = archive.records.find((candidate) => Core.recordKey(candidate) === key);
    if (revisionId && !record?.editHistory?.some((revision) => revision.revisionId === revisionId)) {
      return { ok: false, reason: "revision-missing" };
    }
    playbackCapabilities.set(capability, {
      key,
      revisionId,
      tabId: Number.isInteger(sender.tab?.id) ? sender.tab.id : null,
      expiresAt: Date.now() + 10 * 60 * 1000,
      boundDocumentId: null,
      boundFrameId: null
    });
    return { ok: true, capability };
  }
  if (command.type === Protocol.TYPES.REDEEM_MEDIA_CAPABILITY) {
    if (!mediaViewerSender(sender)) return { ok: false, reason: "untrusted-media-viewer" };
    const capability = String(command.capability || "");
    const item = playbackCapabilities.get(capability);
    if (!item || item.expiresAt <= Date.now()) return { ok: false, reason: "invalid-or-expired-capability" };
    const tabId = Number.isInteger(sender.tab?.id) ? sender.tab.id : null;
    if (item.tabId !== tabId) return { ok: false, reason: "capability-tab-mismatch" };
    if (item.boundDocumentId && item.boundDocumentId !== sender.documentId) return { ok: false, reason: "capability-document-mismatch" };
    if (item.boundFrameId !== null && item.boundFrameId !== sender.frameId) return { ok: false, reason: "capability-frame-mismatch" };
    item.boundDocumentId = sender.documentId || item.boundDocumentId;
    item.boundFrameId = sender.frameId;
    const archive = await readArchive();
    const record = archive.records.find((candidate) => Core.recordKey(candidate) === item.key) || null;
    const revision = item.revisionId && record?.editHistory?.find((candidate) => candidate.revisionId === item.revisionId);
    const playbackRecord = item.revisionId
      ? revision ? Object.assign({}, record, revision, { editHistory: [] }) : null
      : record;
    if (playbackRecord?.media?.length && !archive.paused) scheduleMediaRecovery([record]).catch(() => {});
    return {
      ok: Boolean(playbackRecord),
      reason: playbackRecord ? "capability-redeemed" : item.revisionId ? "revision-missing" : "record-missing",
      record: playbackRecord ? Core.sanitizeRecordPresentation(playbackRecord) : null
    };
  }
  return { ok: false, reason: "unknown-playback-command" };
}

function archiveCommandAllowed(command, sender) {
  const type = command && command.type;
  if (!type) return false;
  if (discordChannelContentSender(sender)) return new Set([
    Protocol.TYPES.UPSERT_RECORDS,
    Protocol.TYPES.CONFIRM_EDIT,
    Protocol.TYPES.CONFIRM_DELETED,
    Protocol.TYPES.INFER_DELETED,
    Protocol.TYPES.RETRACT_MESSAGE,
    Protocol.TYPES.SET_HEALTH
  ]).has(type);
  if (discordContentSender(sender)) return type === Protocol.TYPES.GET_ARCHIVE;
  if (popupSender(sender)) return new Set([
    Protocol.TYPES.GET_ARCHIVE,
    Protocol.TYPES.SET_PAUSED,
    Protocol.TYPES.CLEAR_ARCHIVE
  ]).has(type);
  if (historySender(sender)) return new Set([
    Protocol.TYPES.GET_ARCHIVE,
    Protocol.TYPES.DELETE_RECORD,
    Protocol.TYPES.CLEAR_ARCHIVE
  ]).has(type);
  return false;
}

function handleMediaCommand(command, sender) {
  mediaQueue = mediaQueue.catch(() => undefined).then(async () => {
    const archive = await readArchive();
    if (command.type === Protocol.TYPES.GET_MEDIA_STATS) {
      if (!popupSender(sender)) return { ok: false, reason: "untrusted-media-sender" };
      const stats = await MediaStore.getStats();
      let archiveBytes = 0;
      try {
        archiveBytes = Math.max(0, Number(await chrome.storage.local.getBytesInUse(STORAGE_KEY)) || 0);
      } catch (_error) {}
      const mediaBytes = Math.max(0, Number(stats?.bytes) || 0);
      return {
        ok: true,
        stats: Object.assign({}, stats, {
          bytes: mediaBytes,
          archiveBytes,
          totalBytes: mediaBytes + archiveBytes
        })
      };
    }
    if (command.type === Protocol.TYPES.CACHE_MEDIA) {
      if (!discordChannelContentSender(sender)) return { ok: false, reason: "untrusted-media-sender" };
      if (archive.paused || command.generation !== archive.generation) return { ok: false, reason: "stale-or-paused" };
      const keys = new Set((Array.isArray(command.keys) ? command.keys : []).map(String).slice(0, 200));
      const records = archive.records.filter((record) => keys.has(Core.recordKey(record)));
      return { ok: true, summary: await cacheArchiveRecords(records) };
    }
    if (command.type === Protocol.TYPES.CACHE_ALL_MEDIA) {
      if (!popupSender(sender) && !historySender(sender)) return { ok: false, reason: "untrusted-media-sender" };
      return { ok: true, summary: await cacheArchiveRecords(archive.records, popupSender(sender)) };
    }
    return { ok: false, reason: "unknown-media-command" };
  });
  return mediaQueue;
}

chrome.runtime.onMessage.addListener((command, sender, sendResponse) => {
  if (command && command.target === "ldma-offscreen-media") return false;
  const mediaTypes = new Set([
    Protocol.TYPES.CACHE_MEDIA,
    Protocol.TYPES.CACHE_ALL_MEDIA,
    Protocol.TYPES.GET_MEDIA_STATS
  ]);
  const playbackTypes = new Set([
    Protocol.TYPES.CREATE_MEDIA_CAPABILITY,
    Protocol.TYPES.REDEEM_MEDIA_CAPABILITY
  ]);
  let operation;
  if (command?.type === REPORT_LIVE_HEALTH) {
    operation = Promise.resolve(reportLiveHealth(command, sender));
  } else if (command?.type === GET_LIVE_HEALTH && popupSender(sender)) {
    operation = Promise.resolve({ ok: true, reason: "live-health-read", health: bestLiveHealth() });
  } else if (command?.type === USER_ACTION_COMMAND) {
    operation = handleUserAction(command, sender);
  } else if (command?.type === RESOLVE_MESSAGE_AUTHORS_COMMAND) {
    operation = handleResolveMessageAuthors(command, sender);
  } else if (command?.type === BOOTSTRAP_COMMAND && discordContentSender(sender)) {
    operation = ensureDiscordBootstrap(sender.tab.id, sender.documentId || null, true);
  } else if (playbackTypes.has(command && command.type)) operation = handlePlaybackCommand(command, sender);
  else if (mediaTypes.has(command && command.type)) operation = handleMediaCommand(command, sender);
  else if (archiveCommandAllowed(command, sender)) operation = dispatch(command);
  else operation = Promise.resolve({ ok: false, reason: "untrusted-command-sender" });
  operation.then(sendResponse).catch((error) => {
    sendResponse({ ok: false, reason: "broker-error", error: String(error && error.message || error) });
  });
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ldma-updates") return;
  if (!discordContentSender(port.sender) && !popupSender(port.sender) && !historySender(port.sender) && !mediaViewerSender(port.sender)) return;
  ports.add(port);
  const healthKey = documentHealthKey(port.sender);
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    if (healthKey && liveHealthByDocument.delete(healthKey)) broadcastLiveHealth();
  });
});

function bootstrapNavigation(details, full) {
  if (details.frameId !== 0 || !Number.isInteger(details.tabId)) return;
  ensureDiscordBootstrap(details.tabId, details.documentId || null, Boolean(full)).catch(() => {});
}

chrome.webNavigation.onCommitted.addListener((details) => bootstrapNavigation(details, false), {
  url: [{ schemes: ["https"], hostEquals: "discord.com" }]
});
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => bootstrapNavigation(details, true), {
  url: [{ schemes: ["https"], hostEquals: "discord.com" }]
});
chrome.webNavigation.onTabReplaced.addListener((details) => {
  bootstrapDiscordTab(details.tabId, true).catch(() => {});
});
chrome.tabs.onActivated.addListener((details) => {
  bootstrapDiscordTab(details.tabId, true).catch(() => {});
});
chrome.runtime.onInstalled.addListener((details) => {
  // A MAIN-world controller belongs to the JavaScript bundle version that
  // installed it and cannot be safely replaced in place. Extension updates are
  // rare, so reload each open Discord document once automatically; ordinary
  // Discord launches and SPA route changes never require a reload.
  if (details.reason === "update") reloadOpenDiscordTabs().catch(() => {});
  else bootstrapOpenDiscordTabs().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => { bootstrapOpenDiscordTabs().catch(() => {}); });
