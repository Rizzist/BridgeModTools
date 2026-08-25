(function attachCore(root) {
  "use strict";

  const DEFAULTS = Object.freeze({
    maxRecords: 1500,
    maxBytes: 4 * 1024 * 1024,
    seenReserve: 50,
    seenReserveBytes: 256 * 1024,
    maxSnapshotAgeMs: 30000,
    scrollQuietMs: 1500,
    routeQuietMs: 1200,
    reappearanceGraceMs: 1400,
    maxRemovedMessages: 1,
    maxRemovedElements: 250,
    maxAddedMessages: 0,
    anchorTolerancePx: 6
  });

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function parseDiscordRoute(pathname) {
    const match = String(pathname || "").match(/^\/channels\/([^/]+)\/([^/?#]+)/);
    if (!match) return null;
    return {
      guildId: match[1] === "@me" ? null : match[1],
      channelId: match[2],
      routeKey: `${match[1]}/${match[2]}`
    };
  }

  function recordKey(record) {
    return `${record.channelId || "unknown"}:${record.messageId || "unknown"}`;
  }

  function isDeletedStatus(status) {
    return status === "confirmed_deleted" || status === "inferred_deleted";
  }

  function parseMessageRowIdentity(rawValue) {
    const snowflakes = String(rawValue || "").match(/\d{15,25}/g) || [];
    if (!snowflakes.length) return null;
    return {
      messageId: snowflakes[snowflakes.length - 1],
      channelId: snowflakes.length > 1 ? snowflakes[snowflakes.length - 2] : null
    };
  }

  function rowBelongsToChannel(rawValue, channelId) {
    const identity = parseMessageRowIdentity(rawValue);
    return Boolean(identity && (!identity.channelId || identity.channelId === String(channelId)));
  }

  function compareSnowflakeIds(leftValue, rightValue) {
    const left = String(leftValue || "");
    const right = String(rightValue || "");
    if (left === right) return 0;
    if (left.length !== right.length) return left.length < right.length ? -1 : 1;
    return left < right ? -1 : 1;
  }

  function chronologicalNeighborIds(messageId, rawRowIds) {
    let previousId = null;
    let nextId = null;
    for (const raw of Array.isArray(rawRowIds) ? rawRowIds : []) {
      const identity = parseMessageRowIdentity(raw);
      if (!identity || identity.messageId === String(messageId)) continue;
      const order = compareSnowflakeIds(identity.messageId, messageId);
      if (order < 0 && (!previousId || compareSnowflakeIds(identity.messageId, previousId) > 0)) {
        previousId = identity.messageId;
      } else if (order > 0 && (!nextId || compareSnowflakeIds(identity.messageId, nextId) < 0)) {
        nextId = identity.messageId;
      }
    }
    return { previousId, nextId };
  }

  function anchorlessRestoreAllowed(messageId, rawRowIds, options) {
    const settings = options || {};
    const ids = (Array.isArray(rawRowIds) ? rawRowIds : [])
      .map(parseMessageRowIdentity).filter(Boolean).map((identity) => identity.messageId);
    if (!ids.length) return Boolean(settings.allowEmpty);
    const oldest = ids.reduce((left, right) => compareSnowflakeIds(left, right) <= 0 ? left : right);
    const newest = ids.reduce((left, right) => compareSnowflakeIds(left, right) >= 0 ? left : right);
    const withinRange = compareSnowflakeIds(messageId, oldest) >= 0 && compareSnowflakeIds(messageId, newest) <= 0;
    const safeTail = Boolean(settings.tail && settings.atBottom && compareSnowflakeIds(messageId, newest) > 0);
    return withinRange || safeTail;
  }

  function messageUsernameLabelId(labelledBy) {
    return String(labelledBy || "").split(/\s+/)
      .find((id) => /^message-username-\d{15,25}$/.test(id)) || null;
  }

  function isAtScrollBottom(metrics, tolerancePx) {
    if (!metrics) return false;
    const scrollTop = Number(metrics.scrollTop);
    const scrollHeight = Number(metrics.scrollHeight);
    const clientHeight = Number(metrics.clientHeight);
    if (![scrollTop, scrollHeight, clientHeight].every(Number.isFinite) || clientHeight <= 0) return false;
    return scrollHeight - scrollTop - clientHeight <= (tolerancePx === undefined ? 24 : tolerancePx);
  }

  function chooseActiveList(candidates, channelId) {
    const eligible = (Array.isArray(candidates) ? candidates : []).filter((candidate) => {
      const rowIds = Array.isArray(candidate.rowIds) ? candidate.rowIds : [];
      // Discord date dividers currently share the `chat-messages___` prefix but
      // contain no snowflake. Ignore those structural rows without allowing a
      // real message from another channel into the active list.
      const messageRows = rowIds.map(parseMessageRowIdentity).filter(Boolean);
      return messageRows.length > 0 && messageRows.every((identity) =>
        !identity.channelId || identity.channelId === String(channelId));
    });
    const uniqueVisiblePreferred = eligible.filter((candidate) => candidate.preferredList && candidate.intersectsViewport);
    if (uniqueVisiblePreferred.length === 1) return uniqueVisiblePreferred[0];
    let best = null;
    let bestScore = -Infinity;
    for (const candidate of eligible) {
      const rowIds = Array.isArray(candidate.rowIds) ? candidate.rowIds : [];
      const score = rowIds.length * 10 +
        (candidate.directParent ? 20 : 0) +
        (candidate.preferredList ? 100 : 0) +
        (candidate.intersectsViewport ? 50 : 0);
      if (score > bestScore) { best = candidate; bestScore = score; }
    }
    return best;
  }

  function tombstoneCleanupKeys(records, mountedKeys, liveKeys) {
    const deleted = new Set((Array.isArray(records) ? records : [])
      .filter((record) => isDeletedStatus(record.status))
      .map(recordKey));
    const live = new Set(Array.isArray(liveKeys) ? liveKeys : []);
    return (Array.isArray(mountedKeys) ? mountedKeys : []).filter((key) => !deleted.has(key) || live.has(key));
  }

  function estimateBytes(value) {
    return JSON.stringify(value).length * 2;
  }

  function safePresentationCss(value, maxLength) {
    const text = String(value || "").trim();
    if (!text || text.length > (maxLength || 500) || /url\s*\(|var\s*\(|attr\s*\(|expression|javascript|[{};<>]/i.test(text)) return null;
    return text;
  }

  function safePresentationColor(value) {
    const text = String(value || "").trim();
    const functional = /^(?:rgba?|hsla?|oklab|oklch|lab|lch)\([^;{}]+\)$/i;
    return functional.test(text) || /^#[0-9a-f]{3,8}$/i.test(text) ||
      ["transparent", "currentcolor"].includes(text.toLocaleLowerCase()) ? text : null;
  }

  function safePresentationGradient(value) {
    const text = safePresentationCss(value, 800);
    if (!text || !/^(?:repeating-)?(?:linear|radial|conic)-gradient\([\s\S]*\)$/i.test(text)) return null;
    let depth = 0;
    for (let index = text.indexOf("("); index < text.length; index += 1) {
      if (text[index] === "(") depth += 1;
      if (text[index] === ")") depth -= 1;
      if (depth < 0 || (depth === 0 && index < text.length - 1)) return null;
    }
    return depth === 0 ? text : null;
  }

  function safeDiscordAssetUrl(value) {
    try {
      const url = new URL(String(value || ""));
      const allowedHosts = new Set([
        "cdn.discordapp.com", "media.discordapp.net", "images-ext-1.discordapp.net", "images-ext-2.discordapp.net"
      ]);
      const allowedPath = /^\/(?:avatars|role-icons|guild-tag-badges|app-icons|icons|embed\/avatars|assets|external)\//.test(url.pathname) ||
        /^\/guilds\/\d{15,25}\/users\/\d{15,25}\/avatars\//.test(url.pathname);
      return url.protocol === "https:" && allowedHosts.has(url.hostname) && allowedPath ? url.href : null;
    } catch (_error) {
      return null;
    }
  }

  function sanitizeAuthorAnimation(value) {
    if (!value || !Array.isArray(value.frames) || !value.timing) return null;
    const allowedProperties = new Set(["backgroundPosition", "backgroundPositionX", "backgroundPositionY", "color", "opacity"]);
    const frames = value.frames.slice(0, 12).map((frame) => {
      if (!frame || typeof frame !== "object") return null;
      const kept = {};
      const offset = Number(frame.offset);
      if (Number.isFinite(offset) && offset >= 0 && offset <= 1) kept.offset = offset;
      for (const [property, raw] of Object.entries(frame)) {
        if (!allowedProperties.has(property)) continue;
        let safe = null;
        if (property === "color") safe = safePresentationColor(raw);
        else if (property === "opacity") {
          const opacity = Number(raw);
          if (Number.isFinite(opacity) && opacity >= 0 && opacity <= 1) safe = String(opacity);
        } else {
          const position = safePresentationCss(raw, 120);
          if (position && /^(?:-?\d+(?:\.\d+)?(?:px|%)?|left|right|top|bottom|center|\s|,)+$/i.test(position)) safe = position;
        }
        if (safe) kept[property] = safe;
      }
      return Object.keys(kept).some((key) => key !== "offset") ? kept : null;
    }).filter(Boolean);
    const duration = Number(value.timing.duration);
    if (frames.length < 2 || !Number.isFinite(duration) || duration <= 0 || duration > 60000) return null;
    const rawIterations = Number(value.timing.iterations);
    const iterations = rawIterations === -1 ? -1 : Number.isFinite(rawIterations) ? Math.max(0, Math.min(1000, rawIterations)) : 1;
    return {
      frames,
      timing: {
        duration,
        delay: Number.isFinite(Number(value.timing.delay)) ? Math.max(-60000, Math.min(60000, Number(value.timing.delay))) : 0,
        iterations,
        direction: ["normal", "reverse", "alternate", "alternate-reverse"].includes(value.timing.direction) ? value.timing.direction : "normal",
        fill: ["none", "forwards", "backwards", "both", "auto"].includes(value.timing.fill) ? value.timing.fill : "none",
        easing: safePresentationCss(value.timing.easing, 120) || "linear"
      }
    };
  }

  function sanitizeAuthorStyle(value) {
    if (!value || typeof value !== "object") return null;
    const style = {
      color: safePresentationColor(value.color),
      gradient: safePresentationGradient(value.gradient),
      backgroundSize: safePresentationCss(value.backgroundSize, 120),
      backgroundPosition: safePresentationCss(value.backgroundPosition, 120),
      textFillColor: safePresentationColor(value.textFillColor),
      fontWeight: /^(?:normal|bold|[1-9]00)$/.test(String(value.fontWeight || "")) ? String(value.fontWeight) : null,
      textShadow: safePresentationCss(value.textShadow, 240),
      animation: sanitizeAuthorAnimation(value.animation)
    };
    return Object.values(style).some(Boolean) ? style : null;
  }

  function sanitizeAuthorBadges(value) {
    return (Array.isArray(value) ? value : []).slice(0, 4).map((badge) => {
      if (!badge || typeof badge !== "object") return null;
      const label = normalizeText(badge.label).slice(0, 120);
      if (badge.kind === "app") {
        return { kind: "app", label: normalizeText(badge.label || "APP").slice(0, 12) || "APP", verified: Boolean(badge.verified) };
      }
      if (badge.kind === "image") {
        const url = safeDiscordAssetUrl(badge.url);
        if (!url || !/^\/(?:role-icons|guild-tag-badges|app-icons|icons|assets)\//.test(new URL(url).pathname)) return null;
        return {
          kind: "image", url, label,
          width: Math.max(12, Math.min(24, Number(badge.width) || 20)),
          height: Math.max(12, Math.min(24, Number(badge.height) || 20))
        };
      }
      if (badge.kind === "vector") {
        const viewBox = String(badge.viewBox || "0 0 24 24");
        if (!/^-?\d+(?:\.\d+)?(?:\s+-?\d+(?:\.\d+)?){3}$/.test(viewBox)) return null;
        const paths = (Array.isArray(badge.paths) ? badge.paths : []).slice(0, 8).map((path) => {
          const d = String(path?.d || "");
          if (!d || d.length > 1200 || !/^[MmZzLlHhVvCcSsQqTtAa0-9eE+.,\-\s]+$/.test(d)) return null;
          return {
            d,
            fill: safePresentationColor(path.fill) || "currentColor",
            stroke: safePresentationColor(path.stroke),
            fillRule: ["evenodd", "nonzero"].includes(path.fillRule) ? path.fillRule : null,
            clipRule: ["evenodd", "nonzero"].includes(path.clipRule) ? path.clipRule : null
          };
        }).filter(Boolean);
        if (!paths.length) return null;
        return {
          kind: "vector", label, viewBox,
          width: Math.max(12, Math.min(24, Number(badge.width) || 20)),
          height: Math.max(12, Math.min(24, Number(badge.height) || 20)), paths
        };
      }
      if (badge.kind === "text") {
        const text = normalizeText(badge.text).slice(0, 24);
        if (!text) return null;
        return {
          kind: "text", text, label,
          color: safePresentationColor(badge.color),
          backgroundColor: safePresentationColor(badge.backgroundColor),
          borderRadius: safePresentationCss(badge.borderRadius, 40)
        };
      }
      return null;
    }).filter(Boolean);
  }

  function sanitizeRecordPresentation(record) {
    if (!record || typeof record !== "object") return record;
    const next = Object.assign({}, record);
    const style = sanitizeAuthorStyle(record.authorStyle);
    const badges = sanitizeAuthorBadges(record.authorBadges);
    const legacyColor = safePresentationColor(record.authorColor);
    if (style) next.authorStyle = style;
    else delete next.authorStyle;
    next.authorBadges = badges;
    if (legacyColor || style?.color) next.authorColor = legacyColor || style.color;
    else delete next.authorColor;
    next.avatarUrl = safeDiscordAssetUrl(record.avatarUrl);
    return next;
  }

  function balancedTombstoneShift(measuredTop, measuredBottom, firstPriorShift, lastPriorShift, maxGap) {
    const values = [measuredTop, measuredBottom, firstPriorShift || 0, lastPriorShift || 0].map(Number);
    if (!values.every(Number.isFinite)) return 0;
    const naturalTop = values[0] - values[2];
    const naturalBottom = values[1] + values[3];
    const upper = maxGap === undefined ? 24 : Number(maxGap);
    if (!Number.isFinite(upper) || naturalTop < -0.5 || naturalBottom < -0.5 || naturalTop > upper || naturalBottom > upper) return 0;
    return (naturalBottom - naturalTop) / 2;
  }

  function pruneRecords(records, options) {
    const limits = Object.assign({}, DEFAULTS, options || {});
    const byKey = new Map();
    for (const item of Array.isArray(records) ? records : []) {
      if (!item || !item.messageId) continue;
      const sanitized = sanitizeRecordPresentation(item);
      const key = recordKey(item);
      const existing = byKey.get(key);
      const itemTime = sanitized.updatedAt || sanitized.capturedAt || 0;
      const existingTime = existing && (existing.updatedAt || existing.capturedAt || 0);
      if (!existing || itemTime >= existingTime) byKey.set(key, sanitized);
    }

    const newestFirst = (a, b) => (b.updatedAt || b.capturedAt || 0) - (a.updatedAt || a.capturedAt || 0);
    const deleted = [...byKey.values()].filter((record) => isDeletedStatus(record.status)).sort(newestFirst);
    const seen = [...byKey.values()].filter((record) => !isDeletedStatus(record.status)).sort(newestFirst);
    const maxRecords = Math.max(0, Math.floor(Number(limits.maxRecords) || 0));
    const maxBytes = Math.max(0, Number(limits.maxBytes) || 0);
    const reserveCount = Math.min(Math.max(0, maxRecords - 1), Math.max(0, Math.floor(Number(limits.seenReserve) || 0)));
    const reserveBytes = Math.min(Math.max(0, Number(limits.seenReserveBytes) || 0), maxBytes * 0.1);
    const selected = [];
    const selectedKeys = new Set();
    let totalBytes = 2;
    const add = (record, byteCeiling) => {
      if (selected.length >= maxRecords || selectedKeys.has(recordKey(record))) return false;
      const bytes = estimateBytes(record) + 1;
      if (totalBytes + bytes > Math.min(maxBytes, byteCeiling === undefined ? maxBytes : byteCeiling)) return false;
      selected.push(record);
      selectedKeys.add(recordKey(record));
      totalBytes += bytes;
      return true;
    };
    let reserved = 0;
    for (const record of seen) {
      if (reserved >= reserveCount) break;
      if (add(record, 2 + reserveBytes)) reserved += 1;
    }
    for (const record of deleted) add(record);
    for (const record of seen) add(record);
    return selected.sort((a, b) => {
      const statusOrder = Number(isDeletedStatus(b.status)) - Number(isDeletedStatus(a.status));
      return statusOrder || newestFirst(a, b);
    });
  }

  function mergeRecords(existing, incoming, options) {
    const now = (options && options.now) || Date.now();
    const byKey = new Map();
    for (const record of Array.isArray(existing) ? existing : []) {
      if (record && record.messageId) byKey.set(recordKey(record), sanitizeRecordPresentation(record));
    }
    for (const record of Array.isArray(incoming) ? incoming : []) {
      if (!record || !record.messageId) continue;
      const key = recordKey(record);
      const old = byKey.get(key) || {};
      const safeRecord = sanitizeRecordPresentation(record);
      const merged = Object.assign({}, old, safeRecord, {
        firstCapturedAt: old.firstCapturedAt || record.firstCapturedAt || record.capturedAt || now,
        updatedAt: now
      });
      if (isDeletedStatus(old.status) && !isDeletedStatus(record.status)) {
        merged.status = old.status;
        merged.inferredDeletedAt = old.inferredDeletedAt;
        merged.confirmedDeletedAt = old.confirmedDeletedAt;
        merged.deletionSource = old.deletionSource;
      } else if (old.status === "confirmed_deleted" && record.status === "inferred_deleted") {
        merged.status = old.status;
        merged.confirmedDeletedAt = old.confirmedDeletedAt;
        merged.deletionSource = old.deletionSource;
      }
      byKey.set(key, merged);
    }
    return pruneRecords([...byKey.values()], options);
  }

  function searchRecords(records, query, status) {
    const needle = normalizeText(query).toLocaleLowerCase();
    return (Array.isArray(records) ? records : [])
      .filter((record) => !status || status === "all" || record.status === status)
      .filter((record) => {
        if (!needle) return true;
        const haystack = [
          record.author,
          record.content,
          record.channelName,
          record.channelId,
          record.guildId,
          ...(Array.isArray(record.attachments) ? record.attachments : [])
        ].join(" ").toLocaleLowerCase();
        return haystack.includes(needle);
      })
      .sort((a, b) => {
        return (b.inferredDeletedAt || b.updatedAt || b.capturedAt || 0) -
          (a.inferredDeletedAt || a.updatedAt || a.capturedAt || 0);
      });
  }

  function classifyRemoval(signal, options) {
    const limits = Object.assign({}, DEFAULTS, options || {});
    const reject = (reason) => ({ highConfidence: false, reason });
    if (!signal || !signal.candidateKnown) return reject("unknown-message");
    if (signal.documentHidden) return reject("document-hidden");
    if (signal.routeChanged || !signal.sameChannel) return reject("navigation");
    if (signal.rootReplacement) return reject("root-replacement");
    if (signal.removedMessageCount !== 1) return reject("invalid-removal-count");
    if ((signal.totalRemovedElementCount || 0) > limits.maxRemovedElements) return reject("mass-dom-removal");
    if ((signal.addedMessageCount || 0) > limits.maxAddedMessages) return reject("list-replacement");
    if ((signal.msSinceScroll || 0) < limits.scrollQuietMs) return reject("recent-scroll");
    if ((signal.msSinceRouteChange || 0) < limits.routeQuietMs) return reject("recent-navigation");
    if (!signal.targetConnected) return reject("detached-container");
    if (!signal.listUnchanged || !signal.parentUnchanged) return reject("list-or-parent-changed");
    if (!signal.wasVisible || (signal.visibleRatio || 0) < 0.7 || !signal.innerViewport) {
      return reject("offscreen-or-edge-visible");
    }
    if ((signal.snapshotAgeMs || 0) > limits.maxSnapshotAgeMs) return reject("stale-snapshot");
    if (signal.currentlyPresent) return reject("message-still-present");
    if (!signal.previousAnchorPresent) return reject("missing-previous-anchor");
    if (signal.tailCandidate) {
      if (!signal.wasAtBottom) return reject("tail-not-at-bottom");
    } else {
      if (!signal.nextAnchorPresent) return reject("missing-next-anchor");
      if (!signal.anchorsAdjacent) return reject("anchors-not-adjacent");
    }
    if (Math.abs(signal.previousAnchorDeltaPx || 0) > limits.anchorTolerancePx) return reject("layout-shift");
    return {
      highConfidence: true,
      reason: signal.tailCandidate ? "stationary-tail-removal" : "stationary-single-removal"
    };
  }

  const api = Object.freeze({
    DEFAULTS,
    normalizeText,
    parseDiscordRoute,
    recordKey,
    isDeletedStatus,
    parseMessageRowIdentity,
    rowBelongsToChannel,
    compareSnowflakeIds,
    chronologicalNeighborIds, anchorlessRestoreAllowed,
    messageUsernameLabelId,
    isAtScrollBottom,
    chooseActiveList,
    tombstoneCleanupKeys,
    estimateBytes,
    safePresentationCss,
    safePresentationColor,
    safePresentationGradient,
    safeDiscordAssetUrl,
    sanitizeAuthorAnimation,
    sanitizeAuthorStyle,
    sanitizeAuthorBadges,
    sanitizeRecordPresentation,
    balancedTombstoneShift,
    pruneRecords,
    mergeRecords,
    searchRecords,
    classifyRemoval
  });

  root.LocalDiscordArchiveCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
