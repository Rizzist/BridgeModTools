(function attachCore(root) {
  "use strict";

  const DEFAULTS = Object.freeze({
    maxRecords: 1500,
    maxBytes: 4 * 1024 * 1024,
    seenReserve: 50,
    seenReserveBytes: 256 * 1024,
    maxEditRevisions: 20,
    maxEditBytes: 512 * 1024,
    maxSnapshotAgeMs: 30000,
    scrollQuietMs: 1500,
    routeQuietMs: 1200,
    reappearanceGraceMs: 1400,
    continuationWindowMs: 7 * 60 * 1000,
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

  function messageRowOwnsElement(row, element, expectedMessageId) {
    if (!row || !element || row.isConnected !== true || element.isConnected !== true ||
      typeof row.contains !== "function" || !row.contains(element)) return false;
    const rawValue = row.id || row.dataset?.listItemId || "";
    return parseMessageRowIdentity(rawValue)?.messageId === String(expectedMessageId || "");
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

  function tombstoneInRenderedRange(messageId, rawRowIds, options) {
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

  function anchorlessRestoreAllowed(messageId, rawRowIds, options) {
    return tombstoneInRenderedRange(messageId, rawRowIds, options);
  }

  function messageUsernameLabelId(labelledBy) {
    return String(labelledBy || "").split(/\s+/)
      .find((id) => /^message-username-\d{15,25}$/.test(id)) || null;
  }

  function snowflakeValue(value) {
    const text = String(value || "");
    return /^\d{15,25}$/.test(text) ? text : null;
  }

  function discordUsernameValue(value) {
    if (typeof value !== "string") return null;
    const username = value.trim();
    return /^[a-z0-9._]{1,32}$/i.test(username) ? username : null;
  }

  function boundAuthorIdentity(resolvedUserIdValue, resolvedUsernameValue, fallbackUserIdValue, fallbackUsernameValue) {
    const resolvedUserId = snowflakeValue(resolvedUserIdValue);
    const fallbackUserId = snowflakeValue(fallbackUserIdValue);
    const resolvedUsername = discordUsernameValue(resolvedUsernameValue);
    const fallbackUsername = fallbackUserId ? discordUsernameValue(fallbackUsernameValue) : null;
    if (resolvedUserId) {
      return {
        userId: resolvedUserId,
        username: resolvedUsername || (resolvedUserId === fallbackUserId ? fallbackUsername : null)
      };
    }
    return { userId: fallbackUserId, username: fallbackUsername };
  }

  function avatarAuthorId(value) {
    const safe = safeDiscordAssetUrl(value);
    if (!safe) return null;
    const pathname = new URL(safe).pathname;
    const match = pathname.match(/^\/avatars\/(\d{15,25})\//) ||
      pathname.match(/^\/guilds\/\d{15,25}\/users\/(\d{15,25})\/avatars\//);
    return match ? match[1] : null;
  }

  function snowflakeTimestamp(value) {
    const snowflake = snowflakeValue(value);
    if (!snowflake) return null;
    try {
      return Number((BigInt(snowflake) >> 22n) + 1420070400000n);
    } catch (_error) {
      return null;
    }
  }

  function sameContinuationAuthor(previous, current) {
    if (!previous || !current) return false;
    const previousId = snowflakeValue(previous.authorId) || avatarAuthorId(previous.avatarUrl);
    const currentId = snowflakeValue(current.authorId) || avatarAuthorId(current.avatarUrl);
    return Boolean(previousId && currentId && previousId === currentId);
  }

  function messageMoment(record) {
    const timestamp = Date.parse(String(record?.messageTimestamp || ""));
    if (Number.isFinite(timestamp)) return timestamp;
    return snowflakeTimestamp(record?.messageId);
  }

  function sameLocalDay(leftValue, rightValue) {
    const left = new Date(leftValue);
    const right = new Date(rightValue);
    return left.getFullYear() === right.getFullYear() &&
      left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
  }

  function messageContinues(previous, current, options) {
    if (!previous || !current || current.replyPreview) return false;
    const previousMessageId = snowflakeValue(previous?.messageId);
    const currentMessageId = snowflakeValue(current?.messageId);
    const previousGroupRoot = snowflakeValue(previous?.groupRootMessageId);
    const currentGroupRoot = snowflakeValue(current?.groupRootMessageId);
    if (currentGroupRoot && !options?.ignoreGroupRoot) {
      // Native Discord grouping is authoritative when it was captured. A row
      // whose group root is itself is an explicit full-row boundary (reply,
      // time window, divider, or other Discord grouping decision).
      if (currentGroupRoot === currentMessageId) return false;
      return currentGroupRoot === (previousGroupRoot || previousMessageId);
    }
    if (!sameContinuationAuthor(previous, current)) return false;
    const previousMoment = messageMoment(previous);
    const currentMoment = messageMoment(current);
    if (previousMoment === null || currentMoment === null) return Boolean(current?.sourceContinuation);
    const windowMs = Number(options?.windowMs ?? DEFAULTS.continuationWindowMs);
    const delta = currentMoment - previousMoment;
    return Number.isFinite(windowMs) && windowMs >= 0 && delta >= 0 && delta <= windowMs &&
      sameLocalDay(previousMoment, currentMoment);
  }

  function isAtScrollBottom(metrics, tolerancePx) {
    if (!metrics) return false;
    const scrollTop = Number(metrics.scrollTop);
    const scrollHeight = Number(metrics.scrollHeight);
    const clientHeight = Number(metrics.clientHeight);
    if (![scrollTop, scrollHeight, clientHeight].every(Number.isFinite) || clientHeight <= 0) return false;
    return scrollHeight - scrollTop - clientHeight <= (tolerancePx === undefined ? 24 : tolerancePx);
  }

  function createTrailingFrameScheduler(run, runtimeValue) {
    if (typeof run !== "function") throw new TypeError("A scheduler callback is required");
    const runtime = runtimeValue || {
      requestFrame: (callback) => root.requestAnimationFrame(callback),
      cancelFrame: (token) => root.cancelAnimationFrame(token),
      setTimer: (callback, delay) => root.setTimeout(callback, delay),
      clearTimer: (token) => root.clearTimeout(token)
    };
    let frameToken = null;
    let timerToken = null;
    let persist = false;

    const schedule = (nextPersist, delayValue) => {
      persist = Boolean(persist || nextPersist);
      const delay = Math.max(0, Number(delayValue) || 0);
      if (delay > 0) {
        if (frameToken !== null) {
          runtime.cancelFrame(frameToken);
          frameToken = null;
        }
        if (timerToken !== null) runtime.clearTimer(timerToken);
        timerToken = runtime.setTimer(() => {
          timerToken = null;
          schedule(false, 0);
        }, delay);
        return;
      }
      if (timerToken !== null) {
        runtime.clearTimer(timerToken);
        timerToken = null;
      }
      if (frameToken !== null) return;
      frameToken = runtime.requestFrame(() => {
        frameToken = null;
        const shouldPersist = persist;
        persist = false;
        run(shouldPersist);
      });
    };
    schedule.cancel = () => {
      if (frameToken !== null) runtime.cancelFrame(frameToken);
      if (timerToken !== null) runtime.clearTimer(timerToken);
      frameToken = null;
      timerToken = null;
      persist = false;
    };
    schedule.pending = () => ({ frame: frameToken !== null, timer: timerToken !== null, persist });
    return schedule;
  }

  function createRateLimitedScheduler(run, intervalValue, runtimeValue) {
    if (typeof run !== "function") throw new TypeError("A scheduler callback is required");
    const interval = Math.max(1, Number(intervalValue) || 1);
    const runtime = runtimeValue || {
      now: () => root.performance.now(),
      setTimer: (callback, delay) => root.setTimeout(callback, delay),
      clearTimer: (token) => root.clearTimeout(token)
    };
    let timerToken = null;
    let lastRunAt = -Infinity;
    let persist = false;

    const invoke = () => {
      timerToken = null;
      lastRunAt = runtime.now();
      const shouldPersist = persist;
      persist = false;
      run(shouldPersist);
    };
    const schedule = (nextPersist) => {
      persist = Boolean(persist || nextPersist);
      const remaining = interval - (runtime.now() - lastRunAt);
      if (remaining <= 0) {
        if (timerToken !== null) runtime.clearTimer(timerToken);
        invoke();
        return;
      }
      // Never reset this timer. A sustained event stream must not starve the
      // bounded run the way a conventional debounce would.
      if (timerToken === null) timerToken = runtime.setTimer(invoke, remaining);
    };
    schedule.cancel = () => {
      if (timerToken !== null) runtime.clearTimer(timerToken);
      timerToken = null;
      persist = false;
      lastRunAt = -Infinity;
    };
    schedule.pending = () => ({ timer: timerToken !== null, persist, lastRunAt });
    return schedule;
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

  const MEDIA_KINDS = new Set(["image", "video", "audio", "file", "link"]);
  const MEDIA_SOURCES = new Set(["attachment", "embed", "link"]);

  function privateNetworkHost(value) {
    const host = String(value || "").toLocaleLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
    if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
    // Literal IPv6 hosts are unnecessary for captured provider/CDN media and
    // include many alternate private/loopback encodings; reject them all.
    if (host.includes(":")) return true;
    const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!match) return false;
    const parts = match.slice(1).map(Number);
    if (parts.some((part) => part > 255)) return true;
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
  }

  function safeMediaUrl(value) {
    try {
      const raw = String(value || "").trim();
      if (!raw || raw.length > 4096 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(raw)) return null;
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.username || url.password || url.port || privateNetworkHost(url.hostname)) return null;
      url.hash = "";
      return url.href;
    } catch (_error) {
      return null;
    }
  }

  function mediaIdentity(value) {
    const safe = safeMediaUrl(value);
    if (!safe) return null;
    const url = new URL(safe);
    const attachment = url.pathname.match(/^\/(?:ephemeral-)?attachments\/(\d{15,25})\/(\d{15,25})\//);
    if (attachment && ["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)) {
      return `discord-attachment:${attachment[1]}:${attachment[2]}`;
    }
    if (["images-ext-1.discordapp.net", "images-ext-2.discordapp.net"].includes(url.hostname)) {
      return `${url.hostname}:${url.pathname}`;
    }
    return safe;
  }

  function exportMediaUrl(value) {
    const safe = safeMediaUrl(value);
    if (!safe) return null;
    const url = new URL(safe);
    if (["cdn.discordapp.com", "media.discordapp.net", "images-ext-1.discordapp.net", "images-ext-2.discordapp.net"].includes(url.hostname)) {
      url.search = "";
    }
    return url.href;
  }

  function mediaKindFromUrl(value) {
    const url = safeMediaUrl(value);
    if (!url) return "link";
    let pathname = "";
    try { pathname = decodeURIComponent(new URL(url).pathname).toLocaleLowerCase(); } catch (_error) { pathname = new URL(url).pathname.toLocaleLowerCase(); }
    if (/\.(?:apng|avif|bmp|gif|jpe?g|png|svg|webp)(?:$|[/.])/.test(pathname)) return "image";
    if (/\.(?:m4v|mkv|mov|mp4|ogv|webm)(?:$|[/.])/.test(pathname)) return "video";
    if (/\.(?:aac|flac|m4a|mp3|oga|ogg|opus|wav)(?:$|[/.])/.test(pathname)) return "audio";
    return "link";
  }

  function mediaKindFromMime(value, fallback) {
    const mime = String(value || "").split(";", 1)[0].trim().toLocaleLowerCase();
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    return MEDIA_KINDS.has(fallback) ? fallback : "file";
  }

  function safeMediaName(value) {
    return normalizeText(String(value || "").replace(/[\\/\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ")).slice(0, 240);
  }

  function sanitizeMediaItems(value) {
    const items = [];
    const seen = new Set();
    for (const raw of (Array.isArray(value) ? value : []).slice(0, 32)) {
      if (!raw || typeof raw !== "object") continue;
      const url = safeMediaUrl(raw.url);
      const identity = mediaIdentity(url);
      if (!url || !identity || seen.has(identity)) continue;
      const inferred = mediaKindFromUrl(url);
      const kind = MEDIA_KINDS.has(raw.kind) ? raw.kind : inferred;
      const source = MEDIA_SOURCES.has(raw.source) ? raw.source : "link";
      const item = {
        url,
        kind,
        source,
        name: safeMediaName(raw.name) || safeMediaName(new URL(url).pathname.split("/").pop()) || kind,
        alt: normalizeText(raw.alt).slice(0, 500),
        mimeType: String(raw.mimeType || "").split(";", 1)[0].trim().toLocaleLowerCase().slice(0, 120),
        width: Math.max(0, Math.min(10000, Math.floor(Number(raw.width) || 0))),
        height: Math.max(0, Math.min(10000, Math.floor(Number(raw.height) || 0))),
        posterUrl: safeMediaUrl(raw.posterUrl),
        cacheable: raw.cacheable !== false && kind !== "link",
        spoiler: Boolean(raw.spoiler)
      };
      if (!item.alt) delete item.alt;
      if (!item.mimeType) delete item.mimeType;
      if (!item.width) delete item.width;
      if (!item.height) delete item.height;
      if (!item.posterUrl) delete item.posterUrl;
      items.push(item);
      seen.add(identity);
      if (items.length >= 16) break;
    }
    return items;
  }

  function editPayloadSignature(record) {
    // Message edits are content-exact. Preserve meaningful whitespace so an
    // edit that only adds a line break or repeated spaces is still retained.
    // Normalize only platform line endings to keep signatures portable.
    const content = String(record?.content ?? "").replace(/\r\n?/g, "\n");
    // URL identity is the edit-semantic part of a media item. Dimensions,
    // MIME, alt/name presentation, poster discovery, and inferred kind/source
    // can all hydrate after Discord first renders the same unchanged asset.
    const media = sanitizeMediaItems(record?.media).map((item) => mediaIdentity(item.url)).filter(Boolean).sort();
    return JSON.stringify([
      content,
      (Array.isArray(record?.attachments) ? record.attachments : []).map(safeMediaName).filter(Boolean).sort(),
      media
    ]);
  }

  function editRevisionFromRecord(record, metadata) {
    const settings = metadata || {};
    const capturedAt = Number(record?.capturedAt);
    const supersededAt = Number(settings.supersededAt);
    return {
      revisionId: normalizeText(settings.revisionId).slice(0, 160),
      content: String(record?.content || "").slice(0, 20000),
      attachments: (Array.isArray(record?.attachments) ? record.attachments : [])
        .map(safeMediaName).filter(Boolean).slice(0, 12),
      media: sanitizeMediaItems(record?.media),
      capturedAt: Number.isFinite(capturedAt) && capturedAt > 0 ? capturedAt : 0,
      supersededAt: Number.isFinite(supersededAt) && supersededAt > 0 ? supersededAt : 0
    };
  }

  function sanitizeEditHistory(value, options) {
    const limits = Object.assign({}, DEFAULTS, options || {});
    const raw = Array.isArray(value) ? value : [];
    const revisions = [];
    const seenIds = new Set();
    let previousSignature = null;
    for (const item of raw.slice(0, 200)) {
      if (!item || typeof item !== "object") continue;
      const revision = editRevisionFromRecord(item, {
        revisionId: item.revisionId,
        supersededAt: item.supersededAt
      });
      const signature = editPayloadSignature(revision);
      if (!revision.revisionId) revision.revisionId = `legacy:${revision.supersededAt}:${revisions.length}`;
      if (seenIds.has(revision.revisionId) || signature === previousSignature) continue;
      revisions.push(revision);
      seenIds.add(revision.revisionId);
      previousSignature = signature;
    }
    const maxRevisions = Math.max(1, Math.floor(Number(limits.maxEditRevisions) || 1));
    let selected = revisions.length <= maxRevisions
      ? revisions
      : maxRevisions === 1 ? [revisions[0]] : [revisions[0], ...revisions.slice(-(maxRevisions - 1))];
    const maxBytes = Math.max(1024, Number(limits.maxEditBytes) || 1024);
    while (selected.length > 1 && estimateBytes(selected) > maxBytes) {
      selected.splice(1, 1);
    }
    if (selected.length === 1 && estimateBytes(selected) > maxBytes) {
      selected[0] = Object.assign({}, selected[0], {
        content: selected[0].content.slice(0, Math.max(0, Math.floor(maxBytes / 4))),
        media: selected[0].media.slice(0, 4),
        attachments: selected[0].attachments.slice(0, 4)
      });
    }
    return selected;
  }

  function hasEdits(record) {
    return Array.isArray(record?.editHistory) && record.editHistory.length > 0;
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
    const authorId = snowflakeValue(record.authorId);
    if (authorId) next.authorId = authorId;
    else delete next.authorId;
    const authorUsername = discordUsernameValue(record.authorUsername);
    if (authorUsername) next.authorUsername = authorUsername;
    else delete next.authorUsername;
    next.sourceContinuation = Boolean(record.sourceContinuation);
    const groupRootMessageId = snowflakeValue(record.groupRootMessageId);
    if (groupRootMessageId) next.groupRootMessageId = groupRootMessageId;
    else delete next.groupRootMessageId;
    next.media = sanitizeMediaItems(record.media);
    next.editHistory = sanitizeEditHistory(record.editHistory);
    if (!next.editHistory.length) delete next.editHistory;
    const editSessionId = normalizeText(record.editSessionId).slice(0, 100);
    const lastEditSequence = Math.max(0, Math.floor(Number(record.lastEditSequence) || 0));
    if (editSessionId && lastEditSequence) {
      next.editSessionId = editSessionId;
      next.lastEditSequence = lastEditSequence;
    } else {
      delete next.editSessionId;
      delete next.lastEditSequence;
    }
    const captureSessionId = normalizeText(record.captureSessionId).slice(0, 100);
    const captureSequence = Math.max(0, Math.floor(Number(record.captureSequence) || 0));
    if (captureSessionId && captureSequence) {
      next.captureSessionId = captureSessionId;
      next.captureSequence = captureSequence;
    } else {
      delete next.captureSessionId;
      delete next.captureSequence;
    }
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
    const edited = [...byKey.values()].filter((record) => !isDeletedStatus(record.status) && hasEdits(record)).sort(newestFirst);
    const seen = [...byKey.values()].filter((record) => !isDeletedStatus(record.status) && !hasEdits(record)).sort(newestFirst);
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
    for (const record of [...deleted, ...edited].sort(newestFirst)) add(record);
    for (const record of seen) add(record);
    return selected.sort((a, b) => {
      const statusOrder = Number(isDeletedStatus(b.status)) - Number(isDeletedStatus(a.status));
      const editOrder = Number(hasEdits(b)) - Number(hasEdits(a));
      return statusOrder || editOrder || newestFirst(a, b);
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
      if (old.captureSessionId && safeRecord.captureSessionId === old.captureSessionId &&
        safeRecord.captureSequence && old.captureSequence && safeRecord.captureSequence < old.captureSequence &&
        !isDeletedStatus(safeRecord.status)) continue;
      const merged = Object.assign({}, old, safeRecord, {
        firstCapturedAt: old.firstCapturedAt || record.firstCapturedAt || record.capturedAt || now,
        updatedAt: now
      });
      const oldAuthorId = snowflakeValue(old.authorId);
      const incomingAuthorId = snowflakeValue(safeRecord.authorId);
      const incomingAuthorUsername = discordUsernameValue(safeRecord.authorUsername);
      // A canonical username is meaningful only while it remains bound to the
      // exact verified Discord account. Never carry one across an author-ID
      // correction merely because Object.assign retained the older field.
      if (incomingAuthorId && oldAuthorId !== incomingAuthorId && !incomingAuthorUsername) {
        delete merged.authorUsername;
      }
      if (isDeletedStatus(old.status) && !isDeletedStatus(record.status)) {
        merged.status = old.status;
        merged.inferredDeletedAt = old.inferredDeletedAt;
        merged.confirmedDeletedAt = old.confirmedDeletedAt;
        merged.deletionSource = old.deletionSource;
        if (old.status === "confirmed_deleted") {
          merged.content = old.content;
          merged.attachments = old.attachments;
          merged.media = old.media;
          merged.capturedAt = old.capturedAt;
          merged.captureSessionId = old.captureSessionId;
          merged.captureSequence = old.captureSequence;
        }
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
          record.authorUsername,
          record.content,
          record.channelName,
          record.channelId,
          record.guildId,
          ...(Array.isArray(record.attachments) ? record.attachments : []),
          ...(Array.isArray(record.media) ? record.media.flatMap((item) => [item.name, item.url, item.alt]) : []),
          ...(Array.isArray(record.editHistory) ? record.editHistory.flatMap((revision) => [
            revision.content,
            ...(Array.isArray(revision.attachments) ? revision.attachments : []),
            ...(Array.isArray(revision.media) ? revision.media.flatMap((item) => [item.name, item.url, item.alt]) : [])
          ]) : [])
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
    messageRowOwnsElement,
    compareSnowflakeIds,
    chronologicalNeighborIds, tombstoneInRenderedRange, anchorlessRestoreAllowed,
    messageUsernameLabelId,
    snowflakeValue,
    discordUsernameValue,
    boundAuthorIdentity,
    avatarAuthorId,
    snowflakeTimestamp,
    sameContinuationAuthor,
    messageContinues,
    isAtScrollBottom,
    createTrailingFrameScheduler,
    createRateLimitedScheduler,
    chooseActiveList,
    tombstoneCleanupKeys,
    estimateBytes,
    safePresentationCss,
    safePresentationColor,
    safePresentationGradient,
    safeDiscordAssetUrl,
    privateNetworkHost,
    safeMediaUrl,
    mediaIdentity,
    exportMediaUrl,
    mediaKindFromUrl,
    mediaKindFromMime,
    safeMediaName,
    sanitizeMediaItems,
    editPayloadSignature,
    editRevisionFromRecord,
    sanitizeEditHistory,
    hasEdits,
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
