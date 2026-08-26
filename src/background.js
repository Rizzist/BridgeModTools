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

function senderPath(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return null;
  try { return new URL(String(sender.url || "")).pathname; } catch (_error) { return null; }
}

function popupSender(sender) {
  return senderPath(sender) === "/popup/popup.html";
}

function historySender(sender) {
  return senderPath(sender) === "/history/history.html";
}

function mediaViewerSender(sender) {
  return senderPath(sender) === "/media/view.html" && Number.isInteger(sender.frameId) && sender.frameId > 0;
}

function discordContentSender(sender) {
  const value = String(sender?.url || "");
  return sender?.id === chrome.runtime.id && /^https:\/\/discord\.com\/channels\//.test(value);
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
    if (!discordContentSender(sender) && !historySender(sender)) return { ok: false, reason: "untrusted-capability-issuer" };
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
  if (discordContentSender(sender)) return new Set([
    Protocol.TYPES.GET_ARCHIVE,
    Protocol.TYPES.UPSERT_RECORDS,
    Protocol.TYPES.CONFIRM_EDIT,
    Protocol.TYPES.CONFIRM_DELETED,
    Protocol.TYPES.INFER_DELETED,
    Protocol.TYPES.RETRACT_MESSAGE,
    Protocol.TYPES.SET_HEALTH
  ]).has(type);
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
      return { ok: true, stats: await MediaStore.getStats() };
    }
    if (command.type === Protocol.TYPES.CACHE_MEDIA) {
      if (!discordContentSender(sender)) return { ok: false, reason: "untrusted-media-sender" };
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
  if (playbackTypes.has(command && command.type)) operation = handlePlaybackCommand(command, sender);
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
  port.onDisconnect.addListener(() => ports.delete(port));
});
