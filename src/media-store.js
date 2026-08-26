(function attachMediaStore(root) {
  "use strict";

  const Core = root.LocalDiscordArchiveCore || (typeof require === "function" ? require("./core.js") : null);
  const DB_NAME = "BridgeModToolsMedia";
  const DB_VERSION = 2;
  const STORE_NAME = "assets";
  const META_STORE = "meta";
  const GENERATION_KEY = "archive-generation";
  const CACHE_NAME = "bridge-mod-tools-media-v1";
  const DEFAULT_LIMITS = Object.freeze({
    maxAssetBytes: 32 * 1024 * 1024,
    maxTotalBytes: 512 * 1024 * 1024,
    maxAssets: 1000,
    timeoutMs: 120000,
    concurrency: 1,
    maxAttempts: 3,
    pendingTimeoutMs: 2 * 60 * 1000
  });

  let databasePromise = null;

  function mediaStorageKey(value) {
    const raw = String(value || "");
    if (/^(?:discord-attachment:|images-ext-[12]\.discordapp\.net:)/.test(raw)) return raw;
    return Core.mediaIdentity(value);
  }

  function cacheRequestUrl(url) {
    return `https://bridge-mod-tools.invalid/media?key=${encodeURIComponent(mediaStorageKey(url) || "")}`;
  }

  function permissionOrigin(value) {
    const safe = Core.safeMediaUrl(value);
    return safe ? new URL(safe).origin : null;
  }

  function fetchableMedia(item) {
    return Boolean(item && item.cacheable !== false && item.kind !== "link" && Core.safeMediaUrl(item.url));
  }

  function allowedResponseType(contentType, kind) {
    const mime = String(contentType || "").split(";", 1)[0].trim().toLocaleLowerCase();
    if (!mime) return kind === "file";
    if (/^(?:text\/(?:html|css)|application\/(?:xhtml\+xml|javascript|x-javascript|xml)|image\/svg\+xml)$/.test(mime)) return false;
    if (kind === "image") return mime.startsWith("image/");
    if (kind === "video") return mime.startsWith("video/");
    if (kind === "audio") return mime.startsWith("audio/");
    return true;
  }

  function safeRedirect(fromValue, toValue) {
    const from = Core.safeMediaUrl(fromValue);
    const to = Core.safeMediaUrl(toValue);
    if (!from || !to) return false;
    const fromUrl = new URL(from);
    const toUrl = new URL(to);
    if (fromUrl.origin === toUrl.origin) return true;
    const discordHosts = new Set([
      "cdn.discordapp.com", "media.discordapp.net", "images-ext-1.discordapp.net", "images-ext-2.discordapp.net"
    ]);
    return discordHosts.has(fromUrl.hostname) && discordHosts.has(toUrl.hostname);
  }

  function openDatabase() {
    if (databasePromise) return databasePromise;
    if (!root.indexedDB) return Promise.reject(new Error("indexeddb-unavailable"));
    databasePromise = new Promise((resolve, reject) => {
      const request = root.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        const store = database.objectStoreNames.contains(STORE_NAME)
          ? request.transaction.objectStore(STORE_NAME)
          : database.createObjectStore(STORE_NAME, { keyPath: "url" });
        if (!store.indexNames.contains("owners")) store.createIndex("owners", "ownerKeys", { multiEntry: true });
        if (!store.indexNames.contains("status")) store.createIndex("status", "status");
        if (!store.indexNames.contains("lastAccessedAt")) store.createIndex("lastAccessedAt", "lastAccessedAt");
        if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE, { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("indexeddb-open-failed"));
      request.onblocked = () => reject(new Error("indexeddb-blocked"));
    }).catch((error) => {
      databasePromise = null;
      throw error;
    });
    return databasePromise;
  }

  async function assetTransaction(mode, callback) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(STORE_NAME, mode);
      const store = tx.objectStore(STORE_NAME);
      let value;
      try { value = callback(store, tx); } catch (error) { reject(error); return; }
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error || new Error("indexeddb-transaction-failed"));
      tx.onabort = () => reject(tx.error || new Error("indexeddb-transaction-aborted"));
    });
  }

  async function getGeneration() {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(META_STORE, "readonly");
      const request = tx.objectStore(META_STORE).get(GENERATION_KEY);
      request.onsuccess = () => resolve(Number.isInteger(request.result?.value) ? request.result.value : 0);
      request.onerror = () => reject(request.error || new Error("media-generation-read-failed"));
    });
  }

  async function setGeneration(value) {
    const generation = Number.isInteger(value) && value >= 0 ? value : 0;
    const database = await openDatabase();
    await new Promise((resolve, reject) => {
      const tx = database.transaction(META_STORE, "readwrite");
      tx.objectStore(META_STORE).put({ key: GENERATION_KEY, value: generation, updatedAt: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error("media-generation-write-failed"));
      tx.onabort = () => reject(tx.error || new Error("media-generation-write-aborted"));
    });
    return generation;
  }

  async function getAsset(url) {
    const key = mediaStorageKey(url);
    if (!key) return null;
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("media-read-failed"));
    });
  }

  async function putAsset(asset) {
    await assetTransaction("readwrite", (store) => store.put(asset));
    return asset;
  }

  async function conditionalAssetWrite(asset, generation, jobId) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = database.transaction([STORE_NAME, META_STORE], "readwrite");
      let accepted = false;
      const metaRequest = tx.objectStore(META_STORE).get(GENERATION_KEY);
      metaRequest.onsuccess = () => {
        const current = Number.isInteger(metaRequest.result?.value) ? metaRequest.result.value : 0;
        if (current !== generation) return;
        if (!jobId) {
          accepted = true;
          tx.objectStore(STORE_NAME).put(asset);
          return;
        }
        const assetRequest = tx.objectStore(STORE_NAME).get(asset.url);
        assetRequest.onsuccess = () => {
          if (assetRequest.result?.jobId !== jobId || assetRequest.result?.jobGeneration !== generation) return;
          accepted = true;
          tx.objectStore(STORE_NAME).put(asset);
        };
      };
      tx.oncomplete = () => resolve(accepted);
      tx.onerror = () => reject(tx.error || new Error("media-lease-write-failed"));
      tx.onabort = () => reject(tx.error || new Error("media-lease-write-aborted"));
    });
  }

  async function allAssets() {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error || new Error("media-list-failed"));
    });
  }

  async function deleteAssets(urls) {
    const keys = [...new Set((Array.isArray(urls) ? urls : []).map(mediaStorageKey).filter(Boolean))];
    if (!keys.length) return;
    const cache = await root.caches.open(CACHE_NAME);
    for (const key of keys) await cache.delete(cacheRequestUrl(key));
    await assetTransaction("readwrite", (store) => keys.forEach((key) => store.delete(key)));
  }

  async function clearAll() {
    if (root.caches) await root.caches.delete(CACHE_NAME);
    await assetTransaction("readwrite", (store) => store.clear());
  }

  async function boundedBlob(response, maxBytes) {
    const reader = response.body && response.body.getReader ? response.body.getReader() : null;
    if (!reader) {
      const blob = await response.blob();
      if (blob.size > maxBytes) throw new Error("asset-too-large");
      return blob;
    }
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        try { await reader.cancel("asset-too-large"); } catch (_error) {}
        throw new Error("asset-too-large");
      }
      chunks.push(value);
    }
    return new Blob(chunks, { type: response.headers.get("content-type") || "application/octet-stream" });
  }

  async function downloadAsset(item, fetcher, options) {
    const settings = Object.assign({}, DEFAULT_LIMITS, options || {});
    const media = Core.sanitizeMediaItems([item])[0];
    if (!fetchableMedia(media)) throw new Error("invalid-media");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("media-timeout"), settings.timeoutMs);
    try {
      const response = await fetcher(media.url, {
        credentials: "omit",
        redirect: "follow",
        referrerPolicy: "no-referrer",
        signal: controller.signal
      });
      if (!response || !response.ok) throw new Error(`http-${response && response.status || 0}`);
      const finalUrl = Core.safeMediaUrl(response.url || media.url);
      if (!finalUrl || !safeRedirect(media.url, finalUrl)) throw new Error("cross-origin-redirect");
      const contentType = response.headers.get("content-type") || media.mimeType || "";
      if (!allowedResponseType(contentType, media.kind)) throw new Error("unsupported-content-type");
      const announcedSize = Number(response.headers.get("content-length") || 0);
      if (Number.isFinite(announcedSize) && announcedSize > settings.maxAssetBytes) throw new Error("asset-too-large");
      const blob = await boundedBlob(response, settings.maxAssetBytes);
      return {
        blob,
        size: blob.size,
        mimeType: String(blob.type || contentType || "application/octet-stream").split(";", 1)[0].slice(0, 120),
        kind: Core.mediaKindFromMime(blob.type || contentType, media.kind),
        finalUrl
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function streamAssetToCache(item, cacheKey, fetcher, options) {
    const settings = Object.assign({}, DEFAULT_LIMITS, options || {});
    const media = Core.sanitizeMediaItems([item])[0];
    if (!fetchableMedia(media)) throw new Error("invalid-media");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("media-timeout"), settings.timeoutMs);
    try {
      const response = await fetcher(media.url, {
        credentials: "omit",
        redirect: "follow",
        referrerPolicy: "no-referrer",
        signal: controller.signal
      });
      if (!response || !response.ok) throw new Error(`http-${response && response.status || 0}`);
      const finalUrl = Core.safeMediaUrl(response.url || media.url);
      if (!finalUrl || !safeRedirect(media.url, finalUrl)) throw new Error("cross-origin-redirect");
      const contentType = response.headers.get("content-type") || media.mimeType || "";
      if (!allowedResponseType(contentType, media.kind)) throw new Error("unsupported-content-type");
      const announcedSize = Number(response.headers.get("content-length") || 0);
      if (Number.isFinite(announcedSize) && announcedSize > settings.maxAssetBytes) throw new Error("asset-too-large");
      let size = 0;
      let body;
      if (response.body?.pipeThrough && typeof TransformStream === "function") {
        body = response.body.pipeThrough(new TransformStream({
          transform(chunk, streamController) {
            size += Number(chunk?.byteLength) || 0;
            if (size > settings.maxAssetBytes) {
              streamController.error(new Error("asset-too-large"));
              return;
            }
            streamController.enqueue(chunk);
          }
        }));
      } else {
        const blob = await boundedBlob(response, settings.maxAssetBytes);
        size = blob.size;
        body = blob;
      }
      const mimeType = String(contentType || media.mimeType || "application/octet-stream").split(";", 1)[0].slice(0, 120);
      const headers = new Headers({
        "content-type": mimeType,
        "cache-control": "private, max-age=31536000, immutable"
      });
      const cache = await root.caches.open(CACHE_NAME);
      await cache.put(cacheKey, new Response(body, { status: 200, headers }));
      return {
        size,
        mimeType,
        kind: Core.mediaKindFromMime(mimeType, media.kind),
        finalUrl
      };
    } finally {
      clearTimeout(timer);
    }
  }

  function mergeOwners(existing, incoming) {
    return [...new Set([...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])])].slice(0, 1500);
  }

  function dedupeRefs(value) {
    const byUrl = new Map();
    for (const ref of Array.isArray(value) ? value : []) {
      const media = Core.sanitizeMediaItems([ref?.media])[0];
      const owners = mergeOwners([], ref?.ownerKeys || [ref?.ownerKey].filter(Boolean));
      if (!media || !owners.length || !fetchableMedia(media)) continue;
      const key = mediaStorageKey(media.url);
      const existing = byUrl.get(key);
      byUrl.set(key, {
        media,
        ownerKeys: mergeOwners(existing?.ownerKeys, owners),
        deleted: Boolean(existing?.deleted || ref.deleted),
        generation: Number.isInteger(ref?.generation) ? ref.generation : existing?.generation
      });
    }
    return [...byUrl.values()];
  }

  async function cachedBodyExists(asset) {
    if (!asset || asset.status !== "cached" || !root.caches) return false;
    const cache = await root.caches.open(CACHE_NAME);
    return Boolean(await cache.match(asset.cacheKey || cacheRequestUrl(asset.url)));
  }

  async function markPermissionRequired(refs) {
    const now = Date.now();
    for (const ref of dedupeRefs(refs)) {
      const generation = Number.isInteger(ref.generation) ? ref.generation : await getGeneration();
      if (generation !== await getGeneration()) continue;
      const existing = await getAsset(ref.media.url);
      if (existing?.status === "cached" && await cachedBodyExists(existing)) {
        await conditionalAssetWrite(Object.assign({}, existing, {
          ownerKeys: mergeOwners(existing.ownerKeys, ref.ownerKeys),
          protected: Boolean(existing.protected || ref.deleted),
          lastAccessedAt: now
        }), generation);
        continue;
      }
      await conditionalAssetWrite(Object.assign({}, existing || {}, {
        url: mediaStorageKey(ref.media.url),
        sourceUrl: ref.media.url,
        cacheKey: cacheRequestUrl(ref.media.url),
        kind: ref.media.kind,
        source: ref.media.source,
        name: ref.media.name,
        status: "permission_required",
        error: "permission-required",
        permissionOrigin: permissionOrigin(ref.media.url),
        ownerKeys: mergeOwners(existing?.ownerKeys, ref.ownerKeys),
        protected: Boolean(existing?.protected || ref.deleted),
        updatedAt: now,
        lastAccessedAt: now,
        jobId: null,
        jobGeneration: null
      }), generation);
    }
  }

  function retryDelay(attempts) {
    return Math.min(60 * 60 * 1000, 30 * 1000 * (2 ** Math.max(0, attempts - 1)));
  }

  function randomJobId() {
    if (root.crypto?.randomUUID) return root.crypto.randomUUID();
    const values = new Uint32Array(4);
    root.crypto?.getRandomValues?.(values);
    return [...values].map((value) => value.toString(16).padStart(8, "0")).join("") || `${Date.now()}-${Math.random()}`;
  }

  async function cacheOne(ref, options) {
    const settings = Object.assign({}, DEFAULT_LIMITS, options || {});
    const media = Core.sanitizeMediaItems([ref.media])[0];
    if (!fetchableMedia(media)) return { status: "ignored" };
    const generation = Number.isInteger(ref.generation) ? ref.generation : await getGeneration();
    if (generation !== await getGeneration()) return { status: "ignored", error: "stale-generation" };
    const existing = await getAsset(media.url);
    const ownerKeys = mergeOwners(existing?.ownerKeys, ref.ownerKeys || [ref.ownerKey]);
    if (existing?.status === "cached" && await cachedBodyExists(existing)) {
      await conditionalAssetWrite(Object.assign({}, existing, {
        ownerKeys,
        protected: Boolean(existing.protected || ref.deleted),
        lastAccessedAt: Date.now()
      }), generation);
      return { status: "cached", reused: true, size: existing.size || 0 };
    }
    if (!settings.force && existing?.status === "failed" && Number(existing.attempts) >= settings.maxAttempts) {
      return { status: "failed", error: existing.error || "retry-limit" };
    }
    const jobId = randomJobId();
    const attempts = Math.max(0, Number(existing?.attempts) || 0) + 1;
    const pending = Object.assign({}, existing || {}, {
      url: mediaStorageKey(media.url),
      sourceUrl: media.url,
      cacheKey: cacheRequestUrl(media.url),
      kind: media.kind,
      source: media.source,
      name: media.name,
      status: "pending",
      error: null,
      permissionOrigin: null,
      ownerKeys,
      protected: Boolean(existing?.protected || ref.deleted),
      attempts,
      nextRetryAt: null,
      jobId,
      jobGeneration: generation,
      updatedAt: Date.now(),
      lastAccessedAt: Date.now()
    });
    if (!await conditionalAssetWrite(pending, generation)) return { status: "ignored", error: "stale-generation" };
    let bodyCommitted = false;
    try {
      const downloaded = await streamAssetToCache(
        media,
        pending.cacheKey,
        options?.fetcher || root.fetch.bind(root),
        settings
      );
      bodyCommitted = true;
      if (generation !== await getGeneration()) throw new Error("stale-generation");
      const lease = await getAsset(media.url);
      if (lease?.jobId !== jobId || lease.jobGeneration !== generation) throw new Error("stale-generation");
      const complete = Object.assign({}, pending, {
        kind: downloaded.kind,
        mimeType: downloaded.mimeType,
        size: downloaded.size,
        status: "cached",
        error: null,
        cachedAt: Date.now(),
        updatedAt: Date.now(),
        lastAccessedAt: Date.now(),
        nextRetryAt: null
      });
      if (!await conditionalAssetWrite(complete, generation, jobId)) throw new Error("stale-generation");
      return { status: "cached", size: complete.size };
    } catch (error) {
      if (bodyCommitted) {
        try { await (await root.caches.open(CACHE_NAME)).delete(pending.cacheKey); } catch (_ignored) {}
      }
      const message = String(error && error.message || error).slice(0, 160);
      if (message === "stale-generation") return { status: "ignored", error: message };
      const failed = Object.assign({}, pending, {
        status: "failed",
        error: message,
        nextRetryAt: Date.now() + retryDelay(attempts),
        updatedAt: Date.now()
      });
      await conditionalAssetWrite(failed, generation, jobId);
      return { status: "failed", error: failed.error };
    }
  }

  async function prune(options) {
    const settings = Object.assign({}, DEFAULT_LIMITS, options || {});
    if (Number.isInteger(settings.generation) && settings.generation !== await getGeneration()) {
      return { removed: 0, bytes: 0, count: 0, stale: true };
    }
    const assets = await allAssets();
    const cached = assets.filter((asset) => asset.status === "cached");
    let bytes = cached.reduce((total, asset) => total + (Number(asset.size) || 0), 0);
    let count = cached.length;
    const removable = cached.sort((left, right) => {
      const protectedOrder = Number(Boolean(left.protected)) - Number(Boolean(right.protected));
      return protectedOrder || (left.lastAccessedAt || left.cachedAt || 0) - (right.lastAccessedAt || right.cachedAt || 0);
    });
    const removed = [];
    while ((bytes > settings.maxTotalBytes || count > settings.maxAssets) && removable.length) {
      const asset = removable.shift();
      removed.push(asset.url);
      bytes -= Number(asset.size) || 0;
      count -= 1;
    }
    if (removed.length && (!Number.isInteger(settings.generation) || settings.generation === await getGeneration())) {
      await deleteAssets(removed);
    }
    return { removed: removed.length, bytes: Math.max(0, bytes), count: Math.max(0, count) };
  }

  async function refsNeedingCache(refs, options) {
    const settings = Object.assign({}, DEFAULT_LIMITS, options || {});
    const now = Date.now();
    const needed = [];
    for (const ref of dedupeRefs(refs)) {
      const asset = await getAsset(ref.media.url);
      if (asset?.status === "cached" && await cachedBodyExists(asset)) continue;
      if (settings.force || !asset || asset.status === "permission_required") {
        needed.push(ref);
        continue;
      }
      if (asset.status === "pending" && asset.jobGeneration === ref.generation &&
        now - (Number(asset.updatedAt) || 0) < settings.pendingTimeoutMs) continue;
      if (asset.status === "failed" && (Number(asset.attempts) >= settings.maxAttempts || now < (Number(asset.nextRetryAt) || 0))) continue;
      needed.push(ref);
    }
    return needed;
  }

  async function cacheRefs(refs, options) {
    const settings = Object.assign({}, DEFAULT_LIMITS, options || {}, { concurrency: 1 });
    const queue = await refsNeedingCache(refs, settings);
    if (queue.length && Number.isInteger(queue[0].generation)) settings.generation = queue[0].generation;
    const summary = { cached: 0, failed: 0, ignored: 0, bytes: 0 };
    for (const ref of queue) {
      if (!settings.skipPrune) {
        await prune(Object.assign({}, settings, {
          maxTotalBytes: Math.max(0, settings.maxTotalBytes - settings.maxAssetBytes),
          maxAssets: Math.max(0, settings.maxAssets - 1)
        }));
      }
      const result = await cacheOne(ref, settings);
      summary[result.status] = (summary[result.status] || 0) + 1;
      summary.bytes += Number(result.size) || 0;
      if (!settings.skipPrune) await prune(settings);
    }
    return summary;
  }

  function expectedOwnerMap(records) {
    const expected = new Map();
    const add = (url, ownerKey, protectedValue) => {
      const key = mediaStorageKey(url);
      if (!key) return;
      const value = expected.get(key) || { ownerKeys: [], protected: false };
      value.ownerKeys = mergeOwners(value.ownerKeys, [ownerKey]);
      value.protected = Boolean(value.protected || protectedValue);
      expected.set(key, value);
    };
    for (const record of Array.isArray(records) ? records : []) {
      const ownerKey = Core.recordKey(record);
      const protectedValue = Core.isDeletedStatus(record.status);
      for (const media of Core.sanitizeMediaItems(record.media)) {
        if (fetchableMedia(media)) add(media.url, ownerKey, protectedValue);
        if (media.posterUrl) add(media.posterUrl, ownerKey, protectedValue);
      }
    }
    return expected;
  }

  async function reconcileArchive(records, options) {
    const generation = Number.isInteger(options?.generation) ? options.generation : null;
    if (generation !== null && generation !== await getGeneration()) return { removed: 0, stale: true };
    const expected = expectedOwnerMap(records);
    const assets = await allAssets();
    const orphaned = [];
    for (const asset of assets) {
      const wanted = expected.get(asset.url);
      if (!wanted?.ownerKeys.length) {
        orphaned.push(asset.url);
        continue;
      }
      const currentOwners = Array.isArray(asset.ownerKeys) ? asset.ownerKeys : [];
      if (JSON.stringify(currentOwners) !== JSON.stringify(wanted.ownerKeys) || Boolean(asset.protected) !== wanted.protected) {
        const repaired = Object.assign({}, asset, wanted, { updatedAt: Date.now() });
        if (generation === null) await putAsset(repaired);
        else await conditionalAssetWrite(repaired, generation);
      }
    }
    if (orphaned.length && (generation === null || generation === await getGeneration())) await deleteAssets(orphaned);
    return prune(Object.assign({}, options || {}, generation === null ? {} : { generation }));
  }

  async function getStats() {
    const assets = await allAssets();
    const stats = { cached: 0, pending: 0, failed: 0, permissionRequired: 0, bytes: 0, origins: [] };
    const origins = new Set();
    for (const asset of assets) {
      if (asset.status === "cached") { stats.cached += 1; stats.bytes += Number(asset.size) || 0; }
      else if (asset.status === "pending") stats.pending += 1;
      else if (asset.status === "permission_required") {
        stats.permissionRequired += 1;
        if (asset.permissionOrigin) origins.add(asset.permissionOrigin);
      } else if (asset.status === "failed") stats.failed += 1;
    }
    stats.origins = [...origins].sort().slice(0, 50);
    return stats;
  }

  async function readCachedResponse(url) {
    const asset = await getAsset(url);
    if (!asset || asset.status !== "cached") return { asset, response: null };
    const cache = await root.caches.open(CACHE_NAME);
    const response = await cache.match(asset.cacheKey || cacheRequestUrl(asset.url));
    return { asset, response: response || null };
  }

  const api = Object.freeze({
    DB_NAME, STORE_NAME, META_STORE, CACHE_NAME, DEFAULT_LIMITS,
    mediaStorageKey, cacheRequestUrl, permissionOrigin, fetchableMedia, allowedResponseType, safeRedirect, dedupeRefs,
    openDatabase, getGeneration, setGeneration, getAsset, allAssets, clearAll, boundedBlob, downloadAsset, streamAssetToCache,
    markPermissionRequired, refsNeedingCache, cacheRefs, expectedOwnerMap, reconcileArchive, prune, getStats, readCachedResponse
  });
  root.BridgeModToolsMediaStore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
