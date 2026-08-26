(function runCachedMediaView() {
  "use strict";

  const Core = globalThis.LocalDiscordArchiveCore;
  const T = globalThis.LocalDiscordArchiveProtocol.TYPES;
  const MediaStore = globalThis.BridgeModToolsMediaStore;
  const root = document.getElementById("media");
  const objectUrls = new Set();
  let capability = null;
  let currentRecord = null;
  let mediaItems = [];
  let currentIndex = 0;
  let renderSequence = 0;
  let currentPlayable = false;

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

  function mediaElement(media, blobUrl, asset) {
    if (asset.kind === "image") {
      const image = document.createElement("img");
      image.alt = media.alt || media.name || "Cached image";
      image.src = blobUrl;
      return image;
    }
    if (asset.kind === "video") {
      const video = document.createElement("video");
      video.controls = true;
      video.autoplay = false;
      video.playsInline = true;
      video.preload = "metadata";
      video.src = blobUrl;
      return video;
    }
    if (asset.kind === "audio") {
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.autoplay = false;
      audio.preload = "metadata";
      audio.src = blobUrl;
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
    card.className = "asset";
    const top = document.createElement("div");
    top.className = "asset__top";
    top.append(
      textElement("span", "asset__name", media.name || media.kind),
      externalLink(media, (() => { try { return new URL(media.url).hostname; } catch (_error) { return "source"; } })())
    );
    card.append(top);

    if (media.kind === "link" || !media.cacheable) {
      card.append(textElement("div", "asset__status", "Saved link — opens the original source."));
      return { card, playable: false };
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
      return { card, playable: false };
    }

    const blobUrl = URL.createObjectURL(await cached.response.blob());
    objectUrls.add(blobUrl);
    const playable = mediaElement(media, blobUrl, cached.asset);
    if (cached.asset.kind === "video" && media.posterUrl && playable instanceof HTMLVideoElement) {
      try {
        const poster = await MediaStore.readCachedResponse(media.posterUrl);
        if (poster.response) {
          const posterUrl = URL.createObjectURL(await poster.response.blob());
          objectUrls.add(posterUrl);
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
    return { card, playable: true };
  }

  function navigation() {
    if (mediaItems.length <= 1) return null;
    const nav = document.createElement("nav");
    nav.className = "pager";
    nav.setAttribute("aria-label", "Saved media items");
    const previous = document.createElement("button");
    previous.type = "button";
    previous.textContent = "Previous";
    previous.disabled = currentIndex === 0;
    previous.addEventListener("click", () => { currentIndex -= 1; renderCurrent().catch(() => {}); });
    const counter = textElement("span", "pager__counter", `${currentIndex + 1} of ${mediaItems.length}`);
    const next = document.createElement("button");
    next.type = "button";
    next.textContent = "Next";
    next.disabled = currentIndex >= mediaItems.length - 1;
    next.addEventListener("click", () => { currentIndex += 1; renderCurrent().catch(() => {}); });
    nav.append(previous, counter, next);
    return nav;
  }

  async function renderCurrent() {
    const sequence = ++renderSequence;
    revokeObjectUrls();
    currentPlayable = false;
    const media = mediaItems[currentIndex];
    if (!media) {
      root.replaceChildren(textElement("p", "empty", currentRecord ? "No saved media for this message." : "Waiting for authorized media…"));
      return;
    }
    const rendered = await createAssetCard(media);
    if (sequence !== renderSequence) return;
    currentPlayable = rendered.playable;
    const nav = navigation();
    root.replaceChildren(...(nav ? [nav, rendered.card] : [rendered.card]));
  }

  async function redeemCapability(value) {
    const response = await chrome.runtime.sendMessage({ type: T.REDEEM_MEDIA_CAPABILITY, capability: value });
    if (!response.ok || !response.record) throw new Error(response.reason || "capability-rejected");
    capability = value;
    currentRecord = Core.sanitizeRecordPresentation(response.record);
    mediaItems = Core.sanitizeMediaItems(currentRecord.media);
    currentIndex = Math.min(currentIndex, Math.max(0, mediaItems.length - 1));
    await renderCurrent();
  }

  function connectUpdates() {
    const port = chrome.runtime.connect({ name: "ldma-updates" });
    port.onMessage.addListener((message) => {
      if (message.type === "LDMA_MEDIA_CHANGED" && !currentPlayable && capability) renderCurrent().catch(() => {});
    });
    port.onDisconnect.addListener(() => setTimeout(connectUpdates, 500));
  }

  window.addEventListener("message", (event) => {
    if (event.source !== parent || event.data?.type !== "LDMA_MEDIA_CAPABILITY" || typeof event.data.capability !== "string") return;
    redeemCapability(event.data.capability).catch(() => {
      root.replaceChildren(textElement("p", "empty", "This cached-media view is not authorized."));
    });
  });
  window.addEventListener("beforeunload", revokeObjectUrls);
  connectUpdates();
  renderCurrent().catch(() => {});
})();
