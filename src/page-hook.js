(function installLocalDiscordLifecycleHook() {
  "use strict";

  const HOOK_API_VERSION = 3;
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
  const TIMEOUT_7D_SECONDS = 7 * 24 * 60 * 60;
  const webpackInstances = new Set();
  const scannedModules = new WeakMap();
  const dispatchers = new Set();
  const fallbackDispatchers = new Set();
  const CORE_STORES = new Set(["MessageStore", "ChannelStore", "GuildStore", "ReadStateStore", "UserStore"]);
  const bufferedEvents = [];
  const patchedHandlerNodes = new WeakMap();
  const patchedRetentionDispatchers = new WeakMap();
  const releaseKeys = new Set();
  const retainedKeys = new Set();
  const activeSelfEdits = new Map();
  const recentSelfEdits = new Map();
  let isolatedReady = false;
  let coreDispatcher = null;
  let fallbackDispatcher = null;
  let messageStoreCandidate = null;
  let userStoreCandidate = null;
  const structuralUserStoreCandidates = new Set();
  let userProfileActionsCandidate = null;
  let timeoutUntilActionsCandidate = null;
  let messageStorePatched = false;
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
    const message = { bridge: BRIDGE, kind: "retained", channelId, ids, bulk: Boolean(bulk) };
    if (!isolatedReady) {
      bufferedEvents.push(message);
      if (bufferedEvents.length > 100) bufferedEvents.shift();
      return;
    }
    window.postMessage(message, "*");
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
      } catch (_error) {
        try { dispatcher.unsubscribe("MESSAGE_DELETE", onDelete); } catch (_ignored) {}
        try { dispatcher.unsubscribe("MESSAGE_DELETE_BULK", onBulkDelete); } catch (_ignored) {}
        try { dispatcher.unsubscribe("MESSAGE_START_EDIT", onEditStart); } catch (_ignored) {}
        try { dispatcher.unsubscribe("MESSAGE_END_EDIT", onEditEnd); } catch (_ignored) {}
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
    if (!channelId || !captured.length) return;
    let channelMessages;
    try { channelMessages = store.getMessages(channelId); } catch (_error) { return; }
    if (!channelMessages || typeof channelMessages.receiveMessage !== "function") return;
    const retainedIds = [];
    for (const entry of captured) {
      const message = markedDeletedMessage(entry.message);
      if (!message) continue;
      try {
        channelMessages.receiveMessage(message);
        retainedIds.push(entry.id);
        retainedKeys.add(`${channelId}:${entry.id}`);
        while (retainedKeys.size > MAX_RETAINED_KEYS) {
          retainedKeys.delete(retainedKeys.values().next().value);
        }
      } catch (_error) {}
    }
    if (retainedIds.length) emitRetained(channelId, retainedIds, isBulk);
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
          if (message) captured.push({ id, message });
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
        retainCachedMessages(store, action, isBulk, captured);
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

  function inspectUserActionExports(value) {
    if (!value || (typeof value !== "object" && typeof value !== "function")) return;
    // Require the paired close method as a structural signature. A generic
    // object with an open-like function must never become a privileged UI
    // action target merely because one property name happens to match.
    if (moduleExportFunction(value, "openUserProfileModal") &&
        moduleExportFunction(value, "closeUserProfileModal")) {
      userProfileActionsCandidate = value;
    }
    // Accept the timeout action only when its kick/ban companions prove this
    // is Discord's native GuildMemberActions module.
    if (dataFunction(value, "setCommunicationDisabledUntil") &&
        dataFunction(value, "kickUser") && dataFunction(value, "banUser")) {
      timeoutUntilActionsCandidate = value;
    }
  }

  function inspectExports(rootValue) {
    const queue = [{ value: rootValue, depth: 0 }];
    const visited = new WeakSet();
    let inspected = 0;
    while (queue.length && inspected < 300) {
      const { value, depth } = queue.shift();
      if (!value || (typeof value !== "object" && typeof value !== "function") || visited.has(value)) continue;
      visited.add(value);
      inspected += 1;
      if (shouldIgnoreValue(value)) continue;
      inspectUserActionExports(value);
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
        if (usableUserStore) userStoreCandidate = value;
        // Do not let a decoy/partial named store claim global hook health. Its
        // dispatcher must first pass subscription and become the accepted core
        // dispatcher, and the store must expose the cache reads retention needs.
        if (usableMessageStore) {
          messageStoreCandidate = value;
          reconcileMessageStore("module-discovery");
        } else if (!usableUserStore) subscribeDispatcher(storeInfo.dispatcher, true, false);
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
      try { inspectExports(module && module.exports); } catch (_error) {}
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
      if (keys.length !== 2 || !keys.includes("userId") || !keys.includes("guildId")) return null;
      const rawUserId = payload.userId;
      const rawGuildId = payload.guildId;
      const userId = cleanId(rawUserId);
      const guildId = rawGuildId == null ? null : cleanId(rawGuildId);
      if (!userId || (rawGuildId != null && !guildId)) return null;
      if (action === "timeout-7d" && !guildId) return null;
      return { userId, guildId };
    } catch (_error) {
      return null;
    }
  }

  function rediscoverUserActionModules() {
    // Clear first so a removed/replaced Discord module cannot remain callable
    // through a stale object after Webpack swaps its cached export.
    userProfileActionsCandidate = null;
    timeoutUntilActionsCandidate = null;
    for (const requireFunction of webpackInstances) scanWebpack(requireFunction, true);
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

  async function invokeUserAction(action, payload) {
    const normalized = validUserActionPayload(action, payload);
    if (!normalized) return { ok: false, reason: "invalid-request" };
    rediscoverUserActionModules();
    try {
      if (action === "open-profile") {
        const openProfile = moduleExportFunction(userProfileActionsCandidate, "openUserProfileModal");
        if (!openProfile) return { ok: false, reason: "module-unavailable" };
        const profileContext = { userId: normalized.userId, guildId: normalized.guildId };
        await Promise.resolve(openProfile.call(userProfileActionsCandidate, profileContext));
        return { ok: true, reason: "opened" };
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
      return { ok: true, reason: "timed-out-7d" };
    } catch (_error) {
      return { ok: false, reason: "action-failed" };
    }
  }

  function releaseRetainedMessages(channelValue, idValues) {
    const channelId = cleanId(channelValue);
    const dispatcher = coreDispatcher || fallbackDispatcher;
    if (!channelId || !dispatcher) return;
    for (const id of (Array.isArray(idValues) ? idValues : []).map(cleanId).filter(Boolean).slice(0, MAX_BULK_IDS)) {
      const key = `${channelId}:${id}`;
      let markedInStore = false;
      try { markedInStore = messageStoreCandidate?.getMessage(channelId, id)?.deleted === true; } catch (_error) {}
      if (!retainedKeys.has(key) && !markedInStore) continue;
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
        if (dispatched) retainedKeys.delete(key);
      }
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.bridge !== BRIDGE) return;
    if (event.data.kind === "release") {
      releaseRetainedMessages(event.data.channelId, event.data.ids);
      return;
    }
    if (event.data.kind !== "isolated-ready") return;
    isolatedReady = true;
    while (bufferedEvents.length) window.postMessage(bufferedEvents.shift(), "*");
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
  if (controller.pendingRecovery) recoverHook("queued-injection");
  let recoveryTicks = 0;
  setInterval(() => {
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
