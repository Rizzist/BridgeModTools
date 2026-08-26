(function runCachedMediaView() {
  "use strict";

  const Core = globalThis.LocalDiscordArchiveCore;
  const T = globalThis.LocalDiscordArchiveProtocol.TYPES;
  const MediaStore = globalThis.BridgeModToolsMediaStore;
  const root = document.getElementById("media");
  const PARENT_ORIGIN = (() => {
    try {
      const origin = new URL(document.referrer).origin;
      if (origin === "https://discord.com" || origin === `chrome-extension://${chrome.runtime.id}`) return origin;
    } catch (_error) {}
    return "https://discord.com";
  })();
  const objectUrls = new Set();
  const renderedAssets = new Map();
  let capability = null;
  let currentRecord = null;
  let mediaItems = [];
  let renderSequence = 0;
  let committedSequence = 0;
  let currentRetryable = false;
  let currentRefreshable = false;
  let refreshAfterRender = false;
  let retryTimer = null;
  let retryDelayMs = 250;
  let retryDeadline = 0;

  function clearRetryTimer() {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  }

  function beginRetryWindow() {
    clearRetryTimer();
    retryDelayMs = 250;
    // The downloader itself is bounded to two minutes. Keep checking slightly
    // beyond that window so a cache-completion broadcast cannot be missed
    // during iframe startup, service-worker wakeup, or an IndexedDB commit.
    retryDeadline = Date.now() + 130000;
  }

  function scheduleRetry() {
    if (retryTimer !== null || !capability || Date.now() >= retryDeadline) return;
    const delay = Math.min(retryDelayMs, Math.max(0, retryDeadline - Date.now()));
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryDelayMs = Math.min(5000, retryDelayMs * 2);
      renderCurrent().catch(() => {});
    }, delay);
  }

  function textElement(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = String(text || "");
    return element;
  }

  function externalLink(media, label) {
    const anchor = document.createElement("a");
    anchor.className = "asset__link";
    anchor.href = media.url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.textContent = label;
    return anchor;
  }

  function revokeObjectUrls() {
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls.clear();
  }

  function disposeRenderedAsset(entry) {
    for (const url of entry?.objectUrls || []) {
      URL.revokeObjectURL(url);
      objectUrls.delete(url);
    }
  }

  function clearRenderedAssets() {
    for (const entry of renderedAssets.values()) disposeRenderedAsset(entry);
    renderedAssets.clear();
    root.replaceChildren();
  }

  function mediaElement(media, blobUrl, asset) {
    if (asset.kind === "image") {
      const image = document.createElement("img");
      image.alt = media.alt || media.name || "Cached image";
      image.src = blobUrl;
      image.addEventListener("load", reportSize, { once: true });
      return image;
    }
    if (asset.kind === "video") {
      const video = document.createElement("video");
      video.controls = true;
      video.autoplay = false;
      video.playsInline = true;
      video.preload = "metadata";
      video.src = blobUrl;
      video.addEventListener("loadedmetadata", reportSize, { once: true });
      return video;
    }
    if (asset.kind === "audio") {
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.autoplay = false;
      audio.preload = "metadata";
      audio.src = blobUrl;
      audio.addEventListener("loadedmetadata", reportSize, { once: true });
      return audio;
    }
    const download = document.createElement("a");
    download.className = "asset__download";
    download.href = blobUrl;
    download.download = media.name || "cached-file";
    download.textContent = "Open cached file";
    return download;
  }

  async function createAssetCard(media) {
    const card = document.createElement("article");
    const cardObjectUrls = new Set();
    card.className = `asset asset--${media.kind}`;
    const top = document.createElement("div");
    top.className = "asset__top";
    top.append(
      textElement("span", "asset__name", media.name || media.kind),
      externalLink(media, (() => { try { return new URL(media.url).hostname; } catch (_error) { return "source"; } })())
    );
    if (["file", "link"].includes(media.kind)) card.append(top);

    if (media.kind === "link" || !media.cacheable) {
      card.append(textElement("div", "asset__status", "Saved link — opens the original source."));
      return { card, playable: false, retryable: false, refreshable: false, objectUrls: cardObjectUrls };
    }

    let cached;
    try { cached = await MediaStore.readCachedResponse(media.url); }
    catch (_error) { cached = { asset: null, response: null }; }
    if (!cached.response) {
      const state = cached.asset?.status;
      const messages = {
        pending: "Caching locally…",
        permission_required: "External-site permission is required; enable it from the extension popup.",
        failed: `Could not cache this media${cached.asset?.error ? `: ${cached.asset.error}` : "."}`
      };
      card.append(textElement("div", `asset__status${state === "failed" ? " error" : ""}`,
        messages[state] || "Waiting for the local media cache…"));
      return {
        card,
        playable: false,
        retryable: !state || state === "pending",
        refreshable: true,
        objectUrls: cardObjectUrls
      };
    }

    const blobUrl = URL.createObjectURL(await cached.response.blob());
    objectUrls.add(blobUrl);
    cardObjectUrls.add(blobUrl);
    const playable = mediaElement(media, blobUrl, cached.asset);
    if (cached.asset.kind === "video" && media.posterUrl && playable instanceof HTMLVideoElement) {
      try {
        const poster = await MediaStore.readCachedResponse(media.posterUrl);
        if (poster.response) {
          const posterUrl = URL.createObjectURL(await poster.response.blob());
          objectUrls.add(posterUrl);
          cardObjectUrls.add(posterUrl);
          playable.poster = posterUrl;
        }
      } catch (_error) {}
    }
    if (media.spoiler) {
      const details = document.createElement("details");
      details.className = "spoiler";
      const summary = document.createElement("summary");
      summary.textContent = "Reveal spoiler media";
      details.append(summary, playable);
      card.append(details);
    } else card.append(playable);
    if (["image", "video"].includes(cached.asset.kind) && media.width && media.height) {
      const scale = Math.min(1, 550 / media.width, 350 / media.height);
      card.style.width = `${Math.max(40, Math.round(media.width * scale))}px`;
      card.style.aspectRatio = `${media.width} / ${media.height}`;
      playable.style.width = "100%";
      playable.style.height = "100%";
    }
    return { card, playable: true, retryable: false, refreshable: false, objectUrls: cardObjectUrls };
  }

  function reportSize() {
    requestAnimationFrame(() => {
      const rect = root.getBoundingClientRect();
      let desiredWidth = rect.width;
      if (root.classList.contains("gallery")) desiredWidth = 550;
      for (const element of root.querySelectorAll("img, video, audio")) {
        if (element instanceof HTMLImageElement && element.naturalWidth) {
          const scale = Math.min(1, 550 / element.naturalWidth, 350 / Math.max(1, element.naturalHeight));
          desiredWidth = Math.max(desiredWidth, element.naturalWidth * scale);
        } else if (element instanceof HTMLVideoElement && element.videoWidth) {
          const scale = Math.min(1, 550 / element.videoWidth, 350 / Math.max(1, element.videoHeight));
          desiredWidth = Math.max(desiredWidth, element.videoWidth * scale);
        } else if (element instanceof HTMLAudioElement) desiredWidth = Math.max(desiredWidth, 400);
      }
      for (const element of root.querySelectorAll(".asset--file, .asset--link")) {
        desiredWidth = Math.max(desiredWidth, Math.min(430, element.scrollWidth));
      }
      parent.postMessage({
        type: "LDMA_MEDIA_SIZE",
        width: Math.min(550, Math.max(40, Math.ceil(desiredWidth))),
        height: Math.min(1600, Math.max(24, Math.ceil(root.scrollHeight)))
      }, PARENT_ORIGIN);
    });
  }

  function syncRenderedCards(entries) {
    for (let index = 0; index < entries.length; index += 1) {
      const card = entries[index].card;
      const current = root.children[index];
      if (current === card) continue;
      if (current && !entries.some((entry) => entry.card === current)) current.replaceWith(card);
      else root.insertBefore(card, current || null);
    }
    while (root.children.length > entries.length) root.lastElementChild.remove();
  }

  async function renderCurrent(refreshTerminal) {
    const sequence = ++renderSequence;
    clearRetryTimer();
    if (!mediaItems.length) {
      clearRenderedAssets();
      root.replaceChildren(textElement("p", "empty", currentRecord ? "No saved media for this message." : "Waiting for authorized media…"));
      currentRetryable = false;
      currentRefreshable = false;
      committedSequence = sequence;
      reportSize();
      return;
    }
    const rendered = [];
    const replacements = [];
    const wantedKeys = new Set();
    for (const media of mediaItems) {
      const key = Core.mediaIdentity(media.url) || media.url;
      wantedKeys.add(key);
      const existing = renderedAssets.get(key);
      if (existing && !existing.retryable && !(refreshTerminal && existing.refreshable)) {
        rendered.push(existing);
        continue;
      }
      const created = await createAssetCard(media);
      created.key = key;
      rendered.push(created);
      replacements.push({ key, existing, created });
    }
    if (sequence !== renderSequence) {
      replacements.forEach(({ created }) => disposeRenderedAsset(created));
      return;
    }
    for (const [key, entry] of renderedAssets) {
      if (wantedKeys.has(key)) continue;
      disposeRenderedAsset(entry);
      renderedAssets.delete(key);
    }
    for (const { key, existing, created } of replacements) {
      if (existing) disposeRenderedAsset(existing);
      renderedAssets.set(key, created);
    }
    currentRetryable = rendered.some((item) => item.retryable);
    currentRefreshable = rendered.some((item) => item.refreshable);
    root.classList.toggle("gallery", rendered.length > 1 && rendered.every((item) =>
      item.card.classList.contains("asset--image") || item.card.classList.contains("asset--video")));
    syncRenderedCards(rendered);
    committedSequence = sequence;
    reportSize();
    if (refreshAfterRender) {
      refreshAfterRender = false;
      renderCurrent(true).catch(() => {});
      return;
    }
    if (currentRetryable) scheduleRetry();
  }

  async function redeemCapability(value) {
    const response = await chrome.runtime.sendMessage({ type: T.REDEEM_MEDIA_CAPABILITY, capability: value });
    if (!response.ok || !response.record) throw new Error(response.reason || "capability-rejected");
    clearRenderedAssets();
    capability = value;
    currentRecord = Core.sanitizeRecordPresentation(response.record);
    mediaItems = Core.sanitizeMediaItems(currentRecord.media);
    beginRetryWindow();
    await renderCurrent();
  }

  function connectUpdates() {
    const port = chrome.runtime.connect({ name: "ldma-updates" });
    port.onMessage.addListener((message) => {
      if (message.type !== "LDMA_MEDIA_CHANGED" || !capability) return;
      if (renderSequence !== committedSequence) {
        refreshAfterRender = true;
        return;
      }
      if (currentRetryable || currentRefreshable) {
        retryDelayMs = 250;
        retryDeadline = Math.max(retryDeadline, Date.now() + 5000);
        renderCurrent(true).catch(() => {});
      }
    });
    port.onDisconnect.addListener(() => setTimeout(connectUpdates, 500));
  }

  window.addEventListener("message", (event) => {
    if (event.source !== parent || event.data?.type !== "LDMA_MEDIA_CAPABILITY" || typeof event.data.capability !== "string") return;
    redeemCapability(event.data.capability).catch(() => {
      root.replaceChildren(textElement("p", "empty", "This cached-media view is not authorized."));
    });
  });
  window.addEventListener("beforeunload", () => {
    clearRetryTimer();
    clearRenderedAssets();
    revokeObjectUrls();
  });
  connectUpdates();
  if (typeof ResizeObserver === "function") new ResizeObserver(reportSize).observe(root);
  renderCurrent().catch(() => {});
})();
