(function installLocalDiscordLifecycleHook() {
  "use strict";

  const HOOK_API_VERSION = 7;
  const INSTALL_KEY = Symbol.for("BridgeModTools.pageHook.v1");
  const existingController = window[INSTALL_KEY];
  if (existingController && typeof existingController.recover === "function") {
    // MAIN-world controllers cannot be replaced safely in place. Never reload
    // from the page hook: unpacked-extension updates can briefly overlap two
    // script generations and turn a self-reload into a loop. The background's
    // onInstalled path owns the single bounded document reload instead.
    if (existingController.apiVersion !== HOOK_API_VERSION) {
      try { existingController.upgradeRequired = HOOK_API_VERSION; } catch (_error) {}
      return;
    }
    existingController.recover("duplicate-injection");
    return;
  }
  const controller = {
    apiVersion: HOOK_API_VERSION,
    pendingRecovery: false,
    recover() { this.pendingRecovery = true; }
  };
  try {
    Object.defineProperty(window, INSTALL_KEY, { configurable: false, enumerable: false, value: controller });
  } catch (_error) {
    try { window[INSTALL_KEY] = controller; } catch (_ignored) {}
  }

  const BRIDGE = "LDMA_BRIDGE_V1";
  const EDIT_EVENT = "LDMA_EDIT_BEFORE_V1";
  const SNOWFLAKE = /^\d{15,25}$/;
  const MAX_BULK_IDS = 200;
  const MAX_RETAINED_KEYS = 5000;
  const MAX_PENDING_DELETIONS = 5000;
  const MAX_MENTION_TOKENS = 50;
  const TIMEOUT_7D_SECONDS = 7 * 24 * 60 * 60;
  const webpackInstances = new Set();
  const scannedModules = new WeakMap();
  const profilePopoutFactoryMatches = new WeakMap();
  const dispatchers = new Set();
  const fallbackDispatchers = new Set();
  const CORE_STORES = new Set(["MessageStore", "ChannelStore", "GuildStore", "GuildMemberStore", "ReadStateStore", "UserStore"]);
  const bufferedEvents = [];
  const patchedHandlerNodes = new WeakMap();
  const patchedRetentionDispatchers = new WeakMap();
  const releaseKeys = new Set();
  const retainedKeys = new Set();
  // A retained native row is not a durable archive record. Keep only its IDs
  // until the isolated script acknowledges persistence, including off-route
  // events that cannot be captured until their channel is visited again.
  const pendingRetainedDeletes = new Map();
  const activeSelfEdits = new Map();
  const recentSelfEdits = new Map();
  let isolatedReady = false;
  let coreDispatcher = null;
  let fallbackDispatcher = null;
  let messageStoreCandidate = null;
  let userStoreCandidate = null;
  let guildMemberStoreCandidate = null;
  let guildMemberStoreSource = null;
  const structuralUserStoreCandidates = new Set();
  let reactCandidate = null;
  let reactDomClientCandidate = null;
  let userProfilePopoutCandidate = null;
  let timeoutUntilActionsCandidate = null;
  let mountedUserProfilePopout = null;
  let messageStorePatched = false;
  let deletionLedgerOverflowed = false;
  let deletionResetReleaseFailed = false;
  let lastDeletionReset = null;
  let lastStatus = "";
  let captureSequence = 0;
  let editSequence = 0;
  let observedChunkArray = null;
  let lastForcedScanAt = -Infinity;
  let forcedScanAttempts = 0;
  const editSessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

  function bridgeMessage(kind, payload) {
    window.postMessage(Object.assign({ bridge: BRIDGE, kind }, payload || {}), "*");
  }

  function report(status, detail, force) {
    if (status === "active" && deletionResetReleaseFailed) {
      status = "degraded";
      detail = "Some unarchived retained messages could not be released during archive reset; reload Discord to discard their native cache.";
    } else if (status === "active" && deletionLedgerOverflowed) {
      status = "degraded";
      detail = "The 5,000-message deletion retry limit was reached; additional native deletions were not retained.";
    }
    const signature = `${status}:${detail}`;
    if (!force && signature === lastStatus) return;
    lastStatus = signature;
    bridgeMessage("status", { status, detail });
  }

  function cleanId(value) {
    const id = String(value || "");
    return SNOWFLAKE.test(id) ? id : null;
  }

  function cleanUsername(value) {
    if (typeof value !== "string") return null;
    const username = value.trim();
    return /^[a-z0-9._]{1,32}$/i.test(username) ? username : null;
  }

  function messageMentionTokens(message) {
    if (!message || typeof message !== "object" || typeof message.content !== "string") return [];
    const values = (value) => {
      try {
        if (Array.isArray(value)) return value;
        if (value && typeof value.toArray === "function") return value.toArray();
      } catch (_error) {}
      return [];
    };
    const userIds = new Set(values(message.mentions).slice(0, MAX_MENTION_TOKENS * 2)
      .map((item) => cleanId(item?.id || item?.user?.id || item)).filter(Boolean));
    const roleIds = new Set(values(message.mentionRoles || message.mention_roles).slice(0, MAX_MENTION_TOKENS * 2)
      .map((item) => cleanId(item?.id || item)).filter(Boolean));
    const mentionsEveryone = message.mentionEveryone === true || message.mention_everyone === true;
    const tokens = [];
    const pattern = /<@([!&]?)(\d{15,25})>|@(everyone|here)/g;
    for (const match of message.content.matchAll(pattern)) {
      if (tokens.length >= MAX_MENTION_TOKENS) break;
      if (match[3]) {
        if (mentionsEveryone) tokens.push({ kind: "broadcast" });
        continue;
      }
      const id = cleanId(match[2]);
      if (!id) continue;
      if (match[1] === "&") {
        if (roleIds.has(id)) tokens.push({ kind: "role" });
      } else if (userIds.has(id)) tokens.push({ kind: "user", userId: id });
    }
    return tokens;
  }

  function retainedMentionPayload(channelId, ids) {
    const mentions = [];
    for (const id of ids) {
      const entry = pendingRetainedDeletes.get(`${channelId}:${id}`);
      if (entry?.mentionTokens?.length) mentions.push({ messageId: id, tokens: entry.mentionTokens });
    }
    return mentions;
  }

  function emitDelete(channelValue, idValues, bulk) {
    const channelId = cleanId(channelValue);
    const ids = [...new Set((Array.isArray(idValues) ? idValues : [idValues]).map(cleanId).filter(Boolean))]
      .slice(0, MAX_BULK_IDS);
    if (!channelId || !ids.length) return;
    const message = { bridge: BRIDGE, kind: "delete", channelId, ids, bulk: Boolean(bulk) };
    if (!isolatedReady) {
      bufferedEvents.push(message);
      if (bufferedEvents.length > 100) bufferedEvents.shift();
      return;
    }
    window.postMessage(message, "*");
  }

  function emitRetained(channelValue, idValues, bulk) {
    const channelId = cleanId(channelValue);
    const ids = [...new Set((Array.isArray(idValues) ? idValues : [idValues]).map(cleanId).filter(Boolean))]
      .slice(0, MAX_BULK_IDS);
    if (!channelId || !ids.length) return;
    const admittedIds = [];
    for (const id of ids) {
      const key = `${channelId}:${id}`;
      if (!pendingRetainedDeletes.has(key) && pendingRetainedDeletes.size >= MAX_PENDING_DELETIONS) {
        deletionLedgerOverflowed = true;
        continue;
      }
      const existing = pendingRetainedDeletes.get(key);
      pendingRetainedDeletes.set(key, {
        channelId, id, bulk: Boolean(bulk), mentionTokens: existing?.mentionTokens || []
      });
      admittedIds.push(id);
    }
    if (deletionLedgerOverflowed) report("active", "");
    if (isolatedReady && admittedIds.length) {
      const payload = { channelId, ids: admittedIds, bulk: Boolean(bulk) };
      const mentions = retainedMentionPayload(channelId, admittedIds);
      if (mentions.length) payload.mentions = mentions;
      bridgeMessage("retained", payload);
    }
  }

  function replayRetainedDeletes(channelValue) {
    if (!isolatedReady) return;
    const channelId = channelValue == null ? null : cleanId(channelValue);
    if (channelValue != null && !channelId) return;
    const groups = new Map();
    for (const entry of pendingRetainedDeletes.values()) {
      if (channelId && entry.channelId !== channelId) continue;
      const key = `${entry.channelId}:${entry.bulk}`;
      if (!groups.has(key)) groups.set(key, { channelId: entry.channelId, bulk: entry.bulk, ids: [] });
      groups.get(key).ids.push(entry.id);
    }
    for (const group of groups.values()) {
      for (let offset = 0; offset < group.ids.length; offset += MAX_BULK_IDS) {
        const ids = group.ids.slice(offset, offset + MAX_BULK_IDS);
        const payload = {
          channelId: group.channelId,
          ids,
          bulk: group.bulk
        };
        const mentions = retainedMentionPayload(group.channelId, ids);
        if (mentions.length) payload.mentions = mentions;
        bridgeMessage("retained", payload);
      }
    }
  }

  function forgetPendingRetainedDeletes(channelValue, idValues) {
    const channelId = cleanId(channelValue);
    if (!channelId || !Array.isArray(idValues)) return;
    for (const id of idValues.slice(0, MAX_BULK_IDS).map(cleanId).filter(Boolean)) {
      pendingRetainedDeletes.delete(`${channelId}:${id}`);
    }
  }

  function editTimestamp(value) {
    const raw = value && (value.editedTimestamp || value.edited_timestamp);
    if (!raw) return 0;
    if (raw instanceof Date) return raw.valueOf();
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(String(raw));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  function editLifecycle(store, action) {
    const incoming = action && (action.message || action);
    const channelId = cleanId(incoming && (incoming.channelId || incoming.channel_id) || action && (action.channelId || action.channel_id));
    const id = cleanId(incoming && incoming.id || action && action.id);
    const editedAt = editTimestamp(incoming);
    if (!channelId || !id || !editedAt || typeof store?.getMessage !== "function") return null;
    const key = `${channelId}:${id}`;
    const now = Date.now();
    for (const [activeChannelId, active] of activeSelfEdits) {
      if (active.expiresAt <= now) activeSelfEdits.delete(activeChannelId);
    }
    for (const [recentKey, recent] of recentSelfEdits) {
      if (recent.expiresAt <= now) recentSelfEdits.delete(recentKey);
    }
    // A local edit starts before Discord swaps the rendered content. Its
    // separately staged baseline owns the corresponding server update.
    if (activeSelfEdits.get(channelId)?.id === id) return null;
    const recent = recentSelfEdits.get(key);
    if (recent && editedAt <= recent.editedAt + 15000) return null;
    let previous = null;
    try { previous = store.getMessage(channelId, id); } catch (_error) {}
    // MESSAGE_UPDATE is also used to hydrate messages that were not previously
    // present in this MessageStore. Without a real cached predecessor there is
    // no original version to preserve and treating hydration as an edit would
    // fabricate history.
    if (!previous) return null;
    const previousEditedAt = editTimestamp(previous);
    if (editedAt <= previousEditedAt) return null;
    return { channelId, id, editedAt };
  }

  function emitEditSignal(kind, item) {
    if (!item) return;
    const detail = {
      bridge: BRIDGE,
      kind,
      channelId: item.channelId,
      ids: [item.id],
      editSessionId,
      editSequence: item.editSequence || (editSequence += 1)
    };
    if (kind === "edit-before") detail.editedAt = item.editedAt;
    if (!isolatedReady) {
      bufferedEvents.push(detail);
      if (bufferedEvents.length > 100) bufferedEvents.shift();
      return;
    }
    try {
      window.dispatchEvent(new CustomEvent(EDIT_EVENT, { detail: JSON.stringify(detail) }));
    } catch (_error) {
      bridgeMessage(kind, detail);
    }
  }

  function emitEditBefore(item) {
    emitEditSignal("edit-before", item);
  }

  function onEditStart(action) {
    const channelId = cleanId(action && (action.channelId || action.channel_id));
    const id = cleanId(action && (action.messageId || action.message_id));
    if (!channelId || !id) return;
    const previous = activeSelfEdits.get(channelId);
    if (previous) emitEditSignal("edit-cancel", previous);
    const active = {
      channelId,
      id,
      editSequence: editSequence += 1,
      expiresAt: Date.now() + 5 * 60 * 1000
    };
    activeSelfEdits.set(channelId, active);
    while (activeSelfEdits.size > 100) activeSelfEdits.delete(activeSelfEdits.keys().next().value);
    recentSelfEdits.delete(`${channelId}:${id}`);
    emitEditSignal("edit-stage", active);
  }

  function onEditEnd(action) {
    const channelId = cleanId(action && (action.channelId || action.channel_id));
    const active = channelId && activeSelfEdits.get(channelId);
    if (!active) return;
    activeSelfEdits.delete(channelId);
    const response = action && action.response;
    if (!response) {
      emitEditSignal("edit-cancel", active);
      return;
    }
    const responseBody = response && (response.body?.message || response.body || response.message || response);
    const editedAt = editTimestamp(responseBody) || Date.now();
    recentSelfEdits.set(`${active.channelId}:${active.id}`, {
      editedAt,
      expiresAt: Date.now() + 15000
    });
    while (recentSelfEdits.size > 500) recentSelfEdits.delete(recentSelfEdits.keys().next().value);
    emitEditBefore(Object.assign({}, active, { editedAt }));
  }

  function onDelete(action) {
    const releaseKey = `${cleanId(action && (action.channelId || action.channel_id))}:${cleanId(action && action.id)}`;
    if (releaseKeys.has(releaseKey)) return;
    emitDelete(action && (action.channelId || action.channel_id), action && action.id, false);
  }

  function onBulkDelete(action) {
    emitDelete(action && (action.channelId || action.channel_id), action && action.ids, true);
  }

  function onGuildMemberUpdate(action) {
    let guildId = null;
    let userId = null;
    try {
      guildId = cleanId(action && (action.guildId || action.guild_id));
      const member = action && (action.member || action);
      userId = cleanId(member && (member.userId || member.user_id || member.user?.id));
    } catch (_error) {}
    if (guildId && userId) bridgeMessage("timeout-state-dirty", { guildId, userId });
  }

  function dataFunction(value, property) {
    let current = value;
    for (let depth = 0; current && depth < 4; depth += 1) {
      let descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(current, property); } catch (_error) { return null; }
      if (descriptor) return "value" in descriptor && typeof descriptor.value === "function" ? descriptor.value : null;
      try { current = Object.getPrototypeOf(current); } catch (_error) { return null; }
    }
    return null;
  }

  function moduleExportFunction(value, property) {
    let current = value;
    for (let depth = 0; current && depth < 4; depth += 1) {
      let descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(current, property); } catch (_error) { return null; }
      if (descriptor) {
        if ("value" in descriptor) return typeof descriptor.value === "function" ? descriptor.value : null;
        // Webpack harmony exports are enumerable getters. Read only the exact
        // allowlisted action names, and contain getters that throw or change.
        if (!descriptor.enumerable || typeof descriptor.get !== "function") return null;
        try {
          const exported = value[property];
          return typeof exported === "function" ? exported : null;
        } catch (_error) {
          return null;
        }
      }
      try { current = Object.getPrototypeOf(current); } catch (_error) { return null; }
    }
    return null;
  }

  function userStoreFunctions(value) {
    const getUser = moduleExportFunction(value, "getUser");
    const getUsers = moduleExportFunction(value, "getUsers");
    const getCurrentUser = moduleExportFunction(value, "getCurrentUser");
    return getUser && (getUsers || getCurrentUser) ? { getUser, getUsers, getCurrentUser } : null;
  }

  function exactUserFromStore(store, userId) {
    if (!store || !userId) return null;
    const functions = userStoreFunctions(store) || {
      getUser: moduleExportFunction(store, "getUser"),
      getUsers: moduleExportFunction(store, "getUsers"),
      getCurrentUser: moduleExportFunction(store, "getCurrentUser")
    };
    let user = null;
    try { user = functions.getUser?.call(store, userId); } catch (_error) {}
    if (cleanId(user?.id) === userId) return user;
    if (functions.getUsers) {
      let users = null;
      try { users = functions.getUsers.call(store); } catch (_error) {}
      try {
        if (users instanceof Map) user = users.get(userId);
        else if (Array.isArray(users)) user = users.find((item) => cleanId(item?.id) === userId);
        else if (users && typeof users === "object") user = users[userId];
      } catch (_error) { user = null; }
      if (cleanId(user?.id) === userId) return user;
    }
    if (functions.getCurrentUser) {
      try { user = functions.getCurrentUser.call(store); } catch (_error) { user = null; }
      if (cleanId(user?.id) === userId) return user;
    }
    return null;
  }

  function messageAuthorIdentity(message) {
    const candidates = [message?.author, message?.user, message?.member?.user];
    let userId = cleanId(message?.authorId || message?.author_id || message?.userId || message?.user_id);
    let username = null;
    for (const candidate of candidates) {
      const candidateId = cleanId(candidate) || cleanId(candidate?.id || candidate?.userId || candidate?.user_id);
      if (!userId && candidateId) userId = candidateId;
      if (candidateId && userId && candidateId !== userId) continue;
      if (candidateId === userId) username = cleanUsername(candidate?.username) || username;
    }
    return { userId, username };
  }

  function cachedUser(userId) {
    const resolve = () => {
      const named = exactUserFromStore(userStoreCandidate, userId);
      if (named && cleanUsername(named.username)) return named;
      let resolved = null;
      let resolvedUsername = null;
      for (const candidate of structuralUserStoreCandidates) {
        const user = exactUserFromStore(candidate, userId);
        const username = cleanUsername(user?.username);
        if (!user || !username) continue;
        if (resolvedUsername && resolvedUsername !== username) return null;
        resolved = user;
        resolvedUsername = username;
      }
      return resolved;
    };
    return resolve();
  }

  function isDispatcher(value) {
    return Boolean(value && (typeof value === "object" || typeof value === "function") &&
      dataFunction(value, "dispatch") && dataFunction(value, "subscribe") && dataFunction(value, "unsubscribe"));
  }

  function unsubscribeDispatcher(dispatcher) {
    if (!dispatcher) return;
    disableDispatcherRetention(dispatcher);
    try { dispatcher.unsubscribe("MESSAGE_DELETE", onDelete); } catch (_error) {}
    try { dispatcher.unsubscribe("MESSAGE_DELETE_BULK", onBulkDelete); } catch (_error) {}
    try { dispatcher.unsubscribe("MESSAGE_START_EDIT", onEditStart); } catch (_error) {}
    try { dispatcher.unsubscribe("MESSAGE_END_EDIT", onEditEnd); } catch (_error) {}
    try { dispatcher.unsubscribe("GUILD_MEMBER_UPDATE", onGuildMemberUpdate); } catch (_error) {}
    dispatchers.delete(dispatcher);
    if (coreDispatcher === dispatcher) coreDispatcher = null;
    if (fallbackDispatcher === dispatcher) fallbackDispatcher = null;
  }

  function subscribeDispatcher(dispatcher, preferred, authoritative) {
    if (!isDispatcher(dispatcher)) return false;
    if (preferred && coreDispatcher === dispatcher && dispatchers.has(dispatcher)) return true;
    if (preferred) {
      if (coreDispatcher && coreDispatcher !== dispatcher && !authoritative) return false;
    } else {
      if (coreDispatcher || (fallbackDispatcher && fallbackDispatcher !== dispatcher)) return false;
    }
    if (!dispatchers.has(dispatcher)) {
      try {
        dispatcher.subscribe("MESSAGE_DELETE", onDelete);
        dispatcher.subscribe("MESSAGE_DELETE_BULK", onBulkDelete);
        dispatcher.subscribe("MESSAGE_START_EDIT", onEditStart);
        dispatcher.subscribe("MESSAGE_END_EDIT", onEditEnd);
        dispatcher.subscribe("GUILD_MEMBER_UPDATE", onGuildMemberUpdate);
      } catch (_error) {
        try { dispatcher.unsubscribe("MESSAGE_DELETE", onDelete); } catch (_ignored) {}
        try { dispatcher.unsubscribe("MESSAGE_DELETE_BULK", onBulkDelete); } catch (_ignored) {}
        try { dispatcher.unsubscribe("MESSAGE_START_EDIT", onEditStart); } catch (_ignored) {}
        try { dispatcher.unsubscribe("MESSAGE_END_EDIT", onEditEnd); } catch (_ignored) {}
        try { dispatcher.unsubscribe("GUILD_MEMBER_UPDATE", onGuildMemberUpdate); } catch (_ignored) {}
        return false;
      }
      dispatchers.add(dispatcher);
    }
    if (preferred) {
      const previousCore = coreDispatcher;
      const previousFallback = fallbackDispatcher;
      coreDispatcher = dispatcher;
      if (fallbackDispatcher === dispatcher) fallbackDispatcher = null;
      // The replacement is subscribed before the previous path is detached, so
      // a rejected Discord dispatcher can never tear down a working hook.
      if (previousCore && previousCore !== dispatcher) unsubscribeDispatcher(previousCore);
      if (previousFallback && previousFallback !== dispatcher && previousFallback !== previousCore) {
        unsubscribeDispatcher(previousFallback);
      }
    } else fallbackDispatcher = dispatcher;
    report(messageStorePatched ? "active" : "searching", messageStorePatched
      ? "Discord MessageStore edit history and deletion retention are active."
      : preferred ? "Discord core dispatcher connected; waiting for MessageStore retention."
      : "A deletion dispatcher candidate is connected; waiting for Discord's core store dispatcher.");
    return true;
  }

  function coreStoreInfo(value) {
    if (!value || (typeof value !== "object" && typeof value !== "function")) return null;
    let dispatcher;
    try { dispatcher = value._dispatcher; } catch (_error) { return null; }
    if (!isDispatcher(dispatcher)) return null;
    const getName = dataFunction(value, "getName");
    if (!getName) return null;
    let name;
    try { name = getName.call(value); } catch (_error) { return null; }
    return CORE_STORES.has(name) ? { name, dispatcher } : null;
  }

  function messageStoreHandlerNode(store, dispatcher) {
    let nodes;
    try { nodes = dispatcher._actionHandlers?._dependencyGraph?.nodes; } catch (_error) { return null; }
    if (!nodes || typeof nodes !== "object") return null;
    const getToken = dataFunction(store, "getDispatchToken");
    if (getToken) {
      try {
        const token = getToken.call(store);
        if (token != null && nodes[token]?.actionHandler) return nodes[token];
      } catch (_error) {}
    }
    const candidates = Object.values(nodes).filter((node) => {
      const handlers = node && node.actionHandler;
      if (!handlers || typeof handlers !== "object") return false;
      const named = node.name === "MessageStore" || node.store === store || node._store === store;
      return named && (typeof handlers.MESSAGE_DELETE === "function" || typeof handlers.MESSAGE_DELETE_BULK === "function" ||
        typeof handlers.MESSAGE_UPDATE === "function");
    });
    if (candidates.length === 1) return candidates[0];
    const deleteCandidates = Object.values(nodes).filter((node) => {
      const handlers = node && node.actionHandler;
      return handlers && ((typeof handlers.MESSAGE_DELETE === "function" && typeof handlers.MESSAGE_DELETE_BULK === "function") ||
        typeof handlers.MESSAGE_UPDATE === "function");
    });
    return deleteCandidates.length === 1 ? deleteCandidates[0] : null;
  }

  function markedDeletedMessage(message) {
    if (!message) return null;
    try {
      return typeof message.set === "function" ? message.set("deleted", true) : Object.assign({}, message, { deleted: true });
    } catch (_error) {
      return null;
    }
  }

  function retainCachedMessages(store, action, isBulk, captured) {
    const channelId = cleanId(action && (action.channelId || action.channel_id));
    const result = { retainedIds: [], failedIds: captured.map((entry) => entry.id) };
    if (!channelId || !captured.length) return result;
    let channelMessages;
    try { channelMessages = store.getMessages(channelId); } catch (_error) { return result; }
    if (!channelMessages || typeof channelMessages.receiveMessage !== "function") return result;
    for (const entry of captured) {
      const key = `${channelId}:${entry.id}`;
      // Never keep a native row whose unresolved ID cannot remain replayable and
      // reset-releasable. The caller forwards rejected IDs to native deletion.
      if (!pendingRetainedDeletes.has(key) && pendingRetainedDeletes.size >= MAX_PENDING_DELETIONS) {
        deletionLedgerOverflowed = true;
        continue;
      }
      const message = markedDeletedMessage(entry.message);
      if (!message) continue;
      try {
        channelMessages.receiveMessage(message);
        if (store.getMessage(channelId, entry.id)?.deleted !== true) continue;
        // Register each success immediately so the next item in this same bulk
        // batch observes the remaining capacity, before emitRetained runs.
        pendingRetainedDeletes.set(key, {
          channelId, id: entry.id, bulk: Boolean(isBulk), mentionTokens: entry.mentionTokens
        });
        result.retainedIds.push(entry.id);
        retainedKeys.add(key);
        while (retainedKeys.size > MAX_RETAINED_KEYS) {
          retainedKeys.delete(retainedKeys.values().next().value);
        }
      } catch (_error) {}
    }
    const retainedIds = new Set(result.retainedIds);
    result.failedIds = result.failedIds.filter((id) => !retainedIds.has(id));
    if (result.retainedIds.length) emitRetained(channelId, result.retainedIds, isBulk);
    else if (deletionLedgerOverflowed) report("active", "");
    return result;
  }

  function captureCachedMessages(store, action, isBulk) {
    const channelId = cleanId(action && (action.channelId || action.channel_id));
    const rawIds = isBulk ? (Array.isArray(action?.ids) ? action.ids : []) : [action?.id];
    const ids = rawIds.map(cleanId).filter(Boolean).slice(0, MAX_BULK_IDS);
    const captured = [];
    if (channelId && typeof store.getMessage === "function") {
      for (const id of ids) {
        try {
          const message = store.getMessage(channelId, id);
          if (message) captured.push({ id, message, mentionTokens: messageMentionTokens(message) });
        } catch (_error) {}
      }
    }
    return { channelId, captured };
  }

  function patchDispatcherRetention(store, dispatcher, options) {
    const installed = patchedRetentionDispatchers.get(dispatcher);
    if (installed && dataFunction(dispatcher, "dispatch") === installed.handler) {
      const settings = options || {};
      installed.captureEdits = settings.edits !== false;
      installed.deleteTypes = settings.deleteTypes instanceof Set
        ? new Set(settings.deleteTypes)
        : new Set(["MESSAGE_DELETE", "MESSAGE_DELETE_BULK"]);
      messageStorePatched = true;
      return true;
    }
    if (installed) patchedRetentionDispatchers.delete(dispatcher);
    const settings = options || {};
    const record = {
      captureEdits: settings.edits !== false,
      deleteTypes: settings.deleteTypes instanceof Set
        ? new Set(settings.deleteTypes)
        : new Set(["MESSAGE_DELETE", "MESSAGE_DELETE_BULK"]),
      original: null,
      handler: null
    };
    const original = dataFunction(dispatcher, "dispatch");
    if (!original) return false;
    record.original = original;
    try {
      const retainingDispatch = function localArchiveRetainingDispatch(action) {
        const type = action && action.type;
        if (record.captureEdits && type === "MESSAGE_UPDATE") emitEditBefore(editLifecycle(store, action));
        const isBulk = type === "MESSAGE_DELETE_BULK";
        const key = `${cleanId(action && (action.channelId || action.channel_id))}:${cleanId(action && action.id)}`;
        const shouldRetain = record.deleteTypes.has(type) && !releaseKeys.has(key);
        const captured = shouldRetain ? captureCachedMessages(store, action, isBulk).captured : [];
        const result = original.apply(this, arguments);
        if (captured.length) retainCachedMessages(store, action, isBulk, captured);
        return result;
      };
      record.handler = retainingDispatch;
      dispatcher.dispatch = retainingDispatch;
      if (dataFunction(dispatcher, "dispatch") !== retainingDispatch) return false;
      patchedRetentionDispatchers.set(dispatcher, record);
      messageStorePatched = true;
      report("active", "Discord MessageStore edit history and deletion retention fallback is active.");
      return true;
    } catch (_error) {
      return false;
    }
  }

  function disableDispatcherRetention(dispatcher) {
    const installed = patchedRetentionDispatchers.get(dispatcher);
    if (!installed) return;
    installed.captureEdits = false;
    installed.deleteTypes.clear();
    if (dataFunction(dispatcher, "dispatch") !== installed.handler) {
      patchedRetentionDispatchers.delete(dispatcher);
      return;
    }
    try {
      dispatcher.dispatch = installed.original;
      if (dataFunction(dispatcher, "dispatch") === installed.original) patchedRetentionDispatchers.delete(dispatcher);
    } catch (_error) {}
  }

  function patchMessageStore(store, dispatcher) {
    messageStorePatched = false;
    const node = messageStoreHandlerNode(store, dispatcher);
    if (!node) {
      patchDispatcherRetention(store, dispatcher);
      return;
    }
    const handlers = node.actionHandler;
    const previousInstall = patchedHandlerNodes.get(node);
    const installed = previousInstall?.handlers === handlers ? previousInstall : {};
    let editPatched = Boolean(installed.MESSAGE_UPDATE && handlers.MESSAGE_UPDATE === installed.MESSAGE_UPDATE);
    const deletePatched = new Set();
    const originalUpdate = handlers.MESSAGE_UPDATE;
    let updateHandler = editPatched ? installed.MESSAGE_UPDATE : null;
    if (!editPatched && typeof originalUpdate === "function") {
      const retainingUpdateHandler = function localArchiveEditHandler(action) {
        emitEditBefore(editLifecycle(store, action));
        return originalUpdate.apply(this, arguments);
      };
      try {
        handlers.MESSAGE_UPDATE = retainingUpdateHandler;
        if (handlers.MESSAGE_UPDATE === retainingUpdateHandler) {
          editPatched = true;
          updateHandler = retainingUpdateHandler;
        }
      } catch (_error) {}
    }
    const installedDeletes = {};
    for (const [type, isBulk] of [["MESSAGE_DELETE", false], ["MESSAGE_DELETE_BULK", true]]) {
      if (installed[type] && handlers[type] === installed[type]) {
        deletePatched.add(type);
        installedDeletes[type] = installed[type];
        continue;
      }
      const original = handlers[type];
      if (typeof original !== "function") continue;
      const retainingHandler = function localArchiveRetainingDeleteHandler(action) {
        const key = `${cleanId(action && (action.channelId || action.channel_id))}:${cleanId(action && action.id)}`;
        if (releaseKeys.has(key)) return original.apply(this, arguments);
        const captured = captureCachedMessages(store, action, isBulk).captured;
        if (!captured.length) return original.apply(this, arguments);
        const retained = retainCachedMessages(store, action, isBulk, captured);
        if (!retained.retainedIds.length) return original.apply(this, arguments);
        if (isBulk) {
          const retainedIds = new Set(retained.retainedIds);
          const remainingIds = action.ids.filter((id) => !retainedIds.has(cleanId(id)));
          if (remainingIds.length) {
            const forwarded = Array.from(arguments);
            forwarded[0] = Object.assign({}, action, { ids: remainingIds });
            return original.apply(this, forwarded);
          }
        }
        return undefined;
      };
      try {
        handlers[type] = retainingHandler;
        if (handlers[type] === retainingHandler) {
          deletePatched.add(type);
          installedDeletes[type] = retainingHandler;
        }
      } catch (_error) {}
    }
    const missingDeleteTypes = new Set(["MESSAGE_DELETE", "MESSAGE_DELETE_BULK"]
      .filter((type) => !deletePatched.has(type)));
    const needsFallback = !editPatched || missingDeleteTypes.size > 0;
    const fallbackPatched = needsFallback && patchDispatcherRetention(store, dispatcher, {
      edits: !editPatched,
      deleteTypes: missingDeleteTypes
    });
    if (!needsFallback) disableDispatcherRetention(dispatcher);
    if (needsFallback && !fallbackPatched) {
      patchedHandlerNodes.set(node, Object.assign({ handlers, MESSAGE_UPDATE: updateHandler }, installedDeletes));
      messageStorePatched = false;
      report("degraded", "Discord MessageStore is only partially patchable; edit history or deletion retention may be unavailable.");
      return;
    }
    patchedHandlerNodes.set(node, Object.assign({ handlers, MESSAGE_UPDATE: updateHandler }, installedDeletes));
    messageStorePatched = true;
    report("active", "Discord MessageStore edit history and deletion retention are active.");
  }

  function reconcileMessageStore(reason) {
    if (!messageStoreCandidate) {
      messageStorePatched = false;
      return false;
    }
    const storeInfo = coreStoreInfo(messageStoreCandidate);
    const usable = storeInfo?.name === "MessageStore" &&
      dataFunction(messageStoreCandidate, "getMessage") && dataFunction(messageStoreCandidate, "getMessages");
    if (!usable) {
      messageStorePatched = false;
      report("degraded", `Discord MessageStore identity changed during ${reason || "recovery"}; searching for its replacement.`);
      return false;
    }
    if (storeInfo.dispatcher !== coreDispatcher) messageStorePatched = false;
    if (!subscribeDispatcher(storeInfo.dispatcher, true, true) || coreDispatcher !== storeInfo.dispatcher) {
      messageStorePatched = false;
      report("degraded", `Discord replaced its lifecycle dispatcher during ${reason || "recovery"}; retrying safely.`);
      return false;
    }
    patchMessageStore(messageStoreCandidate, storeInfo.dispatcher);
    return messageStorePatched;
  }

  function shouldIgnoreValue(value) {
    if (!value || value === window) return true;
    try {
      const tag = value[Symbol.toStringTag];
      if (tag === "IntlMessagesProxy" || tag === "DOMTokenList") return true;
      const probe = "__ldma_proxy_probe_7d31__";
      if (value[probe] !== undefined) return true;
    } catch (_error) {
      return true;
    }
    return false;
  }

  function isUserProfilePopoutSource(sourceInfo) {
    const requireFunction = sourceInfo?.requireFunction;
    const moduleId = sourceInfo?.moduleId;
    if (!requireFunction || moduleId == null) return false;
    let matches = profilePopoutFactoryMatches.get(requireFunction);
    if (!matches) {
      matches = new Map();
      profilePopoutFactoryMatches.set(requireFunction, matches);
    }
    if (matches.has(moduleId)) return matches.get(moduleId);
    let source = "";
    try {
      const factory = requireFunction.m?.[moduleId];
      if (typeof factory === "function") source = Function.prototype.toString.call(factory);
    } catch (_error) {}
    const matched = source.includes("withMutualGuilds") && source.includes("disableUserProfileLink") &&
      source.includes("targetElementRef") && source.includes('type:"popout"') && source.includes("messageId");
    matches.set(moduleId, matched);
    return matched;
  }

  function inspectUserActionExports(value, sourceInfo) {
    if (!value || (typeof value !== "object" && typeof value !== "function")) return;
    if (moduleExportFunction(value, "createElement") && moduleExportFunction(value, "memo") &&
        moduleExportFunction(value, "useState") && typeof value.version === "string") {
      reactCandidate = value;
    }
    if (moduleExportFunction(value, "createRoot") && moduleExportFunction(value, "hydrateRoot")) {
      reactDomClientCandidate = value;
    }
    // Discord's message-author surface uses a React memo component whose
    // module owns the native profile preloader and generic Popout wrapper.
    // Match the factory's behavioral literals rather than its unstable module
    // ID or minified export key, then accept only that factory's memo export.
    if (isUserProfilePopoutSource(sourceInfo) && value.$$typeof === Symbol.for("react.memo") &&
        typeof value.type === "function") {
      userProfilePopoutCandidate = value;
    }
    // Accept the timeout action only when its kick/ban companions prove this
    // is Discord's native GuildMemberActions module.
    if (dataFunction(value, "setCommunicationDisabledUntil") &&
        dataFunction(value, "kickUser") && dataFunction(value, "banUser")) {
      timeoutUntilActionsCandidate = value;
    }
  }

  function inspectExports(rootValue, sourceInfo) {
    const queue = [{ value: rootValue, depth: 0 }];
    const visited = new WeakSet();
    let inspected = 0;
    while (queue.length && inspected < 300) {
      const { value, depth } = queue.shift();
      if (!value || (typeof value !== "object" && typeof value !== "function") || visited.has(value)) continue;
      visited.add(value);
      inspected += 1;
      if (shouldIgnoreValue(value)) continue;
      inspectUserActionExports(value, sourceInfo);
      if (userStoreFunctions(value)) {
        structuralUserStoreCandidates.delete(value);
        structuralUserStoreCandidates.add(value);
        while (structuralUserStoreCandidates.size > 12) {
          structuralUserStoreCandidates.delete(structuralUserStoreCandidates.values().next().value);
        }
      }
      const storeInfo = coreStoreInfo(value);
      if (storeInfo) {
        const usableMessageStore = storeInfo.name === "MessageStore" &&
          dataFunction(value, "getMessage") && dataFunction(value, "getMessages");
        // Discord's UserStore surface is not stable across client builds. Its
        // exact Flux store name plus the ID-keyed getter is sufficient here;
        // getCurrentUser is unrelated to resolving another message author and
        // has disappeared from some builds.
        const usableUserStore = storeInfo.name === "UserStore" && moduleExportFunction(value, "getUser");
        const usableGuildMemberStore = storeInfo.name === "GuildMemberStore" &&
          moduleExportFunction(value, "getMember") && moduleExportFunction(value, "getMembers");
        if (usableUserStore) userStoreCandidate = value;
        if (usableGuildMemberStore && (!coreDispatcher || storeInfo.dispatcher === coreDispatcher)) {
          guildMemberStoreCandidate = value;
          guildMemberStoreSource = sourceInfo || null;
        }
        // Do not let a decoy/partial named store claim global hook health. Its
        // dispatcher must first pass subscription and become the accepted core
        // dispatcher, and the store must expose the cache reads retention needs.
        if (usableMessageStore) {
          messageStoreCandidate = value;
          reconcileMessageStore("module-discovery");
        } else if (!usableUserStore && !usableGuildMemberStore) subscribeDispatcher(storeInfo.dispatcher, true, false);
      }
      else if (fallbackDispatchers.size < 4 && isDispatcher(value)) fallbackDispatchers.add(value);
      if (depth >= 2) continue;
      let descriptors;
      try { descriptors = Object.getOwnPropertyDescriptors(value); } catch (_error) { continue; }
      for (const [property, descriptor] of Object.entries(descriptors).slice(0, 80)) {
        let child;
        if ("value" in descriptor) child = descriptor.value;
        else if (descriptor.enumerable && typeof descriptor.get === "function") {
          // Webpack commonly exposes module values through enumerable harmony-export getters.
          try { child = value[property]; } catch (_error) { continue; }
        } else continue;
        if (child && (typeof child === "object" || typeof child === "function")) {
          queue.push({ value: child, depth: depth + 1 });
        }
      }
    }
  }

  function scanWebpack(requireFunction, force) {
    if (!requireFunction || (typeof requireFunction !== "function" && typeof requireFunction !== "object")) return;
    webpackInstances.add(requireFunction);
    const cache = requireFunction.c;
    if (!cache || typeof cache !== "object") return;
    let seen = scannedModules.get(requireFunction);
    if (!seen) {
      seen = new Set();
      scannedModules.set(requireFunction, seen);
    }
    for (const [moduleId, module] of Object.entries(cache)) {
      if (!force && seen.has(moduleId)) continue;
      seen.add(moduleId);
      try { inspectExports(module && module.exports, { requireFunction, moduleId }); } catch (_error) {}
    }
    if (!coreDispatcher && !fallbackDispatcher && fallbackDispatchers.size) {
      for (const dispatcher of fallbackDispatchers) {
        subscribeDispatcher(dispatcher, false);
        if (fallbackDispatcher) break;
      }
    }
    if (messageStoreCandidate) reconcileMessageStore("module-scan");
  }

  function acceptWebpackRequire(requireFunction) {
    if (!requireFunction) return;
    scanWebpack(requireFunction);
  }

  function attachWebpackArray(chunkArray) {
    if (!chunkArray || typeof chunkArray.push !== "function") return;
    const captureId = `ldma_${Date.now()}_${captureSequence += 1}`;
    try {
      // The runtime callback works both when Webpack is already initialized and when
      // this entry is queued before Discord installs its Webpack push handler.
      chunkArray.push([[captureId], {}, acceptWebpackRequire]);
    } catch (_error) {
      report("degraded", "Discord's module loader rejected the lifecycle probe; DOM deletion fallback remains active.");
    }
  }

  function observeWebpackGlobal() {
    const property = "webpackChunkdiscord_app";
    if (property in window) {
      const current = window[property];
      if (current && current !== observedChunkArray) {
        observedChunkArray = current;
        attachWebpackArray(current);
      }
      return;
    }
    try {
      Object.defineProperty(window, property, {
        configurable: true,
        enumerable: false,
        set(value) {
          delete window[property];
          window[property] = value;
          observedChunkArray = value;
          attachWebpackArray(value);
        }
      });
    } catch (_error) {
      report("degraded", "Could not observe Discord's module loader; DOM fallback remains active.");
    }
  }

  function recoverHook(reason) {
    observeWebpackGlobal();
    if (messageStoreCandidate) reconcileMessageStore(reason || "recovery");
    if (!messageStorePatched) {
      const backoff = Math.min(30000, forcedScanAttempts
        ? 1500 * (2 ** Math.min(5, forcedScanAttempts - 1))
        : 0);
      if (Date.now() - lastForcedScanAt >= backoff) {
        lastForcedScanAt = Date.now();
        forcedScanAttempts += 1;
        for (const requireFunction of webpackInstances) scanWebpack(requireFunction, true);
        if (messageStoreCandidate) reconcileMessageStore("forced-scan");
      }
    } else {
      forcedScanAttempts = 0;
    }
    lastStatus = "";
    if (messageStorePatched) {
      report("active", "Discord MessageStore edit history and deletion retention are active.", true);
    } else if (coreDispatcher) {
      report("searching", "Discord core dispatcher connected; waiting for MessageStore retention.", true);
    } else if (fallbackDispatcher) {
      report("searching", "A deletion dispatcher candidate is connected; waiting for Discord's core store dispatcher.", true);
    } else {
      report("searching", `Waiting for Discord's lifecycle dispatcher; recovery probe ${reason || "scheduled"}.`, true);
    }
  }

  function validUserActionPayload(action, payload) {
    if (action !== "open-profile" && action !== "timeout-7d") return null;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    try {
      const keys = Object.keys(payload);
      const expectedKeys = action === "open-profile"
        ? ["anchor", "guildId", "userId"] : ["guildId", "userId"];
      if (keys.length !== expectedKeys.length || expectedKeys.some((key) => !keys.includes(key))) return null;
      const rawUserId = payload.userId;
      const rawGuildId = payload.guildId;
      const userId = cleanId(rawUserId);
      const guildId = rawGuildId == null ? null : cleanId(rawGuildId);
      if (!userId || (rawGuildId != null && !guildId)) return null;
      if (action === "timeout-7d" && !guildId) return null;
      if (action === "timeout-7d") return { userId, guildId };
      const anchor = payload.anchor;
      if (!anchor || typeof anchor !== "object" || Array.isArray(anchor) ||
        Object.keys(anchor).sort().join(",") !== "height,left,top,width") return null;
      const normalizedAnchor = {
        left: anchor.left, top: anchor.top, width: anchor.width, height: anchor.height
      };
      if (!Object.values(normalizedAnchor).every((value) => typeof value === "number" && Number.isFinite(value)) ||
        normalizedAnchor.left < -1024 || normalizedAnchor.top < -1024 ||
        normalizedAnchor.left > 32768 || normalizedAnchor.top > 32768 ||
        normalizedAnchor.width < 1 || normalizedAnchor.height < 1 ||
        normalizedAnchor.width > 2048 || normalizedAnchor.height > 2048) return null;
      return { userId, guildId, anchor: normalizedAnchor };
    } catch (_error) {
      return null;
    }
  }

  function rediscoverUserActionModules() {
    // Clear first so a removed/replaced Discord module cannot remain callable
    // through a stale object after Webpack swaps its cached export.
    reactCandidate = null;
    reactDomClientCandidate = null;
    userProfilePopoutCandidate = null;
    timeoutUntilActionsCandidate = null;
    for (const requireFunction of webpackInstances) scanWebpack(requireFunction, true);
  }

  function disposeMountedUserProfilePopout(expectedMount) {
    const mount = mountedUserProfilePopout;
    if (!mount || expectedMount && mount !== expectedMount) return;
    mountedUserProfilePopout = null;
    try { clearTimeout(mount.expiryTimer); } catch (_error) {}
    try { document.removeEventListener("scroll", mount.closeOnViewportChange, true); } catch (_error) {}
    try { window.removeEventListener("resize", mount.closeOnViewportChange); } catch (_error) {}
    try { window.removeEventListener("popstate", mount.closeOnViewportChange); } catch (_error) {}
    try { mount.root?.unmount(); } catch (_error) {}
    try { mount.anchor?.remove(); } catch (_error) {}
  }

  function openUserProfilePopout(normalized) {
    const createElement = moduleExportFunction(reactCandidate, "createElement");
    const createRoot = moduleExportFunction(reactDomClientCandidate, "createRoot");
    const component = userProfilePopoutCandidate;
    const user = cachedUser(normalized.userId);
    const route = /^\/channels\/(@me|\d{15,25})\/(\d{15,25})\/?$/.exec(window.location?.pathname || "");
    const routeGuildId = route?.[1] === "@me" ? null : route?.[1] || null;
    if (!createElement || !createRoot || !component || !user || !route || routeGuildId !== normalized.guildId ||
      typeof document?.createElement !== "function" || !document.body) {
      return { ok: false, reason: "profile-popout-unavailable" };
    }
    const viewportWidth = Number(window.innerWidth);
    const viewportHeight = Number(window.innerHeight);
    if (!Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight) ||
      viewportWidth < 1 || viewportHeight < 1) return { ok: false, reason: "profile-popout-unavailable" };
    const requested = normalized.anchor;
    if (requested.left + requested.width <= 0 || requested.top + requested.height <= 0 ||
      requested.left >= viewportWidth || requested.top >= viewportHeight) {
      return { ok: false, reason: "profile-popout-anchor-unavailable" };
    }
    disposeMountedUserProfilePopout();
    const anchor = document.createElement("span");
    anchor.setAttribute("aria-hidden", "true");
    anchor.setAttribute("data-ldma-profile-popout-anchor", "true");
    const left = Math.max(0, Math.min(viewportWidth - 1, requested.left));
    const top = Math.max(0, Math.min(viewportHeight - 1, requested.top));
    Object.assign(anchor.style, {
      position: "fixed",
      left: `${left}px`,
      top: `${top}px`,
      width: `${Math.max(1, Math.min(requested.width, viewportWidth - left))}px`,
      height: `${Math.max(1, Math.min(requested.height, viewportHeight - top))}px`,
      opacity: "0",
      pointerEvents: "none"
    });
    document.body.append(anchor);
    const mount = {
      anchor, root: null, expiryTimer: null, closeOnViewportChange: null,
      pathname: window.location.pathname
    };
    const close = () => setTimeout(() => disposeMountedUserProfilePopout(mount), 0);
    mount.closeOnViewportChange = close;
    try {
      mount.root = createRoot.call(reactDomClientCandidate, anchor);
      if (!mount.root || typeof mount.root.render !== "function" || typeof mount.root.unmount !== "function") {
        throw new Error("invalid-react-root");
      }
      mountedUserProfilePopout = mount;
      document.addEventListener("scroll", mount.closeOnViewportChange, true);
      window.addEventListener("resize", mount.closeOnViewportChange);
      window.addEventListener("popstate", mount.closeOnViewportChange);
      mount.expiryTimer = setTimeout(close, 5 * 60 * 1000);
      mount.root.render(createElement.call(reactCandidate, component, {
        targetElementRef: { current: anchor },
        user,
        userId: normalized.userId,
        guildId: normalized.guildId ?? undefined,
        channelId: route[2],
        position: "left",
        spacing: 16,
        fixed: true,
        clickTrap: true,
        ignoreModalClicks: true,
        shouldShow: true,
        onRequestClose: close,
        onClosePopout: close,
        children: () => null
      }));
      return { ok: true, reason: "opened-popout" };
    } catch (_error) {
      disposeMountedUserProfilePopout(mount);
      return { ok: false, reason: "profile-popout-failed" };
    }
  }

  function resolveMessageAuthors(channelValue, idValues, fallbackValues) {
    const channelId = cleanId(channelValue);
    if (!channelId || !Array.isArray(idValues) || idValues.length < 1 || idValues.length > MAX_BULK_IDS) {
      return { ok: false, reason: "invalid-request", authors: [] };
    }
    const ids = [...new Set(idValues.map(cleanId).filter(Boolean))];
    if (!ids.length || ids.length !== idValues.length) {
      return { ok: false, reason: "invalid-request", authors: [] };
    }
    const fallbackUsers = new Map();
    for (const item of Array.isArray(fallbackValues) ? fallbackValues : []) {
      const messageId = cleanId(item?.messageId);
      const userId = cleanId(item?.userId);
      if (messageId && userId && ids.includes(messageId) && !fallbackUsers.has(messageId)) {
        fallbackUsers.set(messageId, { userId, username: cleanUsername(item?.username) });
      }
    }
    let userStoresRefreshed = false;
    const resolveCachedUser = (userId) => {
      let user = cachedUser(userId);
      if (user || userStoresRefreshed) return user;
      userStoresRefreshed = true;
      for (const requireFunction of webpackInstances) scanWebpack(requireFunction, true);
      return cachedUser(userId);
    };
    if (!messageStoreCandidate || !moduleExportFunction(messageStoreCandidate, "getMessage")) {
      recoverHook("author-resolution");
    } else {
      reconcileMessageStore("author-resolution");
    }
    const getMessage = moduleExportFunction(messageStoreCandidate, "getMessage");
    if (!getMessage) {
      let usernamesMissing = 0;
      const authors = ids.map((messageId) => {
        const fallbackUser = fallbackUsers.get(messageId);
        if (!fallbackUser) return null;
        const username = fallbackUser.username || cleanUsername(resolveCachedUser(fallbackUser.userId)?.username);
        if (!username) usernamesMissing += 1;
        return Object.assign({ messageId, userId: fallbackUser.userId }, username ? { username } : {});
      }).filter(Boolean);
      return {
        ok: authors.length > 0,
        reason: authors.length > 0
          ? usernamesMissing ? "resolved-author-ids-only" : "resolved-from-trusted-archive"
          : "message-store-unavailable",
        authors
      };
    }
    const authors = [];
    let usernamesMissing = 0;
    for (const messageId of ids) {
      let message = null;
      try { message = getMessage.call(messageStoreCandidate, channelId, messageId); } catch (_error) {}
      const resolvedMessageId = cleanId(message?.id);
      const resolvedChannelId = cleanId(message?.channelId || message?.channel_id);
      const exactMessage = resolvedMessageId === messageId && resolvedChannelId === channelId ? message : null;
      const fallbackUser = fallbackUsers.get(messageId);
      const messageAuthor = messageAuthorIdentity(exactMessage);
      const userId = messageAuthor.userId ||
        fallbackUser?.userId || null;
      if (!userId) continue;
      let username = messageAuthor.username;
      if (!username) username = cleanUsername(resolveCachedUser(userId)?.username);
      if (!username && fallbackUser?.userId === userId) username = fallbackUser.username;
      const item = { messageId, userId };
      if (username) item.username = username;
      else usernamesMissing += 1;
      authors.push(item);
    }
    return { ok: true, reason: usernamesMissing ? "resolved-author-ids-only" : "resolved", authors };
  }

  function memberTimeoutUntil(member, expectedGuildId) {
    if (!member || typeof member !== "object") return { known: false, timeoutUntil: null };
    let memberUserId;
    let memberGuildId;
    let memberGuildProvided = false;
    try {
      const rawMemberUserId = member.userId || member.user_id || member.user?.id;
      const rawMemberGuildId = member.guildId || member.guild_id;
      memberGuildProvided = rawMemberGuildId != null;
      if (typeof rawMemberUserId !== "string" ||
          rawMemberGuildId != null && typeof rawMemberGuildId !== "string") {
        return { known: false, timeoutUntil: null };
      }
      memberUserId = cleanId(rawMemberUserId);
      memberGuildId = rawMemberGuildId == null ? null : cleanId(rawMemberGuildId);
    }
    catch (_error) { return { known: false, timeoutUntil: null }; }
    if (!memberUserId || memberGuildProvided && (!memberGuildId || memberGuildId !== expectedGuildId)) {
      return { known: false, timeoutUntil: null };
    }
    let raw;
    try {
      raw = member.communicationDisabledUntil ?? member.communication_disabled_until ??
        member.communicationDisabledUntilTimestamp ?? member.communication_disabled_until_timestamp;
    } catch (_error) {
      return { known: false, timeoutUntil: null };
    }
    if (raw == null || raw === "") return { known: true, userId: memberUserId, timeoutUntil: null };
    let timestamp;
    try {
      if (raw instanceof Date) timestamp = raw.valueOf();
      else if (typeof raw === "number") timestamp = raw > 0 && raw < 100000000000 ? raw * 1000 : raw;
      else timestamp = Date.parse(String(raw));
    } catch (_error) {
      return { known: false, timeoutUntil: null };
    }
    if (!Number.isFinite(timestamp) || Math.abs(timestamp) > 8640000000000000) {
      return { known: false, timeoutUntil: null };
    }
    return {
      known: true,
      userId: memberUserId,
      timeoutUntil: timestamp > Date.now() ? new Date(timestamp).toISOString() : null
    };
  }

  function resolveMemberTimeouts(guildValue, userValues) {
    if (typeof guildValue !== "string" || !Array.isArray(userValues) ||
        userValues.some((value) => typeof value !== "string")) {
      return { ok: false, reason: "invalid-request", statuses: [] };
    }
    const guildId = cleanId(guildValue);
    if (!guildId || !Array.isArray(userValues) || userValues.length < 1 || userValues.length > MAX_BULK_IDS) {
      return { ok: false, reason: "invalid-request", statuses: [] };
    }
    const userIds = [...new Set(userValues.map(cleanId).filter(Boolean))];
    if (!userIds.length || userIds.length !== userValues.length) {
      return { ok: false, reason: "invalid-request", statuses: [] };
    }
    // Re-read the one module that produced the accepted store before each
    // bounded UI query. This catches replaced exports without repeatedly
    // walking Discord's entire Webpack cache (which can contend with scrolling).
    const source = guildMemberStoreSource;
    guildMemberStoreCandidate = null;
    guildMemberStoreSource = null;
    let sourceModule = null;
    try { sourceModule = source?.requireFunction?.c?.[source.moduleId] || null; } catch (_error) {}
    if (sourceModule) try { inspectExports(sourceModule.exports, source); } catch (_error) {}
    if (!guildMemberStoreCandidate) {
      for (const requireFunction of webpackInstances) scanWebpack(requireFunction, true);
    }
    const getMember = moduleExportFunction(guildMemberStoreCandidate, "getMember");
    const getMembers = moduleExportFunction(guildMemberStoreCandidate, "getMembers");
    const refreshedInfo = coreStoreInfo(guildMemberStoreCandidate);
    if (!getMember || !getMembers || refreshedInfo?.name !== "GuildMemberStore" || refreshedInfo.dispatcher !== coreDispatcher) {
      return { ok: false, reason: "guild-member-store-unavailable", statuses: [] };
    }
    const statuses = [];
    for (const userId of userIds) {
      let member = null;
      try { member = getMember.call(guildMemberStoreCandidate, guildId, userId); } catch (_error) {}
      const normalized = memberTimeoutUntil(member, guildId);
      if (!normalized.known || normalized.userId !== userId) continue;
      statuses.push({ userId, timeoutUntil: normalized.timeoutUntil });
    }
    return { ok: true, reason: "member-timeouts-resolved", statuses };
  }

  async function invokeUserAction(action, payload) {
    const normalized = validUserActionPayload(action, payload);
    if (!normalized) return { ok: false, reason: "invalid-request" };
    rediscoverUserActionModules();
    try {
      if (action === "open-profile") {
        return openUserProfilePopout(normalized);
      }
      const setUntil = dataFunction(timeoutUntilActionsCandidate, "setCommunicationDisabledUntil");
      if (!setUntil) return { ok: false, reason: "module-unavailable" };
      await Promise.resolve(setUntil.call(timeoutUntilActionsCandidate, {
        guildId: normalized.guildId,
        userId: normalized.userId,
        communicationDisabledUntilTimestamp: new Date(Date.now() + TIMEOUT_7D_SECONDS * 1000).toISOString(),
        duration: TIMEOUT_7D_SECONDS,
        reason: ""
      }));
      bridgeMessage("timeout-state-dirty", { guildId: normalized.guildId, userId: normalized.userId });
      return { ok: true, reason: "timed-out-7d" };
    } catch (_error) {
      return { ok: false, reason: "action-failed" };
    }
  }

  function releaseRetainedMessages(channelValue, idValues) {
    // Explicit removal must also discard retry knowledge when the native cache
    // or dispatcher has already disappeared.
    forgetPendingRetainedDeletes(channelValue, idValues);
    const channelId = cleanId(channelValue);
    const ids = [...new Set((Array.isArray(idValues) ? idValues : []).slice(0, MAX_BULK_IDS).map(cleanId).filter(Boolean))];
    const result = { releasedIds: [], failedIds: [] };
    const dispatcher = coreDispatcher || fallbackDispatcher;
    if (!channelId) return result;
    if (!dispatcher) return { releasedIds: [], failedIds: ids };
    for (const id of ids) {
      const key = `${channelId}:${id}`;
      let cachedMessage = null;
      let cacheKnown = false;
      let markedInStore = false;
      try {
        if (typeof messageStoreCandidate?.getMessage === "function") {
          cachedMessage = messageStoreCandidate.getMessage(channelId, id);
          cacheKnown = true;
          markedInStore = cachedMessage?.deleted === true;
        }
      } catch (_error) {}
      if (!retainedKeys.has(key) && !markedInStore) {
        (cacheKnown && !cachedMessage ? result.releasedIds : result.failedIds).push(id);
        continue;
      }
      releaseKeys.add(key);
      let dispatched = false;
      try {
        dispatcher.dispatch({ type: "MESSAGE_DELETE", channelId, id });
        dispatched = true;
      } catch (_error) {
        try {
          dispatcher.dispatch({ type: "MESSAGE_DELETE", channel_id: channelId, id });
          dispatched = true;
        } catch (_ignored) {}
      } finally {
        releaseKeys.delete(key);
      }
      let released = false;
      try {
        released = dispatched && typeof messageStoreCandidate?.getMessage === "function" &&
          !messageStoreCandidate.getMessage(channelId, id);
      } catch (_error) {}
      if (released) retainedKeys.delete(key);
      (released ? result.releasedIds : result.failedIds).push(id);
    }
    return result;
  }

  function resetPendingRetainedDeletes(resetToken) {
    const validToken = Number.isSafeInteger(resetToken) && resetToken >= 0;
    if (validToken && lastDeletionReset && resetToken <= lastDeletionReset.resetToken) {
      bridgeMessage("deletions-reset", resetToken === lastDeletionReset.resetToken
        ? lastDeletionReset : { resetToken, discarded: [] });
      return;
    }
    const byChannel = new Map();
    for (const entry of pendingRetainedDeletes.values()) {
      if (!byChannel.has(entry.channelId)) byChannel.set(entry.channelId, []);
      byChannel.get(entry.channelId).push(entry.id);
    }
    // A generation reset must not leave an unarchived native row behind to be
    // captured as live in the new archive. ACKed rows are intentionally outside
    // this retry ledger and keep their independent explicit-release lifecycle.
    const discarded = [];
    for (const [channelId, ids] of byChannel) {
      for (let offset = 0; offset < ids.length; offset += MAX_BULK_IDS) {
        const batch = ids.slice(offset, offset + MAX_BULK_IDS);
        discarded.push({ channelId, ids: batch });
        const released = releaseRetainedMessages(channelId, batch);
        if (released.failedIds.length) deletionResetReleaseFailed = true;
      }
    }
    pendingRetainedDeletes.clear();
    for (let index = bufferedEvents.length - 1; index >= 0; index -= 1) {
      if (bufferedEvents[index].kind === "delete" || bufferedEvents[index].kind === "retained") bufferedEvents.splice(index, 1);
    }
    deletionLedgerOverflowed = false;
    if (deletionResetReleaseFailed) report("active", "");
    const result = validToken ? { resetToken, discarded } : { discarded };
    if (validToken) lastDeletionReset = result;
    bridgeMessage("deletions-reset", result);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.bridge !== BRIDGE) return;
    if (event.data.kind === "release") {
      releaseRetainedMessages(event.data.channelId, event.data.ids);
      return;
    }
    if (event.data.kind === "deletion-ack") {
      forgetPendingRetainedDeletes(event.data.channelId, event.data.ids);
      return;
    }
    if (event.data.kind === "reset-deletions") {
      resetPendingRetainedDeletes(event.data.resetToken);
      return;
    }
    if (event.data.kind === "sync-deletions") {
      replayRetainedDeletes(event.data.channelId);
      return;
    }
    if (event.data.kind !== "isolated-ready") return;
    isolatedReady = true;
    while (bufferedEvents.length) window.postMessage(bufferedEvents.shift(), "*");
    replayRetainedDeletes();
    lastStatus = "";
    if (messageStorePatched) {
      report("active", "Discord MessageStore edit history and deletion retention are active.");
    } else if (coreDispatcher) {
      report("searching", "Discord core dispatcher connected; waiting for MessageStore retention.");
    } else if (fallbackDispatcher) {
      report("searching", "A deletion dispatcher candidate is connected; waiting for Discord's core store dispatcher.");
    } else {
      report("searching", "Waiting for Discord's lifecycle dispatcher; DOM deletion fallback is active.");
    }
  });

  // A content script may already have sent its one-time ready signal before a
  // restored/late MAIN-world hook was injected. Request an explicit reply so
  // buffered lifecycle events can never wait for a page refresh.
  bridgeMessage("ready-request");
  report("searching", "Waiting for Discord's lifecycle dispatcher; DOM deletion fallback is active.");
  observeWebpackGlobal();
  controller.recover = recoverHook;
  controller.invokeUserAction = invokeUserAction;
  controller.resolveMessageAuthors = resolveMessageAuthors;
  controller.resolveMemberTimeouts = resolveMemberTimeouts;
  if (controller.pendingRecovery) recoverHook("queued-injection");
  let recoveryTicks = 0;
  setInterval(() => {
    if (mountedUserProfilePopout?.pathname !== undefined &&
      mountedUserProfilePopout.pathname !== window.location.pathname) {
      disposeMountedUserProfilePopout();
    }
    // Once retention is healthy, reconcileMessageStore below is the cheap
    // integrity check. Enumerating Discord's full module cache every tick is
    // unnecessary and can contend with scrolling in image-heavy channels.
    if (!messageStorePatched) {
      for (const requireFunction of webpackInstances) scanWebpack(requireFunction);
    }
    if (!dispatchers.size && !webpackInstances.size && "webpackChunkdiscord_app" in window) observeWebpackGlobal();
    if (messageStoreCandidate) reconcileMessageStore("integrity-tick");
    recoveryTicks += 1;
    // Cold Discord boots can expose a mutable/lazy export after its module ID was
    // first seen. Revisit the full cache while unresolved, and periodically
    // revalidate an established patch in case Discord replaced its handlers.
    if ((!messageStorePatched && recoveryTicks % 4 === 0) || recoveryTicks % 20 === 0) {
      recoverHook(messageStorePatched ? "integrity-check" : "cold-start");
    }
  }, 1500);
})();
