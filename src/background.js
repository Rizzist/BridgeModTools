"use strict";

importScripts("core.js", "protocol.js");

const Protocol = globalThis.LocalDiscordArchiveProtocol;
const STORAGE_KEY = "ldmaArchive";
const ports = new Set();
let brokerQueue = Promise.resolve();
let archiveCache = null;

async function readArchive() {
  if (archiveCache) return archiveCache;
  const value = await chrome.storage.local.get(STORAGE_KEY);
  archiveCache = Protocol.normalizeArchive(value[STORAGE_KEY]);
  return archiveCache;
}

async function writeArchive(archive) {
  await chrome.storage.local.set({ [STORAGE_KEY]: archive });
  archiveCache = archive;
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

function dispatch(command) {
  brokerQueue = brokerQueue.catch(() => undefined).then(async () => {
    const current = await readArchive();
    const result = Protocol.applyCommand(current, command);
    if (result.changed) {
      await writeArchive(result.archive);
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

chrome.runtime.onMessage.addListener((command, _sender, sendResponse) => {
  dispatch(command).then(sendResponse).catch((error) => {
    sendResponse({ ok: false, reason: "broker-error", error: String(error && error.message || error) });
  });
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ldma-updates") return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
});
