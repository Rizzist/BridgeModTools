(function runContentScript() {
  "use strict";

  const Core = globalThis.LocalDiscordArchiveCore;
  const Protocol = globalThis.LocalDiscordArchiveProtocol;
  if (!Core || !Protocol || !globalThis.chrome || !chrome.runtime) return;

  const INSTALL_KEY = Symbol.for("BridgeModTools.contentScript.v1");
  const existingController = globalThis[INSTALL_KEY];
  if (existingController && typeof existingController.recover === "function") {
    existingController.recover("duplicate-injection");
    return;
  }
  const controller = {
    pendingRecovery: false,
    recover() { this.pendingRecovery = true; }
  };
  try {
    Object.defineProperty(globalThis, INSTALL_KEY, { configurable: false, enumerable: false, value: controller });
  } catch (_error) {
    try { globalThis[INSTALL_KEY] = controller; } catch (_ignored) {}
  }

  const T = Protocol.TYPES;
  const MESSAGE_SELECTOR = "li[id^='chat-messages-'], [data-list-item-id^='chat-messages___']";
  const LIST_SELECTOR = ["[data-list-id='chat-messages']", "ol[aria-label*='essages']", "[role='list'][aria-label*='essages']"].join(",");
  const AUTHOR_SELECTORS = ["[id^='message-username-']", "[class*='username_']"];
  const BRIDGE = "LDMA_BRIDGE_V1";
  const LIVE_HEALTH = "LDMA_REPORT_LIVE_HEALTH";
  const EDIT_EVENT = "LDMA_EDIT_BEFORE_V1";
  const RESOLVE_MESSAGE_AUTHORS = "LDMA_RESOLVE_MESSAGE_AUTHORS";
  const SNOWFLAKE = /^\d{15,25}$/;
  const captureSessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  let captureSequence = 0;

  const state = {
    archive: Protocol.emptyArchive(), generation: 0, paused: false,
    route: Core.parseDiscordRoute(location.pathname), lastRouteAt: performance.now(), lastScrollAt: -Infinity,
    anchorlessEpoch: 0,
    activeList: null, listIdentity: null, snapshots: new WeakMap(), signatures: new Map(),
    snapshotsByKey: new Map(), pageHookStatus: "searching", pageHookDetail: "Waiting for Discord's deletion event dispatcher.",
    pendingRecords: new Map(), pendingRetractions: new Set(), recentRemovals: new Map(), pendingRetainedKeys: new Set(), pendingReleaseKeys: new Set(), flushTimer: null, flushPromise: null,
    healthSignature: "", refreshPromise: null, tombstoneRenderers: new Map(), editRenderers: new Map(), liveActionRenderers: new Map(), spacingFrame: 0,
    pendingConfirmedMounts: new Map(), pendingEdits: new Map(), stagedSelfEdits: new Map(),
    resolvedAuthorIds: new Map(), resolvedAuthorUsernames: new Map(),
    authorResolutionAttempts: new Map(), pendingAuthorResolutionIds: new Set(),
    authorResolutionTimer: null, pendingTimeoutActions: new Set(),
    lastMediaRecoveryAt: -Infinity,
    pageHookLastSeenAt: -Infinity, bootstrapRequestedAt: -Infinity, bootstrapPromise: null
  };

  function send(command) {
    return chrome.runtime.sendMessage(command).catch(() => ({ ok: false, reason: "broker-unavailable" }));
  }

  function requestPageHook(reason) {
    const now = performance.now();
    if (state.bootstrapPromise || now - state.bootstrapRequestedAt < 1500) return state.bootstrapPromise || Promise.resolve();
    state.bootstrapRequestedAt = now;
    state.bootstrapPromise = send({ type: "LDMA_ENSURE_BOOTSTRAP", reason: String(reason || "watchdog").slice(0, 80) })
      .finally(() => { state.bootstrapPromise = null; });
    return state.bootstrapPromise;
  }

  function extensionFrameOrigin() {
    // `use_dynamic_url` gives the iframe element a per-session UUID host, but
    // Chrome commits the packaged document to the extension's real origin.
    return `chrome-extension://${chrome.runtime.id}`;
  }

  function rawRowId(node) {
    return (node && (node.id || (node.dataset && node.dataset.listItemId))) || "";
  }

  function rowIdentity(node) {
    return Core.parseMessageRowIdentity(rawRowId(node));
  }

  function uniqueMessageNodes(root, route) {
    const found = [];
    const seen = new Set();
    const add = (node) => {
      if (!node || node.nodeType !== Node.ELEMENT_NODE ||
        node.closest("[data-ldma-tombstone], [data-ldma-native-replaced]")) return;
      const identity = rowIdentity(node);
      if (!identity || seen.has(identity.messageId)) return;
      if (route && identity.channelId && identity.channelId !== route.channelId) return;
      seen.add(identity.messageId);
      found.push(node);
    };
    if (root && root.nodeType === Node.ELEMENT_NODE && root.matches(MESSAGE_SELECTOR)) add(root);
    if (root && root.querySelectorAll) root.querySelectorAll(MESSAGE_SELECTOR).forEach(add);
    return found;
  }

  function stableListIdentity(list, route) {
    if (!list || !route) return null;
    const marker = list.getAttribute("data-list-id") || list.getAttribute("aria-label") || list.getAttribute("role") || list.tagName;
    return `${route.routeKey}|${Core.normalizeText(marker).slice(0, 100)}`;
  }

  function nativeRangeSignature(active) {
    if (!active) return "";
    const ids = active.rows.map((row) => rowIdentity(row)?.messageId).filter(Boolean);
    return `${active.identity || "unknown-list"}|${ids.join(",")}`;
  }

  function anchorlessMountIsCurrent(element, active) {
    if (!element || !active || element.dataset.ldmaAnchorlessRange !== nativeRangeSignature(active)) return false;
    // In a genuinely empty/all-deleted channel the restored rows are the only
    // scrollable content. Scrolling those rows must not invalidate them. Tail
    // and retained-row latches still expire on a user gesture.
    return element.dataset.ldmaMountKind === "empty" ||
      element.dataset.ldmaAnchorlessEpoch === String(state.anchorlessEpoch);
  }

  function findActiveMessageList() {
    const route = Core.parseDiscordRoute(location.pathname);
    const main = document.querySelector("main, [role='main']");
    if (!route || !main) return null;
    const candidates = new Set(main.querySelectorAll(LIST_SELECTOR));
    const allRows = uniqueMessageNodes(main, route);
    for (const row of allRows) candidates.add(row.closest(LIST_SELECTOR) || row.parentElement);
    const descriptors = [];
    for (const list of candidates) {
      if (!list || !list.isConnected || !main.contains(list)) continue;
      const rows = uniqueMessageNodes(list, route);
      if (!rows.length) continue;
      const rect = list.getBoundingClientRect();
      const intersectsViewport = rect.bottom > 0 && rect.top < innerHeight;
      descriptors.push({
        node: list, identity: stableListIdentity(list, route), route, rows,
        rowIds: rows.map(rawRowId),
        directParent: rows.every((row) => row.parentElement === rows[0].parentElement),
        preferredList: list.matches("[data-list-id='chat-messages']"),
        intersectsViewport
      });
    }
    return Core.chooseActiveList(descriptors, route.channelId);
  }

  function findEmptyConfirmedRestoreList() {
    const route = Core.parseDiscordRoute(location.pathname);
    const main = document.querySelector("main, [role='main']");
    if (!route || !main || document.readyState !== "complete" ||
      performance.now() - state.lastRouteAt < Core.DEFAULTS.routeQuietMs) return null;
    const visible = [...main.querySelectorAll("[data-list-id='chat-messages']")].filter((list) => {
      if (!list.isConnected || uniqueMessageNodes(list, route).length) return false;
      const style = getComputedStyle(list);
      const rect = list.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 &&
        rect.top < innerHeight && rect.bottom >= 0;
    });
    if (visible.length !== 1) return null;
    const list = visible[0];
    const scroller = findChatScrollContainer(list);
    const scrollQuiet = performance.now() - state.lastScrollAt >= Core.DEFAULTS.scrollQuietMs;
    const emptyRestoreAllowed = Boolean(scroller && scrollQuiet && Core.isAtScrollBottom({
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight
    }));
    return {
      node: list,
      identity: stableListIdentity(list, route),
      route,
      rows: [],
      rowIds: [],
      directParent: true,
      preferredList: true,
      intersectsViewport: true,
      // Discord virtualization can expose a zero-row list while scrolling.
      // Only a settled, genuinely empty bottom state may restore without live
      // snowflake boundaries.
      allowAnchorless: emptyRestoreAllowed
    };
  }

  function reportHealth(status, detail, force) {
    const signature = `${status}:${detail}`;
    const changed = signature !== state.healthSignature;
    if (!force && !changed) return;
    if (changed) {
      state.healthSignature = signature;
      send({ type: T.SET_HEALTH, status, detail }).catch(() => {});
    }
    send({ type: LIVE_HEALTH, status, detail }).catch(() => {});
  }

  function reportCombinedHealth(active, force) {
    if (!state.route) {
      return;
    } else if (!active) {
      reportHealth("degraded", "No active Discord message list was found; capture is suspended.", force);
    } else if (state.pageHookStatus === "active") {
      reportHealth("active", `${state.pageHookDetail} Archiving rendered messages locally.`, force);
    } else {
      reportHealth("degraded", `${state.pageHookDetail} Rendered-message capture and conservative DOM fallback remain active.`, force);
    }
  }

  function updateActiveList() {
    const active = findActiveMessageList();
    state.activeList = active && active.node;
    state.listIdentity = active && active.identity;
    reportCombinedHealth(active);
    return active;
  }

  function firstText(node, selectors) {
    for (const selector of selectors) {
      const text = Core.normalizeText(node.querySelector(selector)?.textContent);
      if (text) return text;
    }
    return "";
  }

  function authorNameElement(node) {
    const nameWithin = (wrapper) => {
      if (!wrapper) return null;
      if (wrapper.matches("[data-text], [class*='username_']")) return wrapper;
      return wrapper.querySelector("[data-text], [class*='username_']");
    };
    const messageId = rowIdentity(node)?.messageId;
    const exactWrapper = messageId && node.querySelector(`[id="message-username-${messageId}"]`);
    const exactName = nameWithin(exactWrapper);
    if (exactName) return exactName;
    const labelled = [node, ...node.querySelectorAll("[aria-labelledby]")]
      .map((owner) => Core.messageUsernameLabelId(owner.getAttribute("aria-labelledby")))
      .find(Boolean);
    const referencedWrapper = labelled && document.getElementById(labelled);
    const referencedName = nameWithin(referencedWrapper);
    if (referencedName) return referencedName;
    if (referencedWrapper) return referencedWrapper;
    return [...node.querySelectorAll("[class*='username_']")]
      .find((candidate) => !candidate.closest("[class*='repliedMessage_'], [class*='reply_']")) || null;
  }

  function authorFromAriaLabelledBy(node) {
    const owners = [node, ...node.querySelectorAll("[aria-labelledby]")];
    for (const owner of owners) {
      const ids = (owner.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
      const usernameId = Core.messageUsernameLabelId(owner.getAttribute("aria-labelledby"));
      if (usernameId) {
        const username = Core.normalizeText(document.getElementById(usernameId)?.textContent);
        if (username) return username;
      }
      for (const id of ids) {
        const target = document.getElementById(id);
        if (!target) continue;
        const isUsername = id.startsWith("message-username-") || AUTHOR_SELECTORS.some((selector) => target.matches(selector));
        const text = isUsername ? Core.normalizeText(target.textContent) : "";
        if (text) return text;
      }
    }
    return "";
  }

  function groupRootFromNode(node, messageId) {
    if (node.querySelector(`[id="message-username-${messageId}"]`)) return messageId;
    const owners = [node, ...node.querySelectorAll("[aria-labelledby]")];
    for (const owner of owners) {
      const labelledBy = owner.getAttribute("aria-labelledby") || "";
      if (!labelledBy.split(/\s+/).includes(`message-content-${messageId}`)) continue;
      const usernameId = Core.messageUsernameLabelId(owner.getAttribute("aria-labelledby"));
      const match = usernameId?.match(/^message-username-(\d{15,25})$/);
      if (match && (match[1] === messageId || Core.compareSnowflakeIds(match[1], messageId) < 0)) return match[1];
    }
    return null;
  }

  function authorIdFromNode(node, authorElement, avatarUrl) {
    let current = authorElement;
    for (let depth = 0; current && node.contains(current) && depth < 5; depth += 1, current = current.parentElement) {
      for (const attribute of ["data-author-id", "data-user-id"]) {
        const value = Core.snowflakeValue(current.getAttribute?.(attribute));
        if (value) return value;
      }
    }
    return Core.avatarAuthorId(avatarUrl);
  }

  function resolvedAuthorIdentity(channelId, messageId, fallbackUserId, fallbackUsername) {
    let resolvedUserId = null;
    let resolvedUsername = null;
    if (SNOWFLAKE.test(String(channelId || "")) && SNOWFLAKE.test(String(messageId || ""))) {
      const key = `${channelId}:${messageId}`;
      resolvedUserId = state.resolvedAuthorIds.get(key);
      resolvedUsername = state.resolvedAuthorUsernames.get(key);
    }
    return Core.boundAuthorIdentity(resolvedUserId, resolvedUsername, fallbackUserId, fallbackUsername);
  }

  function resolvedAuthorId(channelId, messageId, fallback) {
    return resolvedAuthorIdentity(channelId, messageId, fallback, null).userId;
  }

  function resolvedAuthorUsername(channelId, messageId, fallback, fallbackUserId) {
    return resolvedAuthorIdentity(channelId, messageId, fallbackUserId, fallback).username;
  }

  function queueAuthorResolution(channelId, messageIds) {
    if (state.route?.channelId !== channelId || !SNOWFLAKE.test(String(channelId || ""))) return;
    const now = performance.now();
    for (const messageId of messageIds || []) {
      if (!SNOWFLAKE.test(String(messageId || ""))) continue;
      const key = `${channelId}:${messageId}`;
      if (state.resolvedAuthorIds.has(key) && state.resolvedAuthorUsernames.has(key) ||
        now - (state.authorResolutionAttempts.get(key) || -Infinity) < 30000) continue;
      state.pendingAuthorResolutionIds.add(key);
    }
    if (!state.pendingAuthorResolutionIds.size || state.authorResolutionTimer) return;
    state.authorResolutionTimer = setTimeout(() => {
      state.authorResolutionTimer = null;
      const route = state.route;
      if (!route) {
        state.pendingAuthorResolutionIds.clear();
        return;
      }
      const keys = [...state.pendingAuthorResolutionIds]
        .filter((key) => key.startsWith(`${route.channelId}:`)).slice(0, 200);
      for (const key of keys) state.pendingAuthorResolutionIds.delete(key);
      if (!keys.length) return;
      const attemptedAt = performance.now();
      for (const key of keys) state.authorResolutionAttempts.set(key, attemptedAt);
      const messageIdsForRequest = keys.map((key) => key.slice(key.indexOf(":") + 1));
      const routeKey = route.routeKey;
      send({ type: RESOLVE_MESSAGE_AUTHORS, messageIds: messageIdsForRequest }).then((response) => {
        if (!response?.ok || state.route?.routeKey !== routeKey) return;
        let changed = false;
        for (const item of Array.isArray(response.authors) ? response.authors : []) {
          const messageId = Core.snowflakeValue(item?.messageId);
          const userId = Core.snowflakeValue(item?.userId);
          const username = Core.discordUsernameValue(item?.username);
          if (!messageId || !userId || !messageIdsForRequest.includes(messageId)) continue;
          const key = `${route.channelId}:${messageId}`;
          const previousResolvedId = state.resolvedAuthorIds.get(key);
          if (previousResolvedId !== userId ||
            username && state.resolvedAuthorUsernames.get(key) !== username) changed = true;
          state.resolvedAuthorIds.set(key, userId);
          if (username) state.resolvedAuthorUsernames.set(key, username);
          else if (previousResolvedId !== userId) {
            state.resolvedAuthorUsernames.delete(key);
            changed = true;
          }
          const archived = state.archive.records.find((record) => Core.recordKey(record) === key);
          if (archived && (archived.authorId !== userId || username && archived.authorUsername !== username)) {
            const nextArchived = Object.assign({}, archived, { authorId: userId });
            if (username) nextArchived.authorUsername = username;
            else if (archived.authorId !== userId) delete nextArchived.authorUsername;
            queueRecord(Core.sanitizeRecordPresentation(nextArchived));
          }
        }
        while (state.resolvedAuthorIds.size > 5000) state.resolvedAuthorIds.delete(state.resolvedAuthorIds.keys().next().value);
        while (state.resolvedAuthorUsernames.size > 5000) {
          state.resolvedAuthorUsernames.delete(state.resolvedAuthorUsernames.keys().next().value);
        }
        while (state.authorResolutionAttempts.size > 5000) state.authorResolutionAttempts.delete(state.authorResolutionAttempts.keys().next().value);
        if (changed) requestAnimationFrame(() => snapshotRenderedMessages(true));
      }).finally(() => {
        if (state.pendingAuthorResolutionIds.size) queueAuthorResolution(state.route?.channelId, []);
      });
    }, 40);
  }

  function allContent(node, messageId) {
    const parts = [];
    const seen = new Set();
    const add = (element, preserveFormatting) => {
      const raw = preserveFormatting && typeof element?.innerText === "string" ? element.innerText : element?.textContent;
      const text = preserveFormatting
        ? String(raw || "").replace(/\r\n?/g, "\n")
        : Core.normalizeText(raw);
      if (text && !seen.has(text)) { seen.add(text); parts.push(text); }
    };
    const exact = node.querySelector(`[id="message-content-${messageId}"]`) || document.getElementById(`message-content-${messageId}`);
    if (exact && node.contains(exact)) {
      add(exact, true);
    } else {
      // Fallback for an unsupported Discord variant; exclude obvious reply-preview descendants.
      node.querySelectorAll("[class*='messageContent_']").forEach((element) => {
        if (!element.closest("[class*='repliedMessage_'], [class*='reply_']")) add(element, true);
      });
    }
    node.querySelectorAll([
      "[class*='embedProvider_']", "[class*='embedAuthorName_']", "[class*='embedTitle_']",
      "[class*='embedDescription_']", "[class*='embedFieldName_']", "[class*='embedFieldValue_']",
      "[class*='embedFooterText_']"
    ].join(",")).forEach((element) => {
      if (!element.closest("[class*='repliedMessage_'], [class*='reply_']")) add(element);
    });
    node.querySelectorAll("[class*='actionRow_'] button, [class*='component_'] button, [class*='buttons_'] button").forEach((element) => {
      if (!element.closest("[class*='repliedMessage_'], [class*='reply_']")) add(element);
    });
    return parts.join("\n");
  }

  function captureMedia(node, messageId) {
    const items = [];
    const itemIndexes = new Map();
    const replySelector = "[class*='repliedMessage_'], [class*='reply_']";
    const mediaAncestorSelector = [
      "[class*='attachment_']", "[class*='imageWrapper_']", "[class*='mosaicItem_']",
      "[class*='oneByOneGrid_']", "[class*='video_']", "[class*='audioAttachment_']",
      "[class*='embedMedia_']", "[class*='embedThumbnail_']", "[class*='embedWrapper_']",
      "[class*='embedFull_']", "[class*='sticker_']", "[class*='stickerAsset_']", "[data-type='sticker']"
    ].join(",");
    const messageContent = node.querySelector(`[id="message-content-${messageId}"]`) ||
      [...node.querySelectorAll("[class*='messageContent_']")].find((element) => !element.closest(replySelector));
    const add = (raw) => {
      const value = Core.sanitizeMediaItems([raw])[0];
      if (!value) return;
      const identity = Core.mediaIdentity(value.url);
      const existingIndex = itemIndexes.get(identity);
      if (existingIndex !== undefined) {
        const existing = items[existingIndex];
        const merged = Object.assign({}, existing, {
          kind: existing.kind === "file" || existing.kind === "link" ? value.kind : existing.kind,
          alt: existing.alt || value.alt,
          mimeType: existing.mimeType || value.mimeType,
          width: Math.max(existing.width || 0, value.width || 0),
          height: Math.max(existing.height || 0, value.height || 0),
          posterUrl: existing.posterUrl || value.posterUrl,
          cacheable: existing.cacheable !== false || value.cacheable !== false,
          spoiler: Boolean(existing.spoiler || value.spoiler)
        });
        items[existingIndex] = Core.sanitizeMediaItems([merged])[0] || existing;
        return;
      }
      itemIndexes.set(identity, items.length);
      items.push(value);
    };
    const nameFromUrl = (url, fallback) => {
      try { return Core.safeMediaName(decodeURIComponent(new URL(url).pathname.split("/").pop() || fallback)); }
      catch (_error) { return Core.safeMediaName(fallback); }
    };

    node.querySelectorAll("a[href]").forEach((anchor) => {
      if (anchor.closest(replySelector)) return;
      const url = Core.safeMediaUrl(anchor.href);
      if (!url) return;
      const pathname = new URL(url).pathname;
      const attachment = /\/(?:ephemeral-)?attachments\/\d{15,25}\/\d{15,25}\//.test(pathname) ||
        /\/(?:ephemeral-)?attachments\//.test(pathname);
      const inEmbed = Boolean(anchor.closest("[class*='embedWrapper_'], [class*='embedFull_']"));
      if (!attachment && !inEmbed && !(messageContent && messageContent.contains(anchor))) return;
      let kind = Core.mediaKindFromUrl(url);
      if (attachment && kind === "link") kind = "file";
      const text = Core.normalizeText(anchor.textContent);
      add({
        url,
        kind,
        source: attachment ? "attachment" : inEmbed ? "embed" : "link",
        name: text || nameFromUrl(url, kind),
        alt: anchor.getAttribute("aria-label") || anchor.title,
        cacheable: attachment || kind !== "link",
        spoiler: Boolean(anchor.closest("[class*='spoiler']"))
      });
    });

    node.querySelectorAll("img, video, audio, source[src], source[srcset]").forEach((element) => {
      if (element.closest(replySelector) || !element.closest(mediaAncestorSelector)) return;
      if (element.closest("[class*='avatar_'], [class*='emoji'], [class*='reaction']")) return;
      const tag = element.tagName.toLocaleLowerCase();
      const parentMedia = tag === "source" ? element.closest("video, audio") : element;
      const kind = parentMedia?.tagName === "VIDEO" ? "video" : parentMedia?.tagName === "AUDIO" ? "audio" : "image";
      const url = [
        element.currentSrc,
        element.getAttribute("src"),
        ...String(element.getAttribute("srcset") || "").split(",")
          .map((candidate) => candidate.trim().split(/\s+/, 1)[0]),
        parentMedia?.currentSrc,
        parentMedia?.getAttribute("src")
      ].map((value) => Core.safeMediaUrl(value)).find(Boolean) || null;
      const posterUrl = kind === "video" ? Core.safeMediaUrl(parentMedia?.poster) : null;
      if (!url) {
        // A video with child <source> nodes is captured by those source nodes;
        // do not emit a duplicate poster-only image first.
        if (posterUrl && parentMedia?.querySelector("source[src]")) return;
        if (posterUrl) add({
          url: posterUrl,
          kind: "image",
          source: "embed",
          name: Core.safeMediaName(parentMedia?.getAttribute("aria-label")) || nameFromUrl(posterUrl, "Video preview"),
          alt: parentMedia?.getAttribute("aria-label") || "Video preview",
          cacheable: true,
          spoiler: Boolean(element.closest("[class*='spoiler']"))
        });
        return;
      }
      add({
        url,
        kind,
        source: /\/(?:ephemeral-)?attachments\//.test(new URL(url).pathname) ? "attachment" : "embed",
        name: Core.safeMediaName(element.getAttribute("alt") || element.getAttribute("aria-label")) || nameFromUrl(url, kind),
        alt: element.getAttribute("alt") || element.getAttribute("aria-label"),
        posterUrl,
        width: Number(element.naturalWidth || element.videoWidth || element.width || 0),
        height: Number(element.naturalHeight || element.videoHeight || element.height || 0),
        cacheable: true,
        spoiler: Boolean(element.closest("[class*='spoiler']"))
      });
    });

    node.querySelectorAll("iframe[src]").forEach((frame) => {
      if (frame.closest(replySelector) || !frame.closest("[class*='embedWrapper_'], [class*='embedFull_']")) return;
      const url = Core.safeMediaUrl(frame.src);
      if (url) add({ url, kind: "link", source: "embed", name: frame.title || new URL(url).hostname, cacheable: false });
    });
    return Core.sanitizeMediaItems(items);
  }

  function visibleChannelName() {
    for (const selector of ["main h1", "[class*='titleWrapper_'] h1", "[class*='title_'] [class*='channelName_']"]) {
      const text = Core.normalizeText(document.querySelector(selector)?.textContent);
      if (text) return text;
    }
    return "";
  }

  function normalizedAvatarUrl(value) {
    return Core.safeDiscordAssetUrl(value);
  }

  function safeAvatarUrl(node) {
    const image = node.querySelector("img[class*='avatar_'], [class*='avatar_'] img");
    return normalizedAvatarUrl(image?.currentSrc || image?.getAttribute("src") || "");
  }

  function visibleElementText(element) {
    if (!element) return "";
    const clone = element.cloneNode(true);
    clone.querySelectorAll("[aria-hidden='true']").forEach((hidden) => hidden.remove());
    return Core.normalizeText(clone.textContent);
  }

  function safeCssValue(value, maxLength) {
    return Core.safePresentationCss(value, maxLength);
  }

  function safeColor(value) {
    return Core.safePresentationColor(value);
  }

  function safeGradient(value) {
    return Core.safePresentationGradient(value);
  }

  function captureAuthorAnimation(element) {
    if (!element || typeof element.getAnimations !== "function") return null;
    const allowedProperties = [
      "backgroundPosition", "backgroundPositionX", "backgroundPositionY", "color", "filter",
      "opacity", "textShadow", "transform"
    ];
    try {
      for (const animation of element.getAnimations()) {
        const effect = animation.effect;
        if (!effect || typeof effect.getKeyframes !== "function" || typeof effect.getTiming !== "function") continue;
        const frames = effect.getKeyframes().slice(0, 16).map((frame) => {
          const kept = {};
          if (Number.isFinite(frame.offset) && frame.offset >= 0 && frame.offset <= 1) kept.offset = frame.offset;
          for (const property of allowedProperties) {
            const value = safeCssValue(frame[property], 240);
            if (value) kept[property] = value;
          }
          return kept;
        }).filter((frame) => Object.keys(frame).some((key) => key !== "offset"));
        const timing = effect.getTiming();
        const duration = Number(timing.duration);
        if (frames.length < 2 || !Number.isFinite(duration) || duration <= 0 || duration > 60000) continue;
        const iterations = timing.iterations === Infinity ? -1 : Number(timing.iterations);
        return {
          frames,
          timing: {
            duration,
            delay: Number.isFinite(Number(timing.delay)) ? Math.max(-60000, Math.min(60000, Number(timing.delay))) : 0,
            iterations: iterations === -1 ? -1 : Number.isFinite(iterations) ? Math.max(0, Math.min(1000, iterations)) : 1,
            direction: ["normal", "reverse", "alternate", "alternate-reverse"].includes(timing.direction) ? timing.direction : "normal",
            fill: ["none", "forwards", "backwards", "both", "auto"].includes(timing.fill) ? timing.fill : "none",
            easing: safeCssValue(timing.easing, 120) || "linear"
          }
        };
      }
    } catch (_error) {
      return null;
    }
    return null;
  }

  function describedLabel(element) {
    const direct = Core.normalizeText(element.getAttribute("aria-label"));
    if (direct) return direct.slice(0, 120);
    const id = (element.getAttribute("aria-describedby") || "").split(/\s+/).find(Boolean);
    return Core.normalizeText(id && document.getElementById(id)?.textContent).slice(0, 120);
  }

  function captureVectorBadge(element, svg) {
    const paths = [...svg.querySelectorAll("path")].slice(0, 12).map((path) => {
      const d = String(path.getAttribute("d") || "");
      if (!d || d.length > 3000 || !/^[MmZzLlHhVvCcSsQqTtAa0-9eE+.,\-\s]+$/.test(d)) return null;
      const rawFill = String(path.getAttribute("fill") || "currentColor");
      const rawStroke = String(path.getAttribute("stroke") || "");
      return {
        d,
        fill: safeColor(rawFill) || (rawFill.startsWith("var(") ? "currentColor" : "currentColor"),
        stroke: safeColor(rawStroke),
        fillRule: ["evenodd", "nonzero"].includes(path.getAttribute("fill-rule")) ? path.getAttribute("fill-rule") : null,
        clipRule: ["evenodd", "nonzero"].includes(path.getAttribute("clip-rule")) ? path.getAttribute("clip-rule") : null
      };
    }).filter(Boolean);
    if (!paths.length) return null;
    const width = Math.max(12, Math.min(24, Number(svg.getAttribute("width")) || 20));
    const height = Math.max(12, Math.min(24, Number(svg.getAttribute("height")) || 20));
    const viewBox = String(svg.getAttribute("viewBox") || "0 0 24 24");
    if (!/^-?\d+(?:\.\d+)?(?:\s+-?\d+(?:\.\d+)?){3}$/.test(viewBox)) return null;
    return { kind: "vector", label: describedLabel(element), viewBox, width, height, paths };
  }

  function captureAuthorBadges(authorElement) {
    const wrapper = authorElement?.closest("[id^='message-username-']");
    if (!wrapper) return [];
    const badges = [];
    const candidates = new Set([...wrapper.children]);
    if (wrapper.parentElement) {
      for (const sibling of wrapper.parentElement.children) {
        if (sibling !== wrapper && !sibling.matches("time")) candidates.add(sibling);
      }
    }
    for (const child of candidates) {
      if (child === authorElement || child.contains(authorElement) || child.matches("[class*='hiddenVisually_'], [aria-hidden='true'], [data-ldma-author-actions]")) continue;
      const label = describedLabel(child);
      const appText = Core.normalizeText((child.matches("[class*='botText_']") ? child : child.querySelector("[class*='botText_']"))?.textContent);
      if (/\bapp\b/i.test(label) || appText) {
        badges.push({ kind: "app", label: (appText || "APP").slice(0, 12), verified: Boolean(child.matches("svg") || child.querySelector("svg")) });
        continue;
      }
      const images = (child.matches("img") ? [child] : [...child.querySelectorAll("img")]).slice(0, 3);
      for (const image of images) {
        const url = normalizedAvatarUrl(image.currentSrc || image.getAttribute("src"));
        if (!url) continue;
        badges.push({
          kind: "image", url, label: Core.normalizeText(image.alt || label).slice(0, 120),
          width: Math.max(12, Math.min(24, Number(image.getAttribute("width")) || 20)),
          height: Math.max(12, Math.min(24, Number(image.getAttribute("height")) || 20))
        });
      }
      if (images.length) continue;
      const svg = child.matches("svg") ? child : child.querySelector("svg");
      if (svg) {
        const vector = captureVectorBadge(child, svg);
        if (vector) badges.push(vector);
        continue;
      }
      if (!label && !/botTag|roleIcon|clanTag|guildTag|badge/i.test(child.className || "")) continue;
      const text = Core.normalizeText(child.innerText).slice(0, 24);
      if (text) {
        const style = getComputedStyle(child);
        badges.push({
          kind: "text", text, label,
          color: safeColor(style.color), backgroundColor: safeColor(style.backgroundColor),
          borderRadius: safeCssValue(style.borderRadius, 40)
        });
      }
      if (badges.length >= 8) break;
    }
    return badges.slice(0, 8);
  }

  function captureAuthorStyle(element) {
    if (!element) return null;
    try {
      const style = getComputedStyle(element);
      return {
        color: safeColor(style.color),
        gradient: safeGradient(style.backgroundImage),
        backgroundSize: safeCssValue(style.backgroundSize, 120),
        backgroundPosition: safeCssValue(style.backgroundPosition, 120),
        textFillColor: safeColor(style.getPropertyValue("-webkit-text-fill-color")),
        fontWeight: /^(?:normal|bold|[1-9]00)$/.test(style.fontWeight) ? style.fontWeight : null,
        textShadow: safeCssValue(style.textShadow, 240),
        animation: captureAuthorAnimation(element)
      };
    } catch (_error) {
      return null;
    }
  }

  function presentationFromNode(node, timeElement) {
    const route = Core.parseDiscordRoute(location.pathname);
    const identity = rowIdentity(node);
    const authorElement = authorNameElement(node);
    const authorStyle = captureAuthorStyle(authorElement);
    const presentationRow = authorElement?.closest(MESSAGE_SELECTOR) || node;
    const reply = node.querySelector("[class*='repliedMessage_'], [class*='reply_']");
    const avatarUrl = safeAvatarUrl(presentationRow);
    return {
      avatarUrl,
      authorId: resolvedAuthorId(route?.channelId, identity?.messageId,
        authorIdFromNode(presentationRow, authorElement, avatarUrl)),
      authorUsername: resolvedAuthorUsername(route?.channelId, identity?.messageId, null),
      authorColor: authorStyle?.color || null,
      authorStyle,
      authorBadges: captureAuthorBadges(authorElement),
      displayTimestamp: visibleElementText(timeElement) || null,
      replyPreview: Core.normalizeText(reply?.textContent).slice(0, 500) || null
    };
  }

  function recordFromNode(node, now) {
    const route = Core.parseDiscordRoute(location.pathname);
    const identity = rowIdentity(node);
    if (!route || !identity || (identity.channelId && identity.channelId !== route.channelId)) return null;
    const media = captureMedia(node, identity.messageId);
    const attachments = media.filter((item) => item.source === "attachment").map((item) => item.name).slice(0, 12);
    const content = allContent(node, identity.messageId);
    if (!content && !attachments.length && !media.length) return null;
    const timeElement = node.querySelector("time[datetime]");
    const groupRootMessageId = groupRootFromNode(node, identity.messageId);
    return Core.sanitizeRecordPresentation(Object.assign({
      messageId: identity.messageId, channelId: route.channelId, guildId: route.guildId,
      channelName: visibleChannelName(),
      author: visibleElementText(authorNameElement(node)) || firstText(node, AUTHOR_SELECTORS) ||
        authorFromAriaLabelledBy(node) || "Unknown author",
      content, attachments, media, messageTimestamp: timeElement?.getAttribute("datetime") || null,
      groupRootMessageId,
      sourceContinuation: Boolean(groupRootMessageId && groupRootMessageId !== identity.messageId),
      capturedAt: now, updatedAt: now, status: "seen",
      captureSessionId, captureSequence: captureSequence += 1
    }, presentationFromNode(node, timeElement)));
  }

  function recordSignature(record) {
    return JSON.stringify([
      record.author, record.content, record.messageTimestamp, record.channelName, record.attachments,
      record.avatarUrl, record.authorId, record.authorUsername, record.authorColor, record.authorStyle, record.authorBadges,
      record.groupRootMessageId, record.sourceContinuation,
      record.displayTimestamp, record.replyPreview, record.media
    ]);
  }

  function queueRecord(record) {
    const key = Core.recordKey(record);
    const signature = recordSignature(record);
    if (state.signatures.get(key) === signature || state.pendingRecords.get(key)?.signature === signature) return;
    state.pendingRecords.set(key, { record, generation: state.generation, signature });
    clearTimeout(state.flushTimer);
    state.flushTimer = setTimeout(flushRecords, 180);
  }

  function flushRecords() {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
    if (state.flushPromise) return state.flushPromise;
    const pending = [...state.pendingRecords.values()];
    state.pendingRecords.clear();
    if (!pending.length) return Promise.resolve();
    const run = (async () => {
      const groups = new Map();
      for (const item of pending) {
        if (!groups.has(item.generation)) groups.set(item.generation, []);
        groups.get(item.generation).push(item);
      }
      for (const [generation, items] of groups) {
        const records = items.map((item) => item.record);
        const response = await send({ type: T.UPSERT_RECORDS, generation, records });
        if (response.ok && generation === state.generation) {
          const persistedKeys = new Set((response.archive?.records || []).map(Core.recordKey));
          for (const item of items) {
            if (persistedKeys.has(Core.recordKey(item.record))) state.signatures.set(Core.recordKey(item.record), item.signature);
          }
          const mediaKeys = records.filter((record) => record.media?.some((item) => item.cacheable))
            .map(Core.recordKey).filter((key) => persistedKeys.has(key));
          if (mediaKeys.length) send({ type: T.CACHE_MEDIA, generation, keys: mediaKeys }).catch(() => {});
        }
        if (!response.ok && (response.reason === "broker-unavailable" || response.reason === "broker-error")) {
          for (const item of items) {
            if (generation === state.generation) state.pendingRecords.set(Core.recordKey(item.record), item);
          }
        }
        if (response.archive) applyArchive(response.archive);
      }
    })();
    state.flushPromise = run.finally(() => {
      state.flushPromise = null;
      if (state.pendingRecords.size && !state.flushTimer) state.flushTimer = setTimeout(flushRecords, 1000);
    });
    return state.flushPromise;
  }

  async function flushAllRecords() {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await flushRecords();
      if (!state.pendingRecords.size) return;
    }
  }

  function applyArchive(archive) {
    if (!archive || !Array.isArray(archive.records)) return;
    if (!Protocol.shouldApplyArchive(state.archive, archive)) return;
    const incomingGeneration = Number.isInteger(archive.generation) ? archive.generation : 0;
    const wasPaused = state.paused;
    const nextKeys = new Set(archive.records.map(Core.recordKey));
    const releasedByChannel = new Map();
    for (const record of state.archive.records) {
      if (record.deletionSource !== "message_store_preserved" || nextKeys.has(Core.recordKey(record))) continue;
      const key = Core.recordKey(record);
      state.pendingReleaseKeys.add(key);
      if (!releasedByChannel.has(record.channelId)) releasedByChannel.set(record.channelId, []);
      releasedByChannel.get(record.channelId).push(record.messageId);
    }
    for (const [channelId, ids] of releasedByChannel) {
      for (let offset = 0; offset < ids.length; offset += 200) {
        window.postMessage({ bridge: BRIDGE, kind: "release", channelId, ids: ids.slice(offset, offset + 200) }, "*");
      }
    }
    if (incomingGeneration > state.generation) {
      state.snapshots = new WeakMap();
      state.snapshotsByKey.clear();
      state.recentRemovals.clear();
      state.pendingRetainedKeys.clear();
      state.pendingConfirmedMounts.clear();
      state.pendingEdits.clear();
      state.stagedSelfEdits.clear();
      state.pendingRecords.clear();
      state.signatures.clear();
      removeEditHistories();
    }
    state.archive = archive;
    state.generation = incomingGeneration;
    state.paused = Boolean(archive.paused);
    if (state.paused) removeLiveAuthorActions();
    if (wasPaused && !state.paused) state.lastMediaRecoveryAt = -Infinity;
    requestMediaRecovery(archive);
    reconcileTombstones();
    reconcileEditHistories();
    applyRetainedStyles();
    if (wasPaused && !state.paused) requestAnimationFrame(() => snapshotRenderedMessages(true));
  }

  function requestMediaRecovery(archive) {
    if (!archive || archive.paused || performance.now() - state.lastMediaRecoveryAt < 5 * 60 * 1000) return;
    const keys = archive.records.filter((record) => [record, ...(record.editHistory || [])]
      .some((version) => version.media?.some((item) => item.cacheable)))
      .map(Core.recordKey);
    state.lastMediaRecoveryAt = performance.now();
    for (let offset = 0; offset < keys.length; offset += 200) {
      send({
        type: T.CACHE_MEDIA,
        generation: archive.generation,
        keys: keys.slice(offset, offset + 200)
      }).catch(() => {});
    }
  }

  async function refreshArchive() {
    if (state.refreshPromise) return state.refreshPromise;
    state.refreshPromise = send({ type: T.GET_ARCHIVE }).then((response) => {
      if (response.archive) applyArchive(response.archive);
    }).finally(() => { state.refreshPromise = null; });
    return state.refreshPromise;
  }

  function dropTombstoneRenderer(key) {
    const renderer = state.tombstoneRenderers.get(key);
    if (renderer?.dispose) renderer.dispose();
    state.tombstoneRenderers.delete(key);
  }

  function removeTombstone(key) {
    if (key) dropTombstoneRenderer(key);
    else for (const rendererKey of [...state.tombstoneRenderers.keys()]) dropTombstoneRenderer(rendererKey);
    document.querySelectorAll("[data-ldma-tombstone]").forEach((element) => {
      if (!key || element.dataset.ldmaMessageKey === key) {
        element.remove();
      }
    });
    scheduleTombstoneSpacing();
  }

  function findMessage(messageId, rows) {
    return rows.find((node) => rowIdentity(node)?.messageId === messageId) || null;
  }

  function findMountedTombstone(channelId, messageId, activeRoot) {
    const key = `${channelId}:${messageId}`;
    return [...document.querySelectorAll("[data-ldma-tombstone]")]
      .find((element) => element.dataset.ldmaMessageKey === key && (!activeRoot || activeRoot.contains(element))) || null;
  }

  function findPositionedMessage(channelId, messageId, rows, activeRoot) {
    return findMessage(messageId, rows) || findMountedTombstone(channelId, messageId, activeRoot);
  }

  function retainedRow(channelId, messageId, activeRoot) {
    const candidates = [
      ...document.querySelectorAll(`[id="chat-messages-${channelId}-${messageId}"]`),
      ...document.querySelectorAll(`[data-list-item-id="chat-messages___${channelId}-${messageId}"]`)
    ].map((node) => node.closest("li[id^='chat-messages-']") || node);
    return candidates.find((node) => !activeRoot || activeRoot.contains(node)) || null;
  }

  function applyRetainedStyles() {
    const route = Core.parseDiscordRoute(location.pathname);
    const retainedIds = new Set(state.archive.records.filter((record) =>
      record.channelId === route?.channelId && record.status === "confirmed_deleted" &&
      record.deletionSource === "message_store_preserved").map((record) => record.messageId));
    for (const key of state.pendingRetainedKeys) {
      const [channelId, messageId] = key.split(":");
      if (channelId === route?.channelId) retainedIds.add(messageId);
    }
    document.querySelectorAll(".ldma-retained-deleted").forEach((row) => {
      const identity = rowIdentity(row);
      if (!identity || identity.channelId !== route?.channelId || !retainedIds.has(identity.messageId)) {
        row.classList.remove("ldma-retained-deleted");
      }
    });
    document.querySelectorAll("[data-ldma-native-replaced]").forEach((row) => {
      const identity = rowIdentity(row);
      const key = identity && `${identity.channelId || route?.channelId}:${identity.messageId}`;
      if (!identity || identity.channelId !== route?.channelId ||
        (!retainedIds.has(identity.messageId) && !state.pendingReleaseKeys.has(key))) {
        row.removeAttribute("data-ldma-native-replaced");
      }
    });
    for (const key of [...state.pendingReleaseKeys]) {
      const [channelId, messageId] = key.split(":");
      if (channelId === route?.channelId && !retainedRow(channelId, messageId)) state.pendingReleaseKeys.delete(key);
    }
    if (!route) return;
    for (const messageId of retainedIds) retainedRow(route.channelId, messageId)?.classList.add("ldma-retained-deleted");
    requestAnimationFrame(replaceVisibleRetainedRows);
  }

  function replaceText(element, value) {
    element.replaceChildren(document.createTextNode(String(value || "")));
  }

  function suppressDiscordMessageGesture(element) {
    for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "keydown"]) {
      element.addEventListener(eventName, (event) => event.stopPropagation());
    }
  }

  function legacyCopyText(value) {
    const textArea = document.createElement("textarea");
    textArea.value = value;
    textArea.setAttribute("readonly", "");
    textArea.style.position = "fixed";
    textArea.style.left = "-9999px";
    document.body.append(textArea);
    textArea.select();
    let copied = false;
    try { copied = document.execCommand("copy"); } catch (_error) {}
    textArea.remove();
    return copied;
  }

  async function copyDiscordUsername(value) {
    const username = Core.discordUsernameValue(value);
    if (!username) return false;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard-api-unavailable");
      await navigator.clipboard.writeText(username);
      return true;
    } catch (_error) {
      return legacyCopyText(username);
    }
  }

  async function resolveActionAuthorIdentity(context, allowStoredFallback) {
    if (!context || state.route?.channelId !== context.channelId || !SNOWFLAKE.test(String(context.messageId || ""))) return null;
    const fallback = resolvedAuthorIdentity(
      context.channelId, context.messageId, context.userId, context.username);
    const routeKey = state.route.routeKey;
    const response = await send({ type: RESOLVE_MESSAGE_AUTHORS, messageIds: [context.messageId] });
    if (!response?.ok || state.route?.routeKey !== routeKey) {
      return allowStoredFallback ? Object.assign({ reason: response?.reason || "message-author-resolution-failed" }, fallback) : null;
    }
    const match = (Array.isArray(response.authors) ? response.authors : []).find((item) =>
      item?.messageId === context.messageId && SNOWFLAKE.test(String(item?.userId || "")));
    if (!match) {
      state.resolvedAuthorIds.delete(`${context.channelId}:${context.messageId}`);
      state.resolvedAuthorUsernames.delete(`${context.channelId}:${context.messageId}`);
      return allowStoredFallback ? Object.assign({ reason: response?.reason || "message-author-missing" }, fallback) : null;
    }
    const key = `${context.channelId}:${context.messageId}`;
    const matchedUserId = String(match.userId);
    const identity = {
      userId: matchedUserId,
      // A legacy page-world controller can return the newly verified ID but
      // not the newer username field. Preserve an already cached username only
      // when it belongs to that exact verified author.
      username: Core.discordUsernameValue(match.username) ||
        (fallback.userId === matchedUserId ? fallback.username : null),
      reason: response.reason || "message-authors-resolved"
    };
    const previousResolvedId = state.resolvedAuthorIds.get(key);
    state.resolvedAuthorIds.set(key, identity.userId);
    if (identity.username) state.resolvedAuthorUsernames.set(key, identity.username);
    else if (previousResolvedId !== identity.userId) {
      state.resolvedAuthorUsernames.delete(key);
    }
    const archived = state.archive.records.find((record) => Core.recordKey(record) === key);
    if (archived && (archived.authorId !== identity.userId ||
      identity.username && archived.authorUsername !== identity.username)) {
      const nextArchived = Object.assign({}, archived, { authorId: identity.userId });
      if (identity.username) nextArchived.authorUsername = identity.username;
      else if (archived.authorId !== identity.userId) delete nextArchived.authorUsername;
      queueRecord(Core.sanitizeRecordPresentation(nextArchived));
    }
    while (state.resolvedAuthorIds.size > 5000) state.resolvedAuthorIds.delete(state.resolvedAuthorIds.keys().next().value);
    while (state.resolvedAuthorUsernames.size > 5000) {
      state.resolvedAuthorUsernames.delete(state.resolvedAuthorUsernames.keys().next().value);
    }
    return identity;
  }

  function createAuthorActionControls(label, getContext) {
    const actions = document.createElement("span");
    actions.className = "author-actions";
    actions.dataset.ldmaAuthorActions = "true";
    actions.setAttribute("role", "toolbar");
    actions.setAttribute("aria-label", label);
    const copyAction = document.createElement("button");
    copyAction.type = "button";
    copyAction.className = "author-action copy-username";
    copyAction.textContent = "@";
    copyAction.title = "Copy Discord username";
    copyAction.setAttribute("aria-label", "Copy Discord username");
    const timeoutAction = document.createElement("button");
    timeoutAction.type = "button";
    timeoutAction.className = "author-action timeout";
    timeoutAction.textContent = "7d";
    timeoutAction.title = "Timeout for 7 days";
    timeoutAction.setAttribute("aria-label", "Timeout user for 7 days");
    const status = document.createElement("span");
    status.className = "author-action-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    actions.append(copyAction, timeoutAction, status);
    suppressDiscordMessageGesture(actions);

    let copyBusy = false;
    let timeoutBusy = false;
    const feedbackTimers = new Map();
    const feedback = (button, text, title, error) => {
      clearTimeout(feedbackTimers.get(button));
      button.textContent = text;
      button.title = title;
      button.classList.toggle("error", Boolean(error));
      status.textContent = title;
      feedbackTimers.set(button, setTimeout(() => {
        button.textContent = button === copyAction ? "@" : "7d";
        button.title = button === copyAction ? "Copy Discord username" : "Timeout for 7 days";
        button.classList.remove("error");
        if (![...feedbackTimers.keys()].some((candidate) => candidate !== button)) status.textContent = "";
        feedbackTimers.delete(button);
      }, 1800));
    };
    const currentContext = () => {
      const context = getContext();
      if (!context || state.route?.channelId !== context.channelId || !SNOWFLAKE.test(String(context.messageId || "")) ||
        (typeof context.isCurrent === "function" && !context.isCurrent())) return null;
      return context;
    };

    copyAction.addEventListener("click", async () => {
      if (copyBusy) return;
      copyBusy = true;
      copyAction.disabled = true;
      const context = currentContext();
      let username = Core.discordUsernameValue(context?.username);
      let copied = Boolean(username && currentContext() && await copyDiscordUsername(username));
      let resolutionReason = null;
      if (!copied && currentContext()) {
        const identity = await resolveActionAuthorIdentity(context, true);
        resolutionReason = identity?.reason || null;
        username = Core.discordUsernameValue(identity?.username);
        copied = Boolean(username && currentContext() && await copyDiscordUsername(username));
      }
      const unavailableTitle = resolutionReason === "message-store-unavailable"
        ? "Discord message data unavailable"
        : resolutionReason === "message-author-resolution-failed"
          ? "Discord author resolver unavailable"
          : "Discord username unavailable";
      feedback(copyAction, copied ? "✓" : "!", copied ? "Discord username copied" :
        username ? "Clipboard access unavailable" : unavailableTitle, !copied);
      copyAction.disabled = false;
      copyBusy = false;
    });

    timeoutAction.addEventListener("click", async () => {
      if (timeoutBusy) return;
      timeoutBusy = true;
      timeoutAction.disabled = true;
      const context = currentContext();
      // A tombstone can outlive Discord's MessageStore after reload. Use its
      // stored ID as the candidate; the background independently proves that
      // candidate against MessageStore or the exact deleted archive record.
      const identity = context && await resolveActionAuthorIdentity(context, true);
      const userId = identity?.userId;
      if (!userId || !context?.guildId || !currentContext()) {
        feedback(timeoutAction, "!", "Timeout unavailable", true);
        timeoutAction.disabled = false;
        timeoutBusy = false;
        return;
      }
      const timeoutKey = `${context.guildId}:${userId}`;
      if (state.pendingTimeoutActions.has(timeoutKey)) {
        feedback(timeoutAction, "…", "Timeout already in progress", false);
        timeoutAction.disabled = false;
        timeoutBusy = false;
        return;
      }
      state.pendingTimeoutActions.add(timeoutKey);
      const author = Core.normalizeText(context.author || "Unknown author").slice(0, 100) || "Unknown author";
      try {
        const confirmed = window.confirm(`Timeout ${author} (${userId}) for 7 days?`);
        const latest = currentContext();
        if (!confirmed || !latest || latest.channelId !== context.channelId || latest.messageId !== context.messageId ||
          latest.guildId !== context.guildId) return;
        const response = await send({
          type: "LDMA_USER_ACTION",
          action: "timeout-7d",
          userId,
          guildId: context.guildId,
          messageId: context.messageId
        });
        feedback(timeoutAction, response?.ok ? "✓" : "!", response?.ok ? `Timed out ${author} for 7 days` : "Timeout unavailable", !response?.ok);
      } finally {
        state.pendingTimeoutActions.delete(timeoutKey);
        timeoutAction.disabled = false;
        timeoutBusy = false;
      }
    });

    const update = (context) => {
      actions.hidden = !context || !SNOWFLAKE.test(String(context.messageId || ""));
      timeoutAction.hidden = !SNOWFLAKE.test(String(context?.guildId || ""));
      if (context && (!state.resolvedAuthorIds.has(`${context.channelId}:${context.messageId}`) ||
        !state.resolvedAuthorUsernames.has(`${context.channelId}:${context.messageId}`))) {
        queueAuthorResolution(context.channelId, [context.messageId]);
      }
    };
    update.dispose = () => {
      for (const timer of feedbackTimers.values()) clearTimeout(timer);
      feedbackTimers.clear();
    };
    return { actions, copyAction, timeoutAction, update };
  }

  function nativeHeaderActionInsertion(row, messageId) {
    if (!row || !messageId) return null;
    const username = row.querySelector(`[id="message-username-${messageId}"]`);
    if (!username) return null;
    const exactTimestamp = row.querySelector(`[id="message-timestamp-${messageId}"]`);
    const time = exactTimestamp?.querySelector?.("time[datetime]") || exactTimestamp ||
      [...row.querySelectorAll("time[datetime]")].find((candidate) =>
        !candidate.closest("[class*='repliedMessage_'], [class*='reply_']"));
    if (!time) return null;
    let header = username.parentElement;
    for (let depth = 0; header && header !== row && depth < 5; depth += 1, header = header.parentElement) {
      if (!header.contains(time)) continue;
      let timestampBranch = time;
      while (timestampBranch.parentElement && timestampBranch.parentElement !== header) {
        timestampBranch = timestampBranch.parentElement;
      }
      return timestampBranch.parentElement === header ? { header, timestampBranch } : null;
    }
    return null;
  }

  function removeLiveAuthorActions() {
    for (const renderer of state.liveActionRenderers.values()) renderer.dispose();
    state.liveActionRenderers.clear();
    document.querySelectorAll("[data-ldma-author-actions-host]").forEach((host) => host.remove());
  }

  function createLiveAuthorActionRenderer(row, identity, insertion, route) {
    const key = `${route.channelId}:${identity.messageId}`;
    const host = document.createElement("span");
    host.dataset.ldmaAuthorActionsHost = "true";
    host.dataset.ldmaAuthorActions = "true";
    host.dataset.ldmaMessageKey = key;
    host.setAttribute("aria-label", "BridgeModTools author actions");
    const shadow = host.attachShadow({ mode: "closed" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      :host { display:inline-flex; vertical-align:middle; }
      * { box-sizing:border-box; }
      .author-actions { display:inline-flex; align-items:center; gap:2px; }
      .author-action { display:inline-grid; place-items:center; min-width:22px; height:20px; margin:0; padding:0 4px; border:0; border-radius:4px; background:#2b2d31; color:#b5bac1; font:700 10px/1 "gg sans","Noto Sans","Helvetica Neue",Helvetica,Arial,sans-serif; cursor:pointer; }
      .author-action:hover { background:#404249; color:#f2f3f5; }
      .author-action.timeout:hover { background:#da373c; color:#fff; }
      .author-action:focus-visible { outline:2px solid #00a8fc; outline-offset:1px; }
      .author-action:disabled { cursor:wait; opacity:.65; }
      .author-action.error { color:#ff6b70; }
      .author-action-status { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
      [hidden] { display:none !important; }
    `);
    shadow.adoptedStyleSheets = [sheet];
    let context = null;
    const controls = createAuthorActionControls("Actions for message author", () => context);
    shadow.append(controls.actions);
    insertion.header.insertBefore(host, insertion.timestampBranch.nextSibling);
    const renderer = {
      host,
      row,
      update(record, route) {
        const authorIdentity = resolvedAuthorIdentity(
          route.channelId, identity.messageId, record?.authorId, record?.authorUsername);
        context = {
          channelId: route.channelId,
          messageId: identity.messageId,
          guildId: route.guildId,
          userId: authorIdentity.userId,
          username: authorIdentity.username,
          author: record?.author || visibleElementText(authorNameElement(row)) || "Unknown author",
          isCurrent: () => Core.messageRowOwnsElement(row, host, identity.messageId) &&
            state.route?.routeKey === route.routeKey
        };
        controls.update(context);
      },
      dispose() {
        controls.update.dispose();
        host.remove();
      }
    };
    state.liveActionRenderers.set(key, renderer);
    return renderer;
  }

  function reconcileLiveAuthorActions(active, records) {
    const managedHosts = new Set([...state.liveActionRenderers.values()].map((renderer) => renderer.host));
    document.querySelectorAll("[data-ldma-author-actions-host]").forEach((host) => {
      if (!managedHosts.has(host)) host.remove();
    });
    const connected = new Set();
    if (active) {
      active.rows.forEach((row, index) => {
        const identity = rowIdentity(row);
        if (!identity || identity.channelId && identity.channelId !== active.route.channelId || row.dataset.ldmaNativeReplaced === "true") return;
        const insertion = nativeHeaderActionInsertion(row, identity.messageId);
        if (!insertion) return;
        const key = `${active.route.channelId}:${identity.messageId}`;
        let renderer = state.liveActionRenderers.get(key);
        if (renderer && (renderer.row !== row || !renderer.host.isConnected || renderer.host.parentElement !== insertion.header)) {
          renderer.dispose();
          state.liveActionRenderers.delete(key);
          renderer = null;
        }
        if (!renderer) renderer = createLiveAuthorActionRenderer(row, identity, insertion, active.route);
        const record = records?.[index] || state.snapshotsByKey.get(key)?.record ||
          state.archive.records.find((item) => Core.recordKey(item) === key) || groupingRecordFromNode(row);
        renderer.update(record, active.route);
        connected.add(key);
      });
    }
    for (const [key, renderer] of [...state.liveActionRenderers]) {
      if (connected.has(key) && renderer.host.isConnected) continue;
      renderer.dispose();
      state.liveActionRenderers.delete(key);
    }
  }

  function storedTime(record) {
    const date = new Date(record.messageTimestamp || record.capturedAt || 0);
    if (Number.isNaN(date.valueOf())) return { display: "", dateTime: "", title: "" };
    return {
      display: record.displayTimestamp || date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
      dateTime: date.toISOString(),
      title: date.toLocaleString()
    };
  }

  function groupingRecordFromNode(node) {
    const identity = rowIdentity(node);
    if (!identity) return null;
    const authorElement = authorNameElement(node);
    const presentationRow = authorElement?.closest(MESSAGE_SELECTOR) || node;
    const avatarUrl = safeAvatarUrl(presentationRow);
    const timeElement = node.querySelector("time[datetime]");
    const groupRootMessageId = groupRootFromNode(node, identity.messageId);
    const reply = node.querySelector("[class*='repliedMessage_'], [class*='reply_']");
    return Core.sanitizeRecordPresentation({
      messageId: identity.messageId,
      channelId: identity.channelId || state.route?.channelId,
      author: visibleElementText(authorElement) || firstText(node, AUTHOR_SELECTORS) ||
        authorFromAriaLabelledBy(node) || "Unknown author",
      avatarUrl,
      // A continuation resolves its author element in the root row. Reading
      // identity from that presentation row is intentional: every member of
      // the native group belongs to the same Discord author.
      authorId: authorIdFromNode(presentationRow, authorElement, avatarUrl),
      authorUsername: resolvedAuthorUsername(identity.channelId || state.route?.channelId, identity.messageId, null),
      messageTimestamp: timeElement?.getAttribute("datetime") || null,
      groupRootMessageId,
      sourceContinuation: Boolean(groupRootMessageId && groupRootMessageId !== identity.messageId),
      replyPreview: Core.normalizeText(reply?.textContent).slice(0, 500) || null
    });
  }

  function reconcileTombstoneGrouping() {
    const archivedByKey = new Map(state.archive.records.map((record) => [Core.recordKey(record), record]));
    const parents = new Set([...document.querySelectorAll("[data-ldma-tombstone]")]
      .map((element) => element.parentElement).filter(Boolean));
    for (const parent of parents) {
      let previous = null;
      for (const element of parent.children) {
        if (element.dataset.ldmaNativeReplaced === "true") continue;
        if (element.dataset.ldmaTombstone === "true") {
          const record = archivedByKey.get(element.dataset.ldmaMessageKey);
          const renderer = state.tombstoneRenderers.get(element.dataset.ldmaMessageKey);
          if (!record || !renderer?.setContinuation) {
            previous = null;
            continue;
          }
          let continues = Core.messageContinues(previous, record);
          const capturedRoot = Core.snowflakeValue(record.groupRootMessageId);
          if (!continues && capturedRoot && capturedRoot !== record.messageId) {
            // A surviving native row may have been promoted to a new full root
            // after this deleted continuation was captured under the old root.
            // Reconcile that stale non-self root only through the strict stable
            // author/day/window fallback. Explicit self roots and replies stay
            // authoritative full-row boundaries.
            continues = Core.messageContinues(previous, record, { ignoreGroupRoot: true });
          }
          renderer.setContinuation(continues);
          previous = record;
          continue;
        }
        const identity = rowIdentity(element);
        if (!identity) {
          // A date divider, system row, thread marker, or other structural
          // child is a real Discord grouping boundary.
          previous = null;
          continue;
        }
        const style = getComputedStyle(element);
        const current = style.display === "none" || style.visibility === "hidden"
          ? null
          : groupingRecordFromNode(element);
        if (!current) {
          previous = null;
          continue;
        }
        // Native Discord rows are presentation-authoritative. If Discord
        // promotes a surviving message to a new group root, keep its avatar,
        // author, badges, and timestamp exactly as Discord rendered them.
        previous = current;
      }
    }
  }

  function applySpacingShift(elements, shift) {
    const scale = Math.max(1, Number(devicePixelRatio) || 1);
    const rounded = Math.round(shift * scale) / scale;
    for (const element of elements) {
      element.dataset.ldmaSpacingShift = String(rounded);
      element.style.setProperty("--ldma-spacing-shift", `${rounded}px`);
    }
  }

  function rebalanceTombstoneSpacing() {
    state.spacingFrame = 0;
    reconcileTombstoneGrouping();
    const parents = new Set([...document.querySelectorAll("[data-ldma-tombstone]")]
      .map((element) => element.parentElement).filter(Boolean));
    for (const parent of parents) {
      const entries = [...parent.children].map((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (style.display === "none" || style.visibility === "hidden" || rect.height <= 0) return null;
        if (element.dataset.ldmaTombstone === "true") return { kind: "tombstone", element, rect };
        return { kind: rowIdentity(element) ? "message" : "structure", element, rect };
      }).filter(Boolean);
      for (let index = 0; index < entries.length;) {
        if (entries[index].kind !== "tombstone") { index += 1; continue; }
        const start = index;
        while (index + 1 < entries.length && entries[index + 1].kind === "tombstone") index += 1;
        const end = index;
        const run = entries.slice(start, end + 1);
        const previous = entries[start - 1];
        const next = entries[end + 1];
        if (!previous || !next || previous.kind !== "message" || next.kind !== "message") {
          applySpacingShift(run.map((entry) => entry.element), 0);
          index += 1;
          continue;
        }
        const first = run[0];
        const last = run[run.length - 1];
        const measuredTop = first.rect.top - previous.rect.bottom;
        const measuredBottom = next.rect.top - last.rect.bottom;
        const firstPriorShift = Number(first.element.dataset.ldmaSpacingShift || 0);
        const lastPriorShift = Number(last.element.dataset.ldmaSpacingShift || 0);
        const shift = Core.balancedTombstoneShift(measuredTop, measuredBottom, firstPriorShift, lastPriorShift);
        applySpacingShift(run.map((entry) => entry.element), shift);
        index += 1;
      }
    }
  }

  function scheduleTombstoneSpacing() {
    if (state.spacingFrame) return;
    state.spacingFrame = requestAnimationFrame(rebalanceTombstoneSpacing);
  }

  function configureMediaFrame(frame, key, revisionId) {
    const onSize = (event) => {
      if (event.source !== frame.contentWindow || event.origin !== extensionFrameOrigin() || event.data?.type !== "LDMA_MEDIA_SIZE") return;
      const width = Math.max(40, Math.min(550, Math.ceil(Number(event.data.width) || 550)));
      const height = Math.max(24, Math.min(1600, Math.ceil(Number(event.data.height) || 40)));
      frame.style.width = `${width}px`;
      frame.style.height = `${height}px`;
      const owner = frame.getRootNode()?.host?.closest?.("[data-ldma-tombstone], [data-ldma-edit-history]");
      if (owner) {
        owner.dataset.ldmaMediaWidth = String(width);
        owner.dataset.ldmaMediaHeight = String(height);
      }
      scheduleTombstoneSpacing();
    };
    window.addEventListener("message", onSize);
    frame.addEventListener("load", () => {
      send({ type: T.CREATE_MEDIA_CAPABILITY, key, revisionId: revisionId || undefined }).then((response) => {
        if (!response.ok || !response.capability || !frame.contentWindow || !frame.src) return;
        frame.contentWindow.postMessage({
          type: "LDMA_MEDIA_CAPABILITY",
          capability: response.capability
        }, extensionFrameOrigin());
      }).catch(() => {});
    });
    return () => {
      window.removeEventListener("message", onSize);
      frame.removeAttribute("src");
    };
  }

  function createRevisionPayload(record, key, tone, marker) {
    const payload = document.createElement("section");
    payload.className = `revision ${tone}`;
    payload.setAttribute("role", "note");
    payload.setAttribute("aria-label", tone === "edited" ? "Earlier edited message version" : "Deleted message version");
    const line = document.createElement("div");
    line.className = "content-line";
    const content = document.createElement("span");
    content.className = "content";
    replaceText(content, record.content || "");
    const label = document.createElement("span");
    label.className = "lifecycle-label";
    label.textContent = marker;
    line.append(content, label);
    const attachments = document.createElement("div");
    attachments.className = "attachments";
    const hasMedia = Array.isArray(record.media) && record.media.length > 0;
    if (!hasMedia) attachments.replaceChildren(...(record.attachments || []).slice(0, 12).map((nameValue) => {
      const item = document.createElement("div");
      item.className = "attachment";
      replaceText(item, `Attachment: ${nameValue}`);
      return item;
    }));
    const mediaFrame = document.createElement("iframe");
    mediaFrame.className = "media-frame";
    mediaFrame.title = tone === "edited" ? "Locally cached media from an earlier edit" : "Locally cached deleted-message media";
    mediaFrame.loading = "lazy";
    mediaFrame.hidden = !hasMedia;
    mediaFrame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads");
    const disposeMedia = configureMediaFrame(mediaFrame, key, record.revisionId || null);
    if (hasMedia) mediaFrame.src = new URL(chrome.runtime.getURL("media/view.html")).href;
    payload.append(line, attachments, mediaFrame);
    return { element: payload, dispose: disposeMedia };
  }

  function createTombstoneRenderer(host, key) {
    dropTombstoneRenderer(key);
    const mount = document.createElement("div");
    mount.className = "ldma-tombstone__mount";
    host.append(mount);
    const shadow = mount.attachShadow({ mode: "closed" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      :host { display:block; min-width:0; color:#dbdee1; font:16px/1.375 "gg sans","Noto Sans","Helvetica Neue",Helvetica,Arial,sans-serif; }
      * { box-sizing:border-box; }
      .message { position:relative; display:grid; grid-template-columns:40px minmax(0,1fr); column-gap:16px; min-height:48px; padding:2px 16px; background:rgb(242 63 66 / 7.5%); }
      .message:hover { background:rgb(242 63 66 / 10%); }
      .message.continuation { min-height:22px; padding-block:0; }
      .message.continuation .avatar { display:none; }
      .message.continuation .body { grid-column:2; }
      .message.continuation .header { position:absolute; inset-inline-end:16px; top:0; z-index:1; }
      .message.continuation .header .author-group,.message.continuation .header .timestamp { display:none; }
      .message.continuation .header .author-actions { margin-left:0; }
      button { font:inherit; }
      .profile-trigger { border:0; cursor:pointer; }
      .profile-trigger:disabled { cursor:default; }
      .profile-trigger:focus-visible { outline:2px solid #00a8fc; outline-offset:2px; }
      .avatar { display:grid; place-items:center; width:40px; height:40px; margin:0; padding:0; overflow:hidden; border-radius:50%; background:#5865f2; color:#fff; font-size:17px; font-weight:700; user-select:none; }
      .avatar:not(:disabled):hover { box-shadow:0 0 0 2px rgb(255 255 255 / 20%); }
      .avatar img { width:100%; height:100%; object-fit:cover; }
      .body { min-width:0; }
      .reply { position:relative; margin:-1px 0 2px; padding-left:18px; overflow:hidden; color:#b5bac1; font-size:13px; line-height:18px; text-overflow:ellipsis; white-space:nowrap; }
      .reply::before { content:""; position:absolute; left:2px; top:8px; width:11px; border-top:2px solid #4e5058; }
      .header { display:flex; align-items:baseline; min-width:0; line-height:22px; }
      .author-group { display:inline-flex; align-items:center; min-width:0; gap:4px; }
      .author { display:inline-block; min-width:0; margin:0; padding:0; overflow:hidden; background:transparent; color:#f2f3f5; font-size:16px; font-weight:400; line-height:inherit; text-align:left; text-overflow:ellipsis; white-space:nowrap; }
      .author:not(:disabled):hover { text-decoration:underline; }
      .badges { display:inline-flex; align-items:center; flex:0 0 auto; gap:3px; }
      .author-icon,.author-vector { display:block; flex:0 0 auto; object-fit:contain; }
      .app-badge,.text-badge { display:inline-flex; align-items:center; height:16px; padding:0 4px; border-radius:3px; font-size:10px; font-weight:750; line-height:16px; white-space:nowrap; }
      .app-badge { gap:2px; background:#5865f2; color:#fff; }
      .app-check { font-size:11px; line-height:1; }
      .timestamp { margin-left:6px; color:#949ba4; font-size:12px; font-weight:400; white-space:nowrap; }
      .history { display:grid; gap:2px; }
      .revision { min-width:0; margin-inline:-6px; padding:1px 6px 3px; border-radius:4px; }
      .revision.edited { background:rgb(240 178 50 / 8%); }
      .revision.edited:hover { background:rgb(240 178 50 / 11%); }
      .content-line { min-width:0; line-height:22px; }
      .content { color:#f23f42; white-space:pre-wrap; overflow-wrap:anywhere; }
      .revision.edited .content { color:#f0b232; }
      .lifecycle-label,.deleted { margin-left:4px; color:#ff6b70; font-size:11px; font-weight:750; white-space:nowrap; }
      .revision.edited .lifecycle-label { color:#f5c451; }
      .attachments { color:#00a8fc; font-size:14px; line-height:20px; overflow-wrap:anywhere; }
      .attachment::before { content:"↳ "; color:#949ba4; }
      .media-frame { display:block; width:min(550px,100%); max-width:100%; height:40px; margin:4px 0 2px; border:0; border-radius:8px; background:transparent; }
      .author-actions { display:inline-flex; flex:0 0 auto; align-items:center; gap:2px; margin-left:6px; vertical-align:middle; opacity:0; pointer-events:none; transform:translateY(1px); transition:opacity 100ms ease,transform 100ms ease; }
      .message:hover .author-actions,.message:focus-within .author-actions,.author-actions:focus-within { opacity:1; pointer-events:auto; transform:none; transition-delay:0s; }
      .author-action { display:inline-grid; place-items:center; min-width:22px; height:20px; margin:0; padding:0 4px; border:0; border-radius:4px; background:#2b2d31; color:#b5bac1; font-size:10px; font-weight:700; line-height:1; white-space:nowrap; cursor:pointer; }
      .author-action:hover { background:#404249; color:#f2f3f5; }
      .author-action:focus-visible { outline:2px solid #00a8fc; outline-offset:1px; }
      .author-action.timeout:hover { background:#da373c; color:#fff; }
      .author-action:disabled { cursor:wait; opacity:.65; }
      .author-action.error { color:#ff6b70; }
      .author-action-status { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
      @media (prefers-reduced-motion:reduce) { .author-actions { transition:none; } }
      [hidden] { display:none !important; }
    `);
    shadow.adoptedStyleSheets = [sheet];

    const article = document.createElement("article");
    article.className = "message";
    article.setAttribute("role", "article");
    const avatar = document.createElement("button");
    avatar.type = "button";
    avatar.className = "avatar";
    avatar.classList.add("profile-trigger");
    const avatarImage = document.createElement("img");
    avatarImage.alt = "";
    avatarImage.hidden = true;
    const avatarFallback = document.createElement("span");
    avatarFallback.textContent = "?";
    avatar.append(avatarImage, avatarFallback);

    const body = document.createElement("div");
    body.className = "body";
    const reply = document.createElement("div");
    reply.className = "reply";
    reply.hidden = true;
    const header = document.createElement("header");
    header.className = "header";
    const authorGroup = document.createElement("span");
    authorGroup.className = "author-group";
    const author = document.createElement("button");
    author.type = "button";
    author.className = "author";
    author.classList.add("profile-trigger");
    const badges = document.createElement("span");
    badges.className = "badges";
    authorGroup.append(author, badges);
    const timestamp = document.createElement("time");
    timestamp.className = "timestamp";
    let actionContext = null;
    const controls = createAuthorActionControls("Actions for deleted message author", () => actionContext);
    header.append(authorGroup, timestamp, controls.actions);
    const history = document.createElement("div");
    history.className = "history";
    history.setAttribute("role", "group");
    history.setAttribute("aria-label", "Earlier edited versions");
    const contentLine = document.createElement("div");
    contentLine.className = "content-line";
    const content = document.createElement("span");
    content.className = "content";
    const deleted = document.createElement("span");
    deleted.className = "deleted";
    deleted.textContent = "• DELETED";
    contentLine.append(content, deleted);
    const attachments = document.createElement("div");
    attachments.className = "attachments";
    const mediaFrame = document.createElement("iframe");
    mediaFrame.className = "media-frame";
    mediaFrame.title = "Locally cached message media";
    mediaFrame.loading = "lazy";
    mediaFrame.hidden = true;
    mediaFrame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads");
    const disposeCurrentMedia = configureMediaFrame(mediaFrame, key, null);
    body.append(reply, header, history, contentLine, attachments, mediaFrame);
    article.append(avatar, body);
    shadow.append(article);

    let actionUserId = null;
    let actionGuildId = null;
    suppressDiscordMessageGesture(avatar);
    suppressDiscordMessageGesture(author);

    async function openProfile() {
      if (!actionUserId) return;
      const response = await send({
        type: "LDMA_USER_ACTION",
        action: "open-profile",
        userId: actionUserId,
        guildId: actionGuildId
      });
    }

    avatar.addEventListener("click", openProfile);
    author.addEventListener("click", openProfile);

    avatarImage.addEventListener("error", () => {
      avatarImage.hidden = true;
      avatarFallback.hidden = false;
    });

    let authorAnimation = null;
    let authorAnimationSignature = "";
    let badgeSignature = "";
    let lastRecord = null;
    let continuation = false;
    let historySignature = "";
    let historyDisposers = [];
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

    function createBadge(badge) {
      if (badge.kind === "image") {
        const image = document.createElement("img");
        image.className = "author-icon";
        image.alt = badge.label || "";
        image.title = badge.label || "";
        image.width = badge.width;
        image.height = badge.height;
        image.src = badge.url;
        return image;
      }
      if (badge.kind === "vector") {
        const namespace = "http:" + "//www.w3.org/2000/svg";
        const svg = document.createElementNS(namespace, "svg");
        svg.classList.add("author-vector");
        svg.setAttribute("viewBox", badge.viewBox);
        svg.setAttribute("width", String(badge.width));
        svg.setAttribute("height", String(badge.height));
        svg.setAttribute("role", "img");
        if (badge.label) svg.setAttribute("aria-label", badge.label);
        for (const item of badge.paths) {
          const path = document.createElementNS(namespace, "path");
          path.setAttribute("d", item.d);
          path.setAttribute("fill", item.fill || "currentColor");
          if (item.stroke) path.setAttribute("stroke", item.stroke);
          if (item.fillRule) path.setAttribute("fill-rule", item.fillRule);
          if (item.clipRule) path.setAttribute("clip-rule", item.clipRule);
          svg.append(path);
        }
        return svg;
      }
      if (badge.kind === "app") {
        const pill = document.createElement("span");
        pill.className = "app-badge";
        pill.setAttribute("role", "img");
        pill.setAttribute("aria-label", badge.verified ? `Verified ${badge.label}` : badge.label);
        if (badge.verified) {
          const check = document.createElement("span");
          check.className = "app-check";
          check.textContent = "✓";
          check.setAttribute("aria-hidden", "true");
          pill.append(check);
        }
        pill.append(document.createTextNode(badge.label));
        return pill;
      }
      const pill = document.createElement("span");
      pill.className = "text-badge";
      pill.textContent = badge.text;
      if (badge.label) pill.title = badge.label;
      if (badge.color) pill.style.color = badge.color;
      if (badge.backgroundColor) pill.style.backgroundColor = badge.backgroundColor;
      if (badge.borderRadius) pill.style.borderRadius = badge.borderRadius;
      return pill;
    }

    function applyAuthorPresentation(record) {
      const safe = Core.sanitizeRecordPresentation(record);
      const style = safe.authorStyle || {};
      for (const property of [
        "color", "background-image", "background-size", "background-position", "background-clip",
        "-webkit-background-clip", "-webkit-text-fill-color", "font-weight", "text-shadow"
      ]) author.style.removeProperty(property);
      if (style.color || safe.authorColor) author.style.color = style.color || safe.authorColor;
      if (style.gradient) {
        author.style.backgroundImage = style.gradient;
        if (style.backgroundSize) author.style.backgroundSize = style.backgroundSize;
        if (style.backgroundPosition) author.style.backgroundPosition = style.backgroundPosition;
        author.style.backgroundClip = "text";
        author.style.webkitBackgroundClip = "text";
        author.style.webkitTextFillColor = style.textFillColor || "transparent";
      }
      if (style.fontWeight) author.style.fontWeight = style.fontWeight;
      if (style.textShadow) author.style.textShadow = style.textShadow;
      const nextBadgeSignature = JSON.stringify(safe.authorBadges);
      if (nextBadgeSignature !== badgeSignature) {
        badgeSignature = nextBadgeSignature;
        badges.replaceChildren(...safe.authorBadges.map(createBadge));
      }

      const animationSignature = JSON.stringify([style.animation || null, reducedMotion.matches]);
      if (animationSignature === authorAnimationSignature) return;
      authorAnimationSignature = animationSignature;
      if (authorAnimation) authorAnimation.cancel();
      authorAnimation = null;
      if (!style.animation || reducedMotion.matches) return;
      try {
        authorAnimation = author.animate(style.animation.frames, Object.assign({}, style.animation.timing, {
          iterations: style.animation.timing.iterations === -1 ? Infinity : style.animation.timing.iterations
        }));
      } catch (_error) {
        authorAnimation = null;
      }
    }

    const render = (record) => {
      lastRecord = record;
      const name = record.author || "Unknown author";
      const nextAuthorIdentity = resolvedAuthorIdentity(
        record.channelId, record.messageId, record.authorId, record.authorUsername);
      const nextUserId = nextAuthorIdentity.userId;
      const nextGuildId = SNOWFLAKE.test(String(record.guildId || "")) ? String(record.guildId) : null;
      actionUserId = nextUserId;
      actionGuildId = nextGuildId;
      const profileLabel = nextUserId ? `Open ${name}'s profile` : "Profile unavailable for this archived message";
      avatar.disabled = !nextUserId;
      author.disabled = !nextUserId;
      avatar.setAttribute("aria-label", profileLabel);
      author.setAttribute("aria-label", profileLabel);
      actionContext = {
        channelId: record.channelId,
        messageId: record.messageId,
        guildId: nextGuildId,
        userId: nextUserId,
        username: nextAuthorIdentity.username,
        author: name,
        isCurrent: () => host.isConnected && host.dataset.ldmaMessageKey === key &&
          state.route?.channelId === record.channelId
      };
      controls.update(actionContext);
      replaceText(author, name);
      applyAuthorPresentation(record);
      const time = storedTime(record);
      replaceText(timestamp, time.display);
      timestamp.dateTime = time.dateTime;
      timestamp.title = time.title;
      reply.hidden = !record.replyPreview;
      replaceText(reply, record.replyPreview || "");
      replaceText(content, record.content || "");
      const revisions = Core.sanitizeEditHistory(record.editHistory);
      host.dataset.ldmaEditCount = String(revisions.length);
      const nextHistorySignature = JSON.stringify(revisions);
      if (nextHistorySignature !== historySignature) {
        historySignature = nextHistorySignature;
        historyDisposers.forEach((dispose) => dispose());
        historyDisposers = [];
        const rendered = revisions.map((revision) => createRevisionPayload(revision, key, "edited", "• EDITED"));
        history.replaceChildren(...rendered.map((item) => item.element));
        historyDisposers = rendered.map((item) => item.dispose);
      }
      const hasMedia = Array.isArray(record.media) && record.media.length > 0;
      attachments.replaceChildren(...(hasMedia ? [] : (record.attachments || []).slice(0, 12)).map((nameValue) => {
        const item = document.createElement("div");
        item.className = "attachment";
        replaceText(item, `Attachment: ${nameValue}`);
        return item;
      }));
      mediaFrame.hidden = !hasMedia;
      if (hasMedia && !mediaFrame.hasAttribute("src")) {
        const viewerUrl = new URL(chrome.runtime.getURL("media/view.html"));
        mediaFrame.src = viewerUrl.href;
      }
      const avatarUrl = normalizedAvatarUrl(record.avatarUrl);
      replaceText(avatarFallback, name.trim().slice(0, 1).toLocaleUpperCase() || "?");
      avatarFallback.hidden = Boolean(avatarUrl);
      avatarImage.hidden = !avatarUrl;
      if (avatarUrl) avatarImage.src = avatarUrl;
      else avatarImage.removeAttribute("src");
      article.setAttribute("aria-label", `${name}, ${revisions.length ? `${revisions.length} earlier edited version${revisions.length === 1 ? "" : "s"}, ` : ""}deleted message preserved locally`);
    };
    render.setContinuation = (value) => {
      const next = Boolean(value);
      if (next === continuation) return;
      continuation = next;
      article.classList.toggle("continuation", continuation);
      host.dataset.ldmaContinuation = String(continuation);
    };
    host.dataset.ldmaContinuation = "false";
    const onMotionPreference = () => {
      authorAnimationSignature = "";
      if (lastRecord) applyAuthorPresentation(lastRecord);
    };
    reducedMotion.addEventListener("change", onMotionPreference);
    render.dispose = () => {
      controls.update.dispose();
      reducedMotion.removeEventListener("change", onMotionPreference);
      if (authorAnimation) authorAnimation.cancel();
      authorAnimation = null;
      avatarImage.removeAttribute("src");
      badges.replaceChildren();
      historyDisposers.forEach((dispose) => dispose());
      historyDisposers = [];
      disposeCurrentMedia();
    };
    state.tombstoneRenderers.set(key, render);
    return render;
  }

  function dropEditRenderer(key) {
    const renderer = state.editRenderers.get(key);
    if (renderer?.dispose) renderer.dispose();
    state.editRenderers.delete(key);
  }

  function createLiveEditRenderer(host, key) {
    dropEditRenderer(key);
    const mount = document.createElement("div");
    mount.className = "ldma-edit-history__mount";
    host.append(mount);
    const shadow = mount.attachShadow({ mode: "closed" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      :host { display:block; min-width:0; max-width:100%; color:#dbdee1; font:16px/1.375 "gg sans","Noto Sans","Helvetica Neue",Helvetica,Arial,sans-serif; }
      * { box-sizing:border-box; }
      .history { display:grid; gap:2px; margin:0 0 2px; }
      .revision { min-width:0; margin-inline:-6px; padding:1px 6px 3px; border-radius:4px; }
      .revision.edited { background:rgb(240 178 50 / 8%); }
      .revision.edited:hover { background:rgb(240 178 50 / 11%); }
      .content-line { min-width:0; line-height:22px; }
      .content { color:#f0b232; white-space:pre-wrap; overflow-wrap:anywhere; }
      .lifecycle-label { margin-left:4px; color:#f5c451; font-size:11px; font-weight:750; white-space:nowrap; }
      .attachments { color:#00a8fc; font-size:14px; line-height:20px; overflow-wrap:anywhere; }
      .attachment::before { content:"↳ "; color:#949ba4; }
      .media-frame { display:block; width:min(550px,100%); max-width:100%; height:40px; margin:4px 0 2px; border:0; border-radius:8px; background:transparent; }
      [hidden] { display:none !important; }
    `);
    shadow.adoptedStyleSheets = [sheet];
    const history = document.createElement("div");
    history.className = "history";
    history.setAttribute("role", "group");
    history.setAttribute("aria-label", "Earlier edited versions preserved locally");
    shadow.append(history);
    let signature = "";
    let disposers = [];
    const render = (record) => {
      const revisions = Core.sanitizeEditHistory(record.editHistory);
      host.dataset.ldmaEditCount = String(revisions.length);
      const nextSignature = JSON.stringify(revisions);
      if (signature === nextSignature) return;
      signature = nextSignature;
      disposers.forEach((dispose) => dispose());
      const rendered = revisions.map((revision) => createRevisionPayload(revision, key, "edited", "• EDITED"));
      history.replaceChildren(...rendered.map((item) => item.element));
      disposers = rendered.map((item) => item.dispose);
    };
    render.dispose = () => {
      disposers.forEach((dispose) => dispose());
      disposers = [];
      history.replaceChildren();
    };
    state.editRenderers.set(key, render);
    return render;
  }

  function editHistoryInsertion(row, messageId) {
    if (!row) return null;
    const exactContent = document.getElementById(`message-content-${messageId}`);
    const content = exactContent && row.contains(exactContent) ? exactContent :
      [...row.querySelectorAll("[class*='messageContent_']")].find((node) => !node.closest("[class*='repliedMessage_'], [class*='reply_']"));
    if (content?.parentElement) return { parent: content.parentElement, reference: content };
    const body = row.querySelector("[class*='contents_']");
    if (!body) return null;
    const reference = body.querySelector("[class*='embed_'], [class*='attachment_'], [class*='mediaAttachmentsContainer_']");
    return { parent: body, reference };
  }

  function removeEditHistories() {
    for (const key of [...state.editRenderers.keys()]) dropEditRenderer(key);
    document.querySelectorAll("[data-ldma-edit-history]").forEach((host) => host.remove());
  }

  function reconcileEditHistories(activeValue) {
    const active = activeValue || findActiveMessageList();
    const eligible = new Map(state.archive.records.filter((record) => record.status === "seen" && Core.hasEdits(record))
      .map((record) => [Core.recordKey(record), record]));
    const connectedKeys = new Set();
    document.querySelectorAll("[data-ldma-edit-history]").forEach((host) => {
      const key = host.dataset.ldmaMessageKey;
      const record = eligible.get(key);
      const row = host.closest(MESSAGE_SELECTOR);
      const identity = rowIdentity(row);
      const valid = Boolean(active && record && active.node.contains(host) && identity &&
        `${active.route.channelId}:${identity.messageId}` === key);
      if (!valid) {
        dropEditRenderer(key);
        host.remove();
      } else connectedKeys.add(key);
    });
    for (const row of active?.rows || []) {
      const identity = rowIdentity(row);
      const key = identity && `${active.route.channelId}:${identity.messageId}`;
      const record = key && eligible.get(key);
      if (!record) continue;
      let host = row.querySelector(`[data-ldma-edit-history][data-ldma-message-key="${key}"]`);
      if (!host) {
        const insertion = editHistoryInsertion(row, identity.messageId);
        if (!insertion) continue;
        host = document.createElement("div");
        host.dataset.ldmaEditHistory = "true";
        host.dataset.ldmaMessageKey = key;
        insertion.parent.insertBefore(host, insertion.reference || null);
      }
      let renderer = state.editRenderers.get(key);
      if (!renderer) renderer = createLiveEditRenderer(host, key);
      renderer(record);
      connectedKeys.add(key);
    }
    for (const key of [...state.editRenderers.keys()]) {
      if (!connectedKeys.has(key)) dropEditRenderer(key);
    }
  }

  function insertTombstone(record, active, replacementNode) {
    const confirmed = record.status === "confirmed_deleted";
    if (!confirmed && record.inferredListIdentity && record.inferredListIdentity !== active.identity) return;
    const key = Core.recordKey(record);
    let element = findMountedTombstone(record.channelId, record.messageId);
    if (element) {
      const belongsToTarget = replacementNode?.parentElement
        ? element.parentElement === replacementNode.parentElement
        : Boolean(active.node?.contains(element));
      if (!belongsToTarget) {
        dropTombstoneRenderer(key);
        element.remove();
        element = null;
      }
    }
    if (element && active.rows.length) element.removeAttribute("data-ldma-empty-restore");

    const liveIds = active.rows.map((row) => rowIdentity(row)?.messageId).filter(Boolean);
    const scroller = findChatScrollContainer(active.node);
    const atBottom = Core.isAtScrollBottom(scroller && {
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight
    });
    const newestLiveId = liveIds.reduce((newest, id) =>
      !newest || Core.compareSnowflakeIds(id, newest) > 0 ? id : newest, null);
    // A tail placement is range-qualified by the pre-mount bottom state even
    // when its persisted previous anchor is still visible. Latch that decision
    // because the restored row itself increases scrollHeight.
    const tailAuthorized = Boolean(record.inferredTail && atBottom && newestLiveId &&
      Core.compareSnowflakeIds(record.messageId, newestLiveId) > 0);
    let anchorlessAuthorized = false;
    let previous = confirmed
      ? findPositionedMessage(record.channelId, record.inferredPreviousId, active.rows, active.node)
      : findMessage(record.inferredPreviousId, active.rows);
    let next = confirmed
      ? findPositionedMessage(record.channelId, record.inferredNextId, active.rows, active.node)
      : findMessage(record.inferredNextId, active.rows);
    if (previous === element) previous = null;
    if (next === element) next = null;
    if (confirmed && !previous && !next) {
      if (!Core.anchorlessRestoreAllowed(record.messageId, liveIds, {
        allowEmpty: active.allowAnchorless,
        tail: record.inferredTail,
        atBottom
      })) return false;
      anchorlessAuthorized = true;
      const positionedIds = active.rows.map(rawRowId).concat(
        [...active.node.querySelectorAll("[data-ldma-tombstone]")]
          .filter((candidate) => candidate !== element)
          .map((candidate) => candidate.dataset.ldmaMessageKey)
      );
      const chronological = Core.chronologicalNeighborIds(record.messageId, positionedIds);
      previous = findPositionedMessage(record.channelId, chronological.previousId, active.rows, active.node);
      next = findPositionedMessage(record.channelId, chronological.nextId, active.rows, active.node);
    }
    if (record.status === "inferred_deleted" && !previous) return false;
    if (!previous && !next && !active.allowAnchorless) return false;
    if (previous && next && previous.parentElement !== next.parentElement) return false;
    if (!confirmed && previous && next && active.rows.indexOf(next) !== active.rows.indexOf(previous) + 1) return false;

    const reference = next || previous || active.rows[0] || active.node;
    if (!element) {
      element = document.createElement(reference.tagName === "LI" || active.node?.tagName === "OL" ? "li" : "div");
      element.className = "ldma-tombstone";
      element.dataset.ldmaTombstone = "true";
      element.dataset.ldmaMessageKey = key;
      if (!active.rows.length) element.dataset.ldmaEmptyRestore = "true";
      try {
        createTombstoneRenderer(element, key)(record);
      } catch (_error) {
        dropTombstoneRenderer(key);
        return false;
      }
    } else {
      const renderer = state.tombstoneRenderers.get(key);
      if (!renderer) {
        try { createTombstoneRenderer(element, key)(record); }
        catch (_error) { dropTombstoneRenderer(key); element.remove(); return false; }
      } else renderer(record);
    }
    if (anchorlessAuthorized || tailAuthorized || replacementNode || active.confirmedMount) {
      element.dataset.ldmaAnchorlessEpoch = String(state.anchorlessEpoch);
      element.dataset.ldmaAnchorlessRange = nativeRangeSignature(active);
      element.dataset.ldmaMountKind = active.rows.length === 0
        ? "empty"
        : replacementNode
          ? "retained"
          : tailAuthorized
            ? "tail"
            : active.confirmedMount ? "confirmed" : "range";
    } else {
      delete element.dataset.ldmaAnchorlessEpoch;
      delete element.dataset.ldmaAnchorlessRange;
      delete element.dataset.ldmaMountKind;
    }

    if (replacementNode?.parentElement) {
      if (element.nextSibling !== replacementNode) {
        if (element.isConnected) replacementNode.parentElement.moveBefore(element, replacementNode);
        else replacementNode.parentElement.insertBefore(element, replacementNode);
      }
      scheduleTombstoneSpacing();
      return true;
    }
    const parent = previous?.parentElement || next?.parentElement || active.rows[0]?.parentElement || active.node;
    if (next && next.parentElement === parent) {
      if (element.nextSibling !== next) {
        if (element.isConnected) parent.moveBefore(element, next);
        else parent.insertBefore(element, next);
      }
    } else if (previous && previous.parentElement === parent) {
      if (previous.nextSibling !== element) {
        if (element.isConnected) parent.moveBefore(element, previous.nextSibling);
        else parent.insertBefore(element, previous.nextSibling);
      }
    } else if (element.parentElement !== parent || element !== parent.lastElementChild) {
      if (element.isConnected) parent.moveBefore(element, null);
      else parent.append(element);
    }
    scheduleTombstoneSpacing();
    return true;
  }

  function replaceVisibleRetainedRows() {
    const route = Core.parseDiscordRoute(location.pathname);
    if (!route) return;
    const active = findActiveMessageList();
    if (!active) return;
    const retained = state.archive.records.filter((record) =>
      record.channelId === route.channelId && record.status === "confirmed_deleted" &&
      record.deletionSource === "message_store_preserved");
    for (const record of retained) {
      const nativeRow = retainedRow(route.channelId, record.messageId, active.node);
      if (!nativeRow || nativeRow.closest("[data-ldma-tombstone]")) continue;
      const scroller = findChatScrollContainer(active.node);
      const rowRect = nativeRow.getBoundingClientRect();
      const clipRect = scroller?.getBoundingClientRect();
      const clipTop = Math.max(0, clipRect?.top || 0);
      const clipBottom = Math.min(innerHeight, clipRect?.bottom || innerHeight);
      // The fallback is for a native row the user can currently see. A row
      // already hidden behind a prior tombstone must not recreate that
      // tombstone after range/gesture cleanup.
      if (nativeRow.dataset.ldmaNativeReplaced === "true" || rowRect.height <= 0 ||
        rowRect.bottom <= clipTop || rowRect.top >= clipBottom) continue;
      const mounted = insertTombstone(record, Object.assign({}, active, {
        rows: active.rows.filter((row) => row !== nativeRow),
        allowAnchorless: true
      }), nativeRow);
      if (mounted) nativeRow.dataset.ldmaNativeReplaced = "true";
    }
  }

  function reconcileTombstones() {
    const active = findActiveMessageList() || findEmptyConfirmedRestoreList();
    const deleted = new Map(state.archive.records.filter((record) => Core.isDeletedStatus(record.status)).map((record) => [Core.recordKey(record), record]));
    const elements = [...document.querySelectorAll("[data-ldma-tombstone]")];
    const connectedRendererKeys = new Set(elements.map((element) => element.dataset.ldmaMessageKey));
    for (const rendererKey of [...state.tombstoneRenderers.keys()]) {
      if (!connectedRendererKeys.has(rendererKey)) dropTombstoneRenderer(rendererKey);
    }
    const mountedKeys = elements.map((element) => element.dataset.ldmaMessageKey);
    const liveKeys = active ? active.rows.map((row) => {
      const identity = rowIdentity(row);
      return `${active.route.channelId}:${identity && identity.messageId}`;
    }) : [];
    const liveRowIds = active ? active.rows.map(rawRowId) : [];
    const scroller = active && findChatScrollContainer(active.node);
    const atBottom = Core.isAtScrollBottom(scroller && {
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight
    });
    const inRenderedRange = (record, allowEmpty) => Boolean(active && Core.tombstoneInRenderedRange(
      record.messageId,
      liveRowIds,
      { allowEmpty, tail: record.inferredTail, atBottom }
    ));
    const cleanup = new Set(Core.tombstoneCleanupKeys(state.archive.records, mountedKeys, liveKeys));
    elements.forEach((element) => {
      const record = deleted.get(element.dataset.ldmaMessageKey);
      const wrongRoute = state.route && record && record.channelId !== state.route.channelId;
      const outsideActiveList = active && record?.channelId === active.route.channelId && !active.node.contains(element);
      const outsideRenderedRange = active && record?.channelId === active.route.channelId &&
        !inRenderedRange(record, active.allowAnchorless && element.dataset.ldmaEmptyRestore === "true") &&
        !anchorlessMountIsCurrent(element, active);
      if (cleanup.has(element.dataset.ldmaMessageKey) || !record || wrongRoute || outsideActiveList || outsideRenderedRange) {
        dropTombstoneRenderer(element.dataset.ldmaMessageKey);
        element.remove();
      }
    });
    if (!active) return;
    const ordered = [...deleted.values()].sort((left, right) => Core.compareSnowflakeIds(left.messageId, right.messageId));
    for (const record of ordered) {
      if (record.channelId === active.route.channelId && !findMessage(record.messageId, active.rows) &&
        inRenderedRange(record, active.allowAnchorless)) insertTombstone(record, active);
    }
    scheduleTombstoneSpacing();
  }

  function retractIfReappeared(record) {
    const key = Core.recordKey(record);
    const archived = state.archive.records.find((item) => Core.recordKey(item) === key);
    if (!archived || archived.status !== "inferred_deleted" || state.pendingRetractions.has(key)) return;
    state.pendingRetractions.add(key);
    removeTombstone(key);
    send({ type: T.RETRACT_MESSAGE, generation: state.generation, key }).then((response) => {
      if (response.archive) applyArchive(response.archive);
    }).finally(() => state.pendingRetractions.delete(key));
  }

  function snapshotRenderedMessages(persist) {
    if (state.paused) {
      removeLiveAuthorActions();
      return;
    }
    const active = updateActiveList();
    if (!active) {
      reconcileLiveAuthorActions(null);
      reconcileTombstones();
      return;
    }
    const nowDate = Date.now();
    const nowPerf = performance.now();
    const records = active.rows.map((node) => recordFromNode(node, nowDate));
    const scrollContainer = findChatScrollContainer(active.node);
    const scrollerRect = scrollContainer?.getBoundingClientRect();
    const wasAtBottom = Core.isAtScrollBottom(scrollContainer && {
      scrollTop: scrollContainer.scrollTop,
      scrollHeight: scrollContainer.scrollHeight,
      clientHeight: scrollContainer.clientHeight
    });
    active.rows.forEach((node, index) => {
      const rect = node.getBoundingClientRect();
      const clipTop = Math.max(0, scrollerRect?.top || 0);
      const clipBottom = Math.min(innerHeight, scrollerRect?.bottom || innerHeight);
      const visibleHeight = Math.max(0, Math.min(rect.bottom, clipBottom) - Math.max(rect.top, clipTop));
      const visibleRatio = rect.height > 0 ? Math.min(1, visibleHeight / rect.height) : 0;
      const wasActuallyVisible = document.visibilityState === "visible" && visibleRatio >= 0.05;
      const center = rect.top + rect.height / 2;
      const extractedRecord = records[index];
      const record = wasActuallyVisible ? extractedRecord : null;
      const snapshot = {
        record, messageId: rowIdentity(node)?.messageId, routeKey: active.route.routeKey,
        listNode: active.node, listIdentity: active.identity, parentNode: node.parentElement,
        capturedAtPerf: nowPerf, visibleRatio,
        innerViewport: center >= Math.max(56, innerHeight * 0.12) && center <= innerHeight * 0.88,
        tailCandidate: index === active.rows.length - 1,
        wasAtBottom,
        previousId: index > 0 ? rowIdentity(active.rows[index - 1])?.messageId : null,
        nextId: index + 1 < active.rows.length ? rowIdentity(active.rows[index + 1])?.messageId : null,
        previousTop: index > 0 ? active.rows[index - 1].getBoundingClientRect().top : null
      };
      state.snapshots.set(node, snapshot);
      if (record) {
        state.snapshotsByKey.set(Core.recordKey(record), snapshot);
        while (state.snapshotsByKey.size > 2500) state.snapshotsByKey.delete(state.snapshotsByKey.keys().next().value);
      }
      if (record) {
        verifyPendingEditsForRecord(record);
        retractIfReappeared(record);
        if (persist) queueRecord(record);
      }
    });
    reconcileTombstones();
    reconcileEditHistories(active);
    reconcileLiveAuthorActions(active, records);
    applyRetainedStyles();
  }

  function findChatScrollContainer(list) {
    let current = list && list.parentElement;
    while (current && current !== document.documentElement) {
      const overflowY = getComputedStyle(current).overflowY;
      if (/(auto|scroll|overlay)/.test(overflowY) && current.clientHeight > 0) return current;
      current = current.parentElement;
    }
    return null;
  }

  function countElementTree(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return 0;
    return 1 + Math.min(2000, node.querySelectorAll("*").length);
  }

  function explicitRootReplacement(removedRoots, activeList) {
    return removedRoots.some((node) => {
      if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
      if (node === activeList || (activeList && node.contains(activeList))) return true;
      if (node.id === "app-mount" || node.matches("main, [role='main'], " + LIST_SELECTOR)) return true;
      return Boolean(node.querySelector("main, [role='main'], " + LIST_SELECTOR));
    });
  }

  function evaluateCandidate(candidate) {
    setTimeout(async () => {
      if (state.paused) return;
      const active = findActiveMessageList();
      const rows = active ? active.rows : [];
      const previous = active ? findMessage(candidate.snapshot.previousId, rows) : null;
      const next = active ? findMessage(candidate.snapshot.nextId, rows) : null;
      const previousIndex = previous ? rows.indexOf(previous) : -1;
      const nextIndex = next ? rows.indexOf(next) : -1;
      const previousDelta = previous && candidate.snapshot.previousTop !== null ? previous.getBoundingClientRect().top - candidate.snapshot.previousTop : Infinity;
      const now = performance.now();
      const decision = Core.classifyRemoval({
        candidateKnown: Boolean(candidate.snapshot.record), documentHidden: document.visibilityState !== "visible",
        routeChanged: !active || active.route.routeKey !== candidate.routeKeyAtMutation,
        sameChannel: Boolean(active && active.route.routeKey === candidate.snapshot.routeKey),
        rootReplacement: candidate.rootReplacement, removedMessageCount: candidate.removedMessageCount,
        totalRemovedElementCount: candidate.totalRemovedElementCount, addedMessageCount: candidate.addedMessageCount,
        msSinceScroll: now - state.lastScrollAt, msSinceRouteChange: now - state.lastRouteAt,
        targetConnected: candidate.snapshot.parentNode?.isConnected === true,
        listUnchanged: Boolean(active && active.node === candidate.snapshot.listNode && active.identity === candidate.snapshot.listIdentity),
        parentUnchanged: Boolean(previous && previous.parentElement === candidate.snapshot.parentNode &&
          (candidate.snapshot.tailCandidate || (next && next.parentElement === candidate.snapshot.parentNode))),
        wasVisible: candidate.snapshot.visibleRatio > 0, visibleRatio: candidate.snapshot.visibleRatio,
        innerViewport: candidate.snapshot.innerViewport, snapshotAgeMs: now - candidate.snapshot.capturedAtPerf,
        currentlyPresent: Boolean(active && findMessage(candidate.snapshot.messageId, rows)),
        tailCandidate: candidate.snapshot.tailCandidate,
        wasAtBottom: candidate.snapshot.wasAtBottom,
        previousAnchorPresent: Boolean(previous), nextAnchorPresent: Boolean(next),
        anchorsAdjacent: previousIndex >= 0 && nextIndex === previousIndex + 1, previousAnchorDeltaPx: previousDelta
      });
      if (!decision.highConfidence) return;
      const response = await send({
        type: T.INFER_DELETED, generation: candidate.generationAtMutation, record: candidate.snapshot.record,
        previousId: candidate.snapshot.previousId, nextId: candidate.snapshot.nextId,
        tail: candidate.snapshot.tailCandidate,
        listIdentity: candidate.snapshot.listIdentity
      });
      if (response.archive) applyArchive(response.archive);
    }, Core.DEFAULTS.reappearanceGraceMs);
  }

  function handleMutations(mutations) {
    if (state.paused) return;
    if (!state.activeList) {
      requestAnimationFrame(() => snapshotRenderedMessages(true));
      return;
    }
    const removedRoots = [];
    const candidateMap = new Map();
    let totalRemovedElementCount = 0;
    let addedMessageCount = 0;
    const route = Core.parseDiscordRoute(location.pathname);
    for (const mutation of mutations) {
      mutation.removedNodes.forEach((node) => {
        removedRoots.push(node);
        totalRemovedElementCount += countElementTree(node);
        uniqueMessageNodes(node, route).forEach((message) => {
          const snapshot = state.snapshots.get(message);
          if (snapshot && snapshot.listNode === state.activeList) {
            candidateMap.set(snapshot.messageId, { snapshot, target: mutation.target });
            const key = `${route?.channelId || snapshot.record?.channelId}:${snapshot.messageId}`;
            state.recentRemovals.set(key, performance.now());
            while (state.recentRemovals.size > 500) state.recentRemovals.delete(state.recentRemovals.keys().next().value);
          }
        });
      });
      mutation.addedNodes.forEach((node) => {
        if (!state.activeList.contains(node) && node !== state.activeList) return;
        addedMessageCount += uniqueMessageNodes(node, route).length;
      });
    }
    const rootReplacement = explicitRootReplacement(removedRoots, state.activeList);
    for (const candidate of candidateMap.values()) {
      evaluateCandidate(Object.assign(candidate, {
        routeKeyAtMutation: route?.routeKey, generationAtMutation: state.generation, rootReplacement,
        removedMessageCount: candidateMap.size, totalRemovedElementCount, addedMessageCount
      }));
    }
    requestAnimationFrame(() => snapshotRenderedMessages(true));
  }

  function noteScroll(event) {
    state.lastScrollAt = performance.now();
    // DOM growth can dispatch `scroll` while the browser maintains its anchor.
    // Only direct user scroll gestures invalidate an anchorless mount here;
    // actual virtual-list movement is independently invalidated by its native
    // snowflake range signature.
    if (event?.type === "wheel" || event?.type === "touchmove") state.anchorlessEpoch += 1;
    setTimeout(() => snapshotRenderedMessages(false), Core.DEFAULTS.scrollQuietMs + 50);
  }

  function knownDeletion(channelId, messageId, allowConfirmed) {
    const key = `${channelId}:${messageId}`;
    const snapshot = state.snapshotsByKey.get(key);
    const archived = state.archive.records.find((record) => Core.recordKey(record) === key);
    const record = archived || (allowConfirmed ? snapshot?.record : null);
    if (!record || (!allowConfirmed && record.status === "confirmed_deleted")) return null;
    return {
      record,
      previousId: snapshot?.previousId || record.inferredPreviousId || null,
      nextId: snapshot?.nextId || record.inferredNextId || null,
      tail: snapshot ? snapshot.tailCandidate : Boolean(record.inferredTail),
      listIdentity: snapshot?.listIdentity || record.inferredListIdentity || null
    };
  }

  function liveMessageExists(channelId, messageId) {
    const outer = document.getElementById(`chat-messages-${channelId}-${messageId}`);
    if (outer && !outer.closest("[data-ldma-tombstone]")) return true;
    const inner = document.querySelector(`[data-list-item-id="chat-messages___${channelId}-${messageId}"]`);
    return Boolean(inner && !inner.closest("[data-ldma-tombstone]"));
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async function confirmLifecycleDeletion(channelId, ids, attempt) {
    const retryAttempt = Number.isInteger(attempt) ? attempt : 0;
    if (state.paused || !SNOWFLAKE.test(channelId) || state.route?.channelId !== channelId) return;
    await flushAllRecords();
    let eligibleIds = ids.slice(0, 200).filter((id) => SNOWFLAKE.test(id));
    const recentlyRemoved = (id) => performance.now() - (state.recentRemovals.get(`${channelId}:${id}`) || -Infinity) < 1800;
    if (eligibleIds.some((id) => liveMessageExists(channelId, id) || !recentlyRemoved(id))) {
      await delay(100);
      if (eligibleIds.some((id) => liveMessageExists(channelId, id) || !recentlyRemoved(id))) await delay(300);
      eligibleIds = eligibleIds.filter((id) => !liveMessageExists(channelId, id) && recentlyRemoved(id));
    }
    const deletions = eligibleIds.map((id) => knownDeletion(channelId, id)).filter(Boolean);
    if (!deletions.length) {
      if (retryAttempt < 3 && eligibleIds.length) {
        setTimeout(() => confirmLifecycleDeletion(channelId, ids, retryAttempt + 1).catch(() => {}), 500);
      }
      return;
    }
    const response = await send({ type: T.CONFIRM_DELETED, generation: state.generation, deletions });
    if (response.archive) applyArchive(response.archive);
    if (response.ok) queueConfirmedMounts(channelId, deletions);
    else if (retryAttempt < 3 && (response.reason === "broker-unavailable" || response.reason === "broker-error")) {
      setTimeout(() => confirmLifecycleDeletion(channelId, ids, retryAttempt + 1).catch(() => {}), 500);
    }
    requestAnimationFrame(reconcileTombstones);
    setTimeout(reconcileTombstones, 120);
    setTimeout(reconcileTombstones, 500);
  }

  async function confirmRetainedDeletion(channelId, ids, attempt) {
    const retryAttempt = Number.isInteger(attempt) ? attempt : 0;
    if (state.paused || !SNOWFLAKE.test(channelId) || state.route?.channelId !== channelId) return;
    for (const id of ids.slice(0, 200).filter((id) => SNOWFLAKE.test(id))) {
      state.pendingRetainedKeys.add(`${channelId}:${id}`);
      while (state.pendingRetainedKeys.size > 500) state.pendingRetainedKeys.delete(state.pendingRetainedKeys.values().next().value);
    }
    applyRetainedStyles();
    // A user can delete their own newly sent message before the normal DOM
    // capture debounce has persisted it. The MessageStore hook kept the native
    // row alive, so snapshot and flush that row synchronously before marking it
    // deleted in the archive.
    snapshotRenderedMessages(true);
    await flushAllRecords();
    const deletions = ids.slice(0, 200).filter((id) => SNOWFLAKE.test(id))
      .map((id) => knownDeletion(channelId, id, true)).filter(Boolean)
      .map((item) => Object.assign(item, { source: "message_store_preserved" }));
    if (!deletions.length) {
      if (retryAttempt < 3) setTimeout(() => confirmRetainedDeletion(channelId, ids, retryAttempt + 1).catch(() => {}), 500);
      return;
    }
    const response = await send({ type: T.CONFIRM_DELETED, generation: state.generation, deletions });
    if (response.archive) applyArchive(response.archive);
    if (response.ok) {
      for (const id of ids) state.pendingRetainedKeys.delete(`${channelId}:${id}`);
      // Discord can remove the rendered row even when its MessageStore record was
      // retained. Mount from the pre-delete snapshot immediately in that case;
      // the helper skips rows that are still native, so this cannot duplicate them.
      queueConfirmedMounts(channelId, deletions);
    }
    if (!response.ok && retryAttempt < 3 && (response.reason === "broker-unavailable" || response.reason === "broker-error")) {
      setTimeout(() => confirmRetainedDeletion(channelId, ids, retryAttempt + 1).catch(() => {}), 500);
    }
    requestAnimationFrame(applyRetainedStyles);
    setTimeout(applyRetainedStyles, 120);
    requestAnimationFrame(reconcileTombstones);
    setTimeout(reconcileTombstones, 120);
  }

  function mountConfirmedFromSnapshots(channelId, deletions) {
    if (state.route?.channelId !== channelId) return new Set();
    const mountedKeys = new Set();
    const currentActive = findActiveMessageList();
    for (const item of deletions) {
      const key = Core.recordKey(item.record);
      const existing = findMountedTombstone(channelId, item.record.messageId);
      if (existing) {
        mountedKeys.add(key);
        continue;
      }
      const snapshot = state.snapshotsByKey.get(key);
      const archived = state.archive.records.find((record) => Core.recordKey(record) === key);
      if (!archived || archived.status !== "confirmed_deleted") continue;
      const snapshotUsable = Boolean(snapshot?.listNode?.isConnected && snapshot.parentNode?.isConnected);
      const active = snapshotUsable ? {
        node: snapshot.listNode,
        identity: snapshot.listIdentity,
        rows: uniqueMessageNodes(snapshot.listNode, state.route),
        route: state.route
      } : currentActive;
      if (!active?.node?.isConnected) continue;
      const rows = active.rows;
      const nativeRow = findMessage(archived.messageId, rows);
      const placementRows = nativeRow ? rows.filter((row) => row !== nativeRow) : rows;
      const placement = {
        node: snapshotUsable ? snapshot.parentNode : active.node,
        identity: active.identity,
        rows: placementRows,
        route: state.route,
        allowAnchorless: placementRows.length === 0,
        confirmedMount: !nativeRow
      };
      const mounted = insertTombstone(archived, placement, nativeRow);
      if (mounted) {
        if (nativeRow) nativeRow.dataset.ldmaNativeReplaced = "true";
        mountedKeys.add(key);
      }
    }
    return mountedKeys;
  }

  function drainConfirmedMounts() {
    if (!state.pendingConfirmedMounts.size) return;
    const now = performance.now();
    const byChannel = new Map();
    for (const [key, pending] of [...state.pendingConfirmedMounts]) {
      if (pending.expiresAt <= now || pending.anchorlessEpoch !== state.anchorlessEpoch ||
        state.route?.channelId !== pending.channelId) {
        state.pendingConfirmedMounts.delete(key);
        continue;
      }
      if (!byChannel.has(pending.channelId)) byChannel.set(pending.channelId, []);
      byChannel.get(pending.channelId).push(pending.item);
    }
    for (const [channelId, items] of byChannel) {
      mountConfirmedFromSnapshots(channelId, items);
    }
  }

  function queueConfirmedMounts(channelId, deletions) {
    if (state.route?.channelId !== channelId) return;
    const now = performance.now();
    for (const item of deletions) {
      const key = Core.recordKey(item.record);
      state.pendingConfirmedMounts.set(key, {
        channelId,
        item,
        anchorlessEpoch: state.anchorlessEpoch,
        expiresAt: now + 5000
      });
      while (state.pendingConfirmedMounts.size > 500) {
        state.pendingConfirmedMounts.delete(state.pendingConfirmedMounts.keys().next().value);
      }
    }
    // Discord may replace a row, its parent group, or the entire virtual list
    // while the confirmation round-trip is in flight. Retry against the latest
    // connected list. Keep the short-lived latch even after the first success
    // because Discord can replace that just-mounted parent/list a moment later.
    // A direct user scroll changes anchorlessEpoch and cancels every retry.
    for (const delayMs of [0, 50, 150, 350, 750, 1500, 3000, 4500, 5100]) {
      setTimeout(drainConfirmedMounts, delayMs);
    }
  }

  function discardPendingEdit(pendingId, pending) {
    if (state.pendingEdits.get(pendingId) !== pending) return;
    state.pendingEdits.delete(pendingId);
  }

  function commitPendingEdit(pendingId, pending) {
    if (state.pendingEdits.get(pendingId) !== pending || pending.sending || pending.generation !== state.generation || state.paused) return;
    pending.sending = true;
    send({
      type: T.CONFIRM_EDIT,
      generation: pending.generation,
      record: pending.baseline,
      editedAt: pending.editedAt,
      editSessionId: pending.editSessionId,
      editSequence: pending.editSequence
    }).then((response) => {
      if (response.archive) applyArchive(response.archive);
      if (response.ok) {
        discardPendingEdit(pendingId, pending);
        send({ type: T.CACHE_MEDIA, generation: pending.generation, keys: [pending.recordKey] }).catch(() => {});
        return;
      }
      pending.sending = false;
      if (!["broker-unavailable", "broker-error"].includes(response.reason) || pending.attempts >= 4 ||
        performance.now() >= pending.expiresAt) {
        discardPendingEdit(pendingId, pending);
        return;
      }
      pending.attempts += 1;
      setTimeout(() => commitPendingEdit(pendingId, pending), Math.min(2000, 150 * (2 ** pending.attempts)));
    }).catch(() => {
      pending.sending = false;
      if (pending.attempts >= 4 || performance.now() >= pending.expiresAt) discardPendingEdit(pendingId, pending);
      else {
        pending.attempts += 1;
        setTimeout(() => commitPendingEdit(pendingId, pending), Math.min(2000, 150 * (2 ** pending.attempts)));
      }
    });
  }

  function verifyPendingEdit(pendingId, pending, renderedRecord) {
    if (state.pendingEdits.get(pendingId) !== pending || pending.generation !== state.generation || state.paused ||
      performance.now() >= pending.expiresAt) {
      discardPendingEdit(pendingId, pending);
      return;
    }
    if (state.route?.channelId !== pending.channelId) return;
    const row = retainedRow(pending.channelId, pending.messageId, state.activeList) ||
      findMessage(pending.messageId, state.activeList ? uniqueMessageNodes(state.activeList, state.route) : []);
    const current = renderedRecord && Core.recordKey(renderedRecord) === pending.recordKey
      ? renderedRecord
      : row && recordFromNode(row, Date.now());
    // The MAIN-world lifecycle signal contains IDs only. Persist its staged
    // baseline only after the isolated world observes the exact row's semantic
    // text/media payload change. No-op or forged events therefore write nothing.
    if (current && Core.editPayloadSignature(current) !== pending.baselineSignature) {
      commitPendingEdit(pendingId, pending);
    }
  }

  function verifyPendingEditsForRecord(record) {
    const key = Core.recordKey(record);
    for (const [pendingId, pending] of state.pendingEdits) {
      if (pending.recordKey === key) verifyPendingEdit(pendingId, pending, record);
    }
  }

  function editLifecycleIdentity(message) {
    const channelId = String(message?.channelId || "");
    const messageId = String(message?.ids?.[0] || "");
    const editSessionId = Core.normalizeText(message?.editSessionId).slice(0, 100);
    const editSequence = Math.max(0, Math.floor(Number(message?.editSequence) || 0));
    if (state.paused || state.route?.channelId !== channelId || !SNOWFLAKE.test(channelId) ||
      !SNOWFLAKE.test(messageId) || !editSessionId || !editSequence) return null;
    return {
      channelId,
      messageId,
      editSessionId,
      editSequence,
      key: `${channelId}:${messageId}`,
      pendingId: `${channelId}:${messageId}|${editSessionId}:${editSequence}`
    };
  }

  function stageSelfEditLifecycle(message) {
    const identity = editLifecycleIdentity(message);
    if (!identity) return;
    const active = updateActiveList();
    const row = retainedRow(identity.channelId, identity.messageId, active?.node) ||
      findMessage(identity.messageId, active?.rows || []);
    const baseline = (row && recordFromNode(row, Date.now())) || state.snapshotsByKey.get(identity.key)?.record ||
      state.archive.records.find((record) => Core.recordKey(record) === identity.key);
    if (!baseline) return;
    // Settle an immediately preceding local attempt before staging another.
    // A changed payload commits the prior revision; an unchanged payload means
    // the prior successful response was a semantic no-op and is discarded.
    for (const [pendingId, pending] of state.pendingEdits) {
      if (pending.recordKey !== identity.key || pending.sending) continue;
      if (Core.editPayloadSignature(baseline) !== pending.baselineSignature) {
        verifyPendingEdit(pendingId, pending, baseline);
      } else {
        discardPendingEdit(pendingId, pending);
      }
    }
    state.stagedSelfEdits.set(identity.pendingId, {
      baseline,
      baselineSignature: Core.editPayloadSignature(baseline),
      generation: state.generation,
      expiresAt: performance.now() + 5 * 60 * 1000
    });
    while (state.stagedSelfEdits.size > 100) {
      state.stagedSelfEdits.delete(state.stagedSelfEdits.keys().next().value);
    }
  }

  function cancelSelfEditLifecycle(message) {
    const identity = editLifecycleIdentity(message);
    if (identity) state.stagedSelfEdits.delete(identity.pendingId);
  }

  function confirmEditLifecycle(message) {
    const identity = editLifecycleIdentity(message);
    const editedAt = Number(message?.editedAt);
    if (!identity || !Number.isFinite(editedAt) || editedAt <= 0) return;
    const staged = state.stagedSelfEdits.get(identity.pendingId);
    state.stagedSelfEdits.delete(identity.pendingId);
    const validStaged = staged && staged.generation === state.generation && performance.now() < staged.expiresAt;
    const row = retainedRow(identity.channelId, identity.messageId, state.activeList) ||
      findMessage(identity.messageId, state.activeList ? uniqueMessageNodes(state.activeList, state.route) : []);
    const baseline = (validStaged && staged.baseline) || (row && recordFromNode(row, Date.now())) ||
      state.snapshotsByKey.get(identity.key)?.record || state.archive.records.find((record) => Core.recordKey(record) === identity.key);
    if (!baseline) return;
    if (state.pendingEdits.has(identity.pendingId)) return;
    const lifetimeMs = validStaged ? 30000 : 30 * 60 * 1000;
    const pending = {
      baseline,
      baselineSignature: validStaged ? staged.baselineSignature : Core.editPayloadSignature(baseline),
      recordKey: identity.key,
      channelId: identity.channelId,
      messageId: identity.messageId,
      editedAt,
      editSessionId: identity.editSessionId,
      editSequence: identity.editSequence,
      generation: state.generation,
      // Virtualized/off-route rows can remain absent for a long time. Keep the
      // already-captured baseline bounded in memory until that exact message is
      // rendered again, rather than letting an ordinary later upsert erase it.
      expiresAt: performance.now() + lifetimeMs,
      attempts: 0,
      sending: false
    };
    state.pendingEdits.set(identity.pendingId, pending);
    while (state.pendingEdits.size > 500) state.pendingEdits.delete(state.pendingEdits.keys().next().value);
    for (const delayMs of [0, 16, 50, 150, 350, 750]) {
      setTimeout(() => {
        snapshotRenderedMessages(true);
        verifyPendingEdit(identity.pendingId, pending);
      }, delayMs);
    }
    setTimeout(() => discardPendingEdit(identity.pendingId, pending), lifetimeMs + 1000);
  }

  function installPageBridge() {
    window.addEventListener(EDIT_EVENT, (event) => {
      let message = null;
      try { message = JSON.parse(String(event.detail || "")); } catch (_error) { return; }
      if (!message || message.bridge !== BRIDGE || !["edit-stage", "edit-before", "edit-cancel"].includes(message.kind)) return;
      checkRoute();
      if (message.kind === "edit-stage") stageSelfEditLifecycle(message);
      else if (message.kind === "edit-before") confirmEditLifecycle(message);
      else cancelSelfEditLifecycle(message);
    });
    window.addEventListener("message", (event) => {
      const message = event.data;
      if (event.source !== window || !message || message.bridge !== BRIDGE) return;
      if (message.kind === "ready-request") {
        signalPageBridgeReady();
        return;
      }
      if (message.kind === "status" && ["active", "searching", "degraded"].includes(message.status)) {
        state.pageHookLastSeenAt = performance.now();
        state.pageHookStatus = message.status;
        state.pageHookDetail = Core.normalizeText(message.detail).slice(0, 220) || "Discord deletion event hook status unavailable.";
        reportCombinedHealth(state.activeList && { node: state.activeList });
        return;
      }
      if (["edit-stage", "edit-before", "edit-cancel"].includes(message.kind)) {
        checkRoute();
        if (message.kind === "edit-stage") stageSelfEditLifecycle(message);
        else if (message.kind === "edit-before") confirmEditLifecycle(message);
        else cancelSelfEditLifecycle(message);
        return;
      }
      if (!SNOWFLAKE.test(String(message.channelId || "")) || !Array.isArray(message.ids)) return;
      const ids = [...new Set(message.ids.slice(0, 200).map(String))];
      // Discord can enter a channel and deliver the first lifecycle event before
      // the 300 ms SPA route poll runs. Synchronize the route at the event boundary
      // so the first edit/delete is never rejected as belonging to the old page.
      checkRoute();
      if (message.kind === "retained") {
        confirmRetainedDeletion(String(message.channelId), ids).catch(() => {});
      } else if (message.kind === "delete") {
        confirmLifecycleDeletion(String(message.channelId), ids).catch(() => {});
      }
    });
  }

  function signalPageBridgeReady() {
    window.postMessage({ bridge: BRIDGE, kind: "isolated-ready" }, "*");
  }

  function checkRoute() {
    const route = Core.parseDiscordRoute(location.pathname);
    if ((route?.routeKey) !== (state.route?.routeKey)) {
      state.route = route;
      state.lastRouteAt = performance.now();
      state.anchorlessEpoch += 1;
      state.signatures.clear();
      state.recentRemovals.clear();
      state.pendingRetainedKeys.clear();
      state.pendingReleaseKeys.clear();
      state.pendingConfirmedMounts.clear();
      state.stagedSelfEdits.clear();
      clearTimeout(state.authorResolutionTimer);
      state.authorResolutionTimer = null;
      state.pendingAuthorResolutionIds.clear();
      state.activeList = null;
      state.listIdentity = null;
      removeTombstone();
      removeEditHistories();
      removeLiveAuthorActions();
      if (!route) send({ type: LIVE_HEALTH, status: "inactive", detail: "This Discord document is outside a channel route." }).catch(() => {});
      refreshArchive().catch(() => {});
      if (route) requestPageHook("channel-route-entered").catch(() => {});
      setTimeout(() => snapshotRenderedMessages(true), Core.DEFAULTS.routeQuietMs + 50);
    }
  }

  async function initialize() {
    installPageBridge();
    if (state.route) reportHealth("starting", "Connecting this Discord document to local capture.");
    requestPageHook("content-start").catch(() => {});
    await refreshArchive();
    function connectUpdates() {
      const port = chrome.runtime.connect({ name: "ldma-updates" });
      port.onMessage.addListener((message) => {
        if (message.type === "LDMA_ARCHIVE_CHANGED") refreshArchive().catch(() => {});
      });
      port.onDisconnect.addListener(() => setTimeout(connectUpdates, 500));
      if (state.route) reportCombinedHealth(state.activeList && { node: state.activeList }, true);
    }
    connectUpdates();
    const root = document.getElementById("app-mount") || document.documentElement;
    new MutationObserver(handleMutations).observe(root, { childList: true, subtree: true });
    document.addEventListener("scroll", noteScroll, true);
    document.addEventListener("wheel", noteScroll, { capture: true, passive: true });
    document.addEventListener("touchmove", noteScroll, { capture: true, passive: true });
    window.addEventListener("resize", scheduleTombstoneSpacing, { passive: true });
    setInterval(checkRoute, 300);
    setInterval(() => snapshotRenderedMessages(true), 2000);
    setInterval(() => {
      if (state.route && (state.pageHookStatus !== "active" ||
        performance.now() - state.pageHookLastSeenAt > 15000)) {
        requestPageHook("lifecycle-watchdog").catch(() => {});
      }
    }, 5000);
    setInterval(() => {
      if (state.route) reportCombinedHealth(state.activeList && { node: state.activeList }, true);
    }, 15000);
    // Also heals missed change notifications if Chrome suspended the MV3 worker.
    setInterval(() => refreshArchive().catch(() => {}), 10000);
    snapshotRenderedMessages(true);
    signalPageBridgeReady();
    controller.recover = function recoverContent(reason) {
      requestPageHook(reason || "content-recovery").catch(() => {});
      refreshArchive().then(() => {
        checkRoute();
        snapshotRenderedMessages(true);
        signalPageBridgeReady();
      }).catch(() => {});
    };
    if (controller.pendingRecovery) controller.recover("queued-injection");
  }

  initialize().catch(() => reportHealth("degraded", "The local archive broker is unavailable."));
})();
