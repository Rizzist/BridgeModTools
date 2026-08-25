(function runContentScript() {
  "use strict";

  const Core = globalThis.LocalDiscordArchiveCore;
  const Protocol = globalThis.LocalDiscordArchiveProtocol;
  if (!Core || !Protocol || !globalThis.chrome || !chrome.runtime) return;

  const T = Protocol.TYPES;
  const MESSAGE_SELECTOR = "li[id^='chat-messages-'], [data-list-item-id^='chat-messages___']";
  const LIST_SELECTOR = ["[data-list-id='chat-messages']", "ol[aria-label*='essages']", "[role='list'][aria-label*='essages']"].join(",");
  const AUTHOR_SELECTORS = ["[id^='message-username-']", "[class*='username_']"];
  const BRIDGE = "LDMA_BRIDGE_V1";
  const SNOWFLAKE = /^\d{15,25}$/;

  const state = {
    archive: Protocol.emptyArchive(), generation: 0, paused: false,
    route: Core.parseDiscordRoute(location.pathname), lastRouteAt: performance.now(), lastScrollAt: -Infinity,
    activeList: null, listIdentity: null, snapshots: new WeakMap(), signatures: new Map(),
    snapshotsByKey: new Map(), pageHookStatus: "searching", pageHookDetail: "Waiting for Discord's deletion event dispatcher.",
    pendingRecords: new Map(), pendingRetractions: new Set(), recentRemovals: new Map(), pendingRetainedKeys: new Set(), pendingReleaseKeys: new Set(), flushTimer: null, flushPromise: null,
    healthSignature: "", refreshPromise: null, tombstoneRenderers: new Map(), spacingFrame: 0
  };

  function send(command) {
    return chrome.runtime.sendMessage(command).catch(() => ({ ok: false, reason: "broker-unavailable" }));
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
    return {
      node: list,
      identity: stableListIdentity(list, route),
      route,
      rows: [],
      rowIds: [],
      directParent: true,
      preferredList: true,
      intersectsViewport: true,
      allowAnchorless: true
    };
  }

  function reportHealth(status, detail) {
    const signature = `${status}:${detail}`;
    if (signature === state.healthSignature) return;
    state.healthSignature = signature;
    send({ type: T.SET_HEALTH, status, detail }).catch(() => {});
  }

  function reportCombinedHealth(active) {
    if (!state.route) {
      reportHealth("unsupported", "This page is not a supported Discord channel route.");
    } else if (!active) {
      reportHealth("degraded", "No active Discord message list was found; capture is suspended.");
    } else if (state.pageHookStatus === "active") {
      reportHealth("active", `${state.pageHookDetail} Archiving rendered messages locally.`);
    } else {
      reportHealth("degraded", `${state.pageHookDetail} Rendered-message capture and conservative DOM fallback remain active.`);
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

  function allContent(node, messageId) {
    const parts = [];
    const seen = new Set();
    const add = (element) => {
      const text = Core.normalizeText(element?.textContent);
      if (text && !seen.has(text)) { seen.add(text); parts.push(text); }
    };
    const exact = node.querySelector(`[id="message-content-${messageId}"]`) || document.getElementById(`message-content-${messageId}`);
    if (exact && node.contains(exact)) {
      add(exact);
    } else {
      // Fallback for an unsupported Discord variant; exclude obvious reply-preview descendants.
      node.querySelectorAll("[class*='messageContent_']").forEach((element) => {
        if (!element.closest("[class*='repliedMessage_'], [class*='reply_']")) add(element);
      });
    }
    node.querySelectorAll("[class*='embedDescription_']").forEach((element) => {
      if (!element.closest("[class*='repliedMessage_'], [class*='reply_']")) add(element);
    });
    return parts.join("\n");
  }

  function attachmentNames(node) {
    const names = [];
    const seen = new Set();
    node.querySelectorAll("a[class*='fileNameLink_'], a[href*='/attachments/']").forEach((anchor) => {
      let name = Core.normalizeText(anchor.textContent);
      if (!name) {
        try { name = decodeURIComponent(new URL(anchor.href).pathname.split("/").pop() || "attachment"); }
        catch (_error) { name = "attachment"; }
      }
      if (!seen.has(name)) { seen.add(name); names.push(name); }
    });
    return names.slice(0, 12);
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
      if (child === authorElement || child.contains(authorElement) || child.matches("[class*='hiddenVisually_'], [aria-hidden='true']")) continue;
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
    const authorElement = authorNameElement(node);
    const authorStyle = captureAuthorStyle(authorElement);
    const presentationRow = authorElement?.closest(MESSAGE_SELECTOR) || node;
    const reply = node.querySelector("[class*='repliedMessage_'], [class*='reply_']");
    return {
      avatarUrl: safeAvatarUrl(presentationRow),
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
    const attachments = attachmentNames(node);
    const content = allContent(node, identity.messageId);
    if (!content && !attachments.length) return null;
    const timeElement = node.querySelector("time[datetime]");
    return Core.sanitizeRecordPresentation(Object.assign({
      messageId: identity.messageId, channelId: route.channelId, guildId: route.guildId,
      channelName: visibleChannelName(),
      author: visibleElementText(authorNameElement(node)) || firstText(node, AUTHOR_SELECTORS) ||
        authorFromAriaLabelledBy(node) || "Unknown author",
      content, attachments, messageTimestamp: timeElement?.getAttribute("datetime") || null,
      capturedAt: now, updatedAt: now, status: "seen"
    }, presentationFromNode(node, timeElement)));
  }

  function recordSignature(record) {
    return JSON.stringify([
      record.author, record.content, record.messageTimestamp, record.channelName, record.attachments,
      record.avatarUrl, record.authorColor, record.authorStyle, record.authorBadges,
      record.displayTimestamp, record.replyPreview
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
      state.pendingRecords.clear();
      state.signatures.clear();
    }
    state.archive = archive;
    state.generation = incomingGeneration;
    state.paused = Boolean(archive.paused);
    reconcileTombstones();
    applyRetainedStyles();
    if (wasPaused && !state.paused) requestAnimationFrame(() => snapshotRenderedMessages(true));
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

  function storedTime(record) {
    const date = new Date(record.messageTimestamp || record.capturedAt || 0);
    if (Number.isNaN(date.valueOf())) return { display: "", dateTime: "", title: "" };
    return {
      display: record.displayTimestamp || date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
      dateTime: date.toISOString(),
      title: date.toLocaleString()
    };
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
      .message { display:grid; grid-template-columns:40px minmax(0,1fr); column-gap:16px; min-height:48px; padding:2px 16px; background:rgb(242 63 66 / 7.5%); }
      .message:hover { background:rgb(242 63 66 / 10%); }
      .avatar { display:grid; place-items:center; width:40px; height:40px; overflow:hidden; border-radius:50%; background:#5865f2; color:#fff; font-size:17px; font-weight:700; user-select:none; }
      .avatar img { width:100%; height:100%; object-fit:cover; }
      .body { min-width:0; }
      .reply { position:relative; margin:-1px 0 2px; padding-left:18px; overflow:hidden; color:#b5bac1; font-size:13px; line-height:18px; text-overflow:ellipsis; white-space:nowrap; }
      .reply::before { content:""; position:absolute; left:2px; top:8px; width:11px; border-top:2px solid #4e5058; }
      .header { display:flex; align-items:baseline; min-width:0; line-height:22px; }
      .author-group { display:inline-flex; align-items:center; min-width:0; gap:4px; }
      .author { display:inline-block; overflow:hidden; color:#f2f3f5; font-size:16px; font-weight:400; text-overflow:ellipsis; white-space:nowrap; }
      .badges { display:inline-flex; align-items:center; flex:0 0 auto; gap:3px; }
      .author-icon,.author-vector { display:block; flex:0 0 auto; object-fit:contain; }
      .app-badge,.text-badge { display:inline-flex; align-items:center; height:16px; padding:0 4px; border-radius:3px; font-size:10px; font-weight:750; line-height:16px; white-space:nowrap; }
      .app-badge { gap:2px; background:#5865f2; color:#fff; }
      .app-check { font-size:11px; line-height:1; }
      .timestamp { margin-left:6px; color:#949ba4; font-size:12px; font-weight:400; white-space:nowrap; }
      .content-line { min-width:0; line-height:22px; }
      .content { color:#f23f42; white-space:pre-wrap; overflow-wrap:anywhere; }
      .deleted { margin-left:4px; color:#ff6b70; font-size:11px; font-weight:750; white-space:nowrap; }
      .attachments { color:#00a8fc; font-size:14px; line-height:20px; overflow-wrap:anywhere; }
      .attachment::before { content:"↳ "; color:#949ba4; }
      [hidden] { display:none !important; }
    `);
    shadow.adoptedStyleSheets = [sheet];

    const article = document.createElement("article");
    article.className = "message";
    article.setAttribute("role", "article");
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.setAttribute("aria-hidden", "true");
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
    const author = document.createElement("strong");
    author.className = "author";
    const badges = document.createElement("span");
    badges.className = "badges";
    authorGroup.append(author, badges);
    const timestamp = document.createElement("time");
    timestamp.className = "timestamp";
    header.append(authorGroup, timestamp);
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
    body.append(reply, header, contentLine, attachments);
    article.append(avatar, body);
    shadow.append(article);

    avatarImage.addEventListener("error", () => {
      avatarImage.hidden = true;
      avatarFallback.hidden = false;
    });

    let authorAnimation = null;
    let authorAnimationSignature = "";
    let badgeSignature = "";
    let lastRecord = null;
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
      replaceText(author, name);
      applyAuthorPresentation(record);
      const time = storedTime(record);
      replaceText(timestamp, time.display);
      timestamp.dateTime = time.dateTime;
      timestamp.title = time.title;
      reply.hidden = !record.replyPreview;
      replaceText(reply, record.replyPreview || "");
      replaceText(content, record.content || "");
      attachments.replaceChildren(...(record.attachments || []).slice(0, 12).map((nameValue) => {
        const item = document.createElement("div");
        item.className = "attachment";
        replaceText(item, `Attachment: ${nameValue}`);
        return item;
      }));
      const avatarUrl = normalizedAvatarUrl(record.avatarUrl);
      replaceText(avatarFallback, name.trim().slice(0, 1).toLocaleUpperCase() || "?");
      avatarFallback.hidden = Boolean(avatarUrl);
      avatarImage.hidden = !avatarUrl;
      if (avatarUrl) avatarImage.src = avatarUrl;
      else avatarImage.removeAttribute("src");
      article.setAttribute("aria-label", `${name}, deleted message preserved locally`);
    };
    const onMotionPreference = () => {
      authorAnimationSignature = "";
      if (lastRecord) applyAuthorPresentation(lastRecord);
    };
    reducedMotion.addEventListener("change", onMotionPreference);
    render.dispose = () => {
      reducedMotion.removeEventListener("change", onMotionPreference);
      if (authorAnimation) authorAnimation.cancel();
      authorAnimation = null;
      avatarImage.removeAttribute("src");
      badges.replaceChildren();
    };
    state.tombstoneRenderers.set(key, render);
    return render;
  }

  function insertTombstone(record, active, replacementNode) {
    const confirmed = record.status === "confirmed_deleted";
    if (!confirmed && record.inferredListIdentity && record.inferredListIdentity !== active.identity) return;
    const key = Core.recordKey(record);
    const existing = findMountedTombstone(record.channelId, record.messageId);
    if (existing) {
      const needsRangeRevalidation = existing.dataset.ldmaEmptyRestore === "true" && active.rows.length > 0;
      const belongsToTarget = replacementNode?.parentElement
        ? existing.parentElement === replacementNode.parentElement
        : Boolean(active.node?.contains(existing));
      const existingRenderer = belongsToTarget && !needsRangeRevalidation && state.tombstoneRenderers.get(key);
      if (existingRenderer && belongsToTarget) {
        existingRenderer(record);
        scheduleTombstoneSpacing();
        return true;
      }
      dropTombstoneRenderer(key);
      existing.remove();
    }

    let previous = confirmed
      ? findPositionedMessage(record.channelId, record.inferredPreviousId, active.rows, active.node)
      : findMessage(record.inferredPreviousId, active.rows);
    let next = confirmed
      ? findPositionedMessage(record.channelId, record.inferredNextId, active.rows, active.node)
      : findMessage(record.inferredNextId, active.rows);
    if (confirmed && !previous && !next) {
      const liveIds = active.rows.map((row) => rowIdentity(row)?.messageId).filter(Boolean);
      const scroller = findChatScrollContainer(active.node);
      const atBottom = Core.isAtScrollBottom(scroller && {
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight
      });
      if (!Core.anchorlessRestoreAllowed(record.messageId, liveIds, {
        allowEmpty: active.allowAnchorless,
        tail: record.inferredTail,
        atBottom
      })) return false;
      const positionedIds = active.rows.map(rawRowId).concat(
        [...active.node.querySelectorAll("[data-ldma-tombstone]")]
          .map((element) => element.dataset.ldmaMessageKey)
      );
      const chronological = Core.chronologicalNeighborIds(record.messageId, positionedIds);
      previous = findPositionedMessage(record.channelId, chronological.previousId, active.rows, active.node);
      next = findPositionedMessage(record.channelId, chronological.nextId, active.rows, active.node);
    }
    if (record.status === "inferred_deleted" && !previous) return;
    if (!previous && !next && !active.allowAnchorless) return;
    if (previous && next && previous.parentElement !== next.parentElement) return;
    if (!confirmed && previous && next && active.rows.indexOf(next) !== active.rows.indexOf(previous) + 1) return;
    const reference = next || previous || active.rows[0] || active.node;
    const element = document.createElement(reference.tagName === "LI" || active.node?.tagName === "OL" ? "li" : "div");
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
    if (replacementNode?.parentElement) {
      replacementNode.parentElement.insertBefore(element, replacementNode);
      scheduleTombstoneSpacing();
      return true;
    }
    const parent = previous?.parentElement || next?.parentElement || active.rows[0]?.parentElement || active.node;
    if (next && next.parentElement === parent) parent.insertBefore(element, next);
    else if (previous && previous.parentElement === parent) parent.insertBefore(element, previous.nextSibling);
    else parent.append(element);
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
    const cleanup = new Set(Core.tombstoneCleanupKeys(state.archive.records, mountedKeys, liveKeys));
    elements.forEach((element) => {
      const record = deleted.get(element.dataset.ldmaMessageKey);
      const wrongRoute = state.route && record && record.channelId !== state.route.channelId;
      const outsideActiveList = active && record?.channelId === active.route.channelId && !active.node.contains(element);
      if (cleanup.has(element.dataset.ldmaMessageKey) || !record || wrongRoute || outsideActiveList) {
        dropTombstoneRenderer(element.dataset.ldmaMessageKey);
        element.remove();
      }
    });
    if (!active) return;
    const ordered = [...deleted.values()].sort((left, right) => Core.compareSnowflakeIds(left.messageId, right.messageId));
    for (const record of ordered) {
      if (record.channelId === active.route.channelId && !findMessage(record.messageId, active.rows)) insertTombstone(record, active);
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
    if (state.paused) return;
    const active = updateActiveList();
    if (!active) {
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
      if (record) { retractIfReappeared(record); if (persist) queueRecord(record); }
    });
    reconcileTombstones();
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

  function noteScroll() {
    state.lastScrollAt = performance.now();
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
    if (response.ok) mountConfirmedFromSnapshots(channelId, deletions);
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
    }
    if (!response.ok && retryAttempt < 3 && (response.reason === "broker-unavailable" || response.reason === "broker-error")) {
      setTimeout(() => confirmRetainedDeletion(channelId, ids, retryAttempt + 1).catch(() => {}), 500);
    }
    requestAnimationFrame(applyRetainedStyles);
    setTimeout(applyRetainedStyles, 120);
  }

  function mountConfirmedFromSnapshots(channelId, deletions) {
    if (state.route?.channelId !== channelId) return;
    for (const item of deletions) {
      const snapshot = state.snapshotsByKey.get(Core.recordKey(item.record));
      if (!snapshot?.listNode?.isConnected || !snapshot.parentNode?.isConnected) continue;
      const rows = uniqueMessageNodes(snapshot.listNode, state.route);
      const archived = state.archive.records.find((record) => Core.recordKey(record) === Core.recordKey(item.record));
      if (!archived || archived.status !== "confirmed_deleted" || findMessage(archived.messageId, rows)) continue;
      insertTombstone(archived, {
        node: snapshot.parentNode,
        identity: snapshot.listIdentity,
        rows,
        route: state.route,
        allowAnchorless: rows.length === 0
      });
    }
  }

  function installPageBridge() {
    window.addEventListener("message", (event) => {
      const message = event.data;
      if (event.source !== window || !message || message.bridge !== BRIDGE) return;
      if (message.kind === "status" && ["active", "searching", "degraded"].includes(message.status)) {
        state.pageHookStatus = message.status;
        state.pageHookDetail = Core.normalizeText(message.detail).slice(0, 220) || "Discord deletion event hook status unavailable.";
        reportCombinedHealth(state.activeList && { node: state.activeList });
        return;
      }
      if (!SNOWFLAKE.test(String(message.channelId || "")) || !Array.isArray(message.ids)) return;
      const ids = [...new Set(message.ids.slice(0, 200).map(String))];
      if (message.kind === "retained") {
        confirmRetainedDeletion(String(message.channelId), ids).catch(() => {});
      } else if (message.kind === "delete") {
        confirmLifecycleDeletion(String(message.channelId), ids).catch(() => {});
      }
    });
    window.postMessage({ bridge: BRIDGE, kind: "isolated-ready" }, "*");
  }

  function checkRoute() {
    const route = Core.parseDiscordRoute(location.pathname);
    if ((route?.routeKey) !== (state.route?.routeKey)) {
      state.route = route;
      state.lastRouteAt = performance.now();
      state.signatures.clear();
      state.recentRemovals.clear();
      state.pendingRetainedKeys.clear();
      state.pendingReleaseKeys.clear();
      state.activeList = null;
      state.listIdentity = null;
      removeTombstone();
      setTimeout(() => snapshotRenderedMessages(true), Core.DEFAULTS.routeQuietMs + 50);
    }
  }

  async function initialize() {
    await refreshArchive();
    function connectUpdates() {
      const port = chrome.runtime.connect({ name: "ldma-updates" });
      port.onMessage.addListener((message) => {
        if (message.type === "LDMA_ARCHIVE_CHANGED") refreshArchive().catch(() => {});
      });
      port.onDisconnect.addListener(() => setTimeout(connectUpdates, 500));
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
    // Also heals missed change notifications if Chrome suspended the MV3 worker.
    setInterval(() => refreshArchive().catch(() => {}), 10000);
    snapshotRenderedMessages(true);
    installPageBridge();
  }

  initialize().catch(() => reportHealth("degraded", "The local archive broker is unavailable."));
})();
