(function installLocalDiscordLifecycleHook() {
  "use strict";

  const BRIDGE = "LDMA_BRIDGE_V1";
  const EDIT_EVENT = "LDMA_EDIT_BEFORE_V1";
  const SNOWFLAKE = /^\d{15,25}$/;
  const MAX_BULK_IDS = 200;
  const webpackInstances = new Set();
  const scannedModules = new WeakMap();
  const dispatchers = new Set();
  const fallbackDispatchers = new Set();
  const CORE_STORES = new Set(["MessageStore", "ChannelStore", "GuildStore", "ReadStateStore"]);
  const bufferedEvents = [];
  const patchedHandlerNodes = new WeakSet();
  const patchedRetentionDispatchers = new WeakSet();
  const releaseKeys = new Set();
  const retainedKeys = new Set();
  let isolatedReady = false;
  let coreDispatcher = null;
  let fallbackDispatcher = null;
  let messageStoreCandidate = null;
  let messageStorePatched = false;
  let lastStatus = "";
  let captureSequence = 0;
  let editSequence = 0;
  const editSessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

  function bridgeMessage(kind, payload) {
    window.postMessage(Object.assign({ bridge: BRIDGE, kind }, payload || {}), "*");
  }

  function report(status, detail) {
    const signature = `${status}:${detail}`;
    if (signature === lastStatus) return;
    lastStatus = signature;
    bridgeMessage("status", { status, detail });
  }

  function cleanId(value) {
    const id = String(value || "");
    return SNOWFLAKE.test(id) ? id : null;
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

  function emitEditBefore(item) {
    if (!item) return;
    const detail = {
      bridge: BRIDGE,
      kind: "edit-before",
      channelId: item.channelId,
      ids: [item.id],
      editedAt: item.editedAt,
      editSessionId,
      editSequence: editSequence += 1
    };
    try {
      window.dispatchEvent(new CustomEvent(EDIT_EVENT, { detail: JSON.stringify(detail) }));
    } catch (_error) {
      bridgeMessage("edit-before", detail);
    }
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

  function isDispatcher(value) {
    return Boolean(value && (typeof value === "object" || typeof value === "function") &&
      dataFunction(value, "dispatch") && dataFunction(value, "subscribe") && dataFunction(value, "unsubscribe"));
  }

  function subscribeDispatcher(dispatcher, preferred) {
    if (!isDispatcher(dispatcher)) return;
    if (preferred && dispatcher === fallbackDispatcher && dispatchers.has(dispatcher)) {
      coreDispatcher = dispatcher;
      fallbackDispatcher = null;
      report(messageStorePatched ? "active" : "searching", messageStorePatched
        ? "Discord MessageStore edit history and deletion retention are active."
        : "Discord core dispatcher connected; waiting for MessageStore retention.");
      return;
    }
    if (dispatchers.has(dispatcher)) return;
    if (preferred) {
      if (coreDispatcher) return;
    } else {
      if (coreDispatcher || fallbackDispatcher) return;
    }
    try {
      dispatcher.subscribe("MESSAGE_DELETE", onDelete);
      dispatcher.subscribe("MESSAGE_DELETE_BULK", onBulkDelete);
      if (preferred) {
        coreDispatcher = dispatcher;
        if (fallbackDispatcher && fallbackDispatcher !== dispatcher) {
          try { fallbackDispatcher.unsubscribe("MESSAGE_DELETE", onDelete); } catch (_ignored) {}
          try { fallbackDispatcher.unsubscribe("MESSAGE_DELETE_BULK", onBulkDelete); } catch (_ignored) {}
          dispatchers.delete(fallbackDispatcher);
          fallbackDispatcher = null;
        }
      } else fallbackDispatcher = dispatcher;
      dispatchers.add(dispatcher);
      report(messageStorePatched ? "active" : "searching", messageStorePatched
        ? "Discord MessageStore edit history and deletion retention are active."
        : preferred ? "Discord core dispatcher connected; waiting for MessageStore retention."
        : "A deletion dispatcher candidate is connected; waiting for Discord's core store dispatcher.");
    } catch (_error) {
      try { dispatcher.unsubscribe("MESSAGE_DELETE", onDelete); } catch (_ignored) {}
      try { dispatcher.unsubscribe("MESSAGE_DELETE_BULK", onBulkDelete); } catch (_ignored) {}
    }
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
    if (patchedRetentionDispatchers.has(dispatcher)) return true;
    const settings = options || {};
    const captureEdits = settings.edits !== false;
    const captureDeleteTypes = settings.deleteTypes instanceof Set
      ? settings.deleteTypes
      : new Set(["MESSAGE_DELETE", "MESSAGE_DELETE_BULK"]);
    const original = dataFunction(dispatcher, "dispatch");
    if (!original) return false;
    try {
      const retainingDispatch = function localArchiveRetainingDispatch(action) {
        const type = action && action.type;
        if (captureEdits && type === "MESSAGE_UPDATE") emitEditBefore(editLifecycle(store, action));
        const isBulk = type === "MESSAGE_DELETE_BULK";
        const key = `${cleanId(action && (action.channelId || action.channel_id))}:${cleanId(action && action.id)}`;
        const shouldRetain = captureDeleteTypes.has(type) && !releaseKeys.has(key);
        const captured = shouldRetain ? captureCachedMessages(store, action, isBulk).captured : [];
        const result = original.apply(this, arguments);
        if (captured.length) retainCachedMessages(store, action, isBulk, captured);
        return result;
      };
      dispatcher.dispatch = retainingDispatch;
      if (dataFunction(dispatcher, "dispatch") !== retainingDispatch) return false;
      patchedRetentionDispatchers.add(dispatcher);
      messageStorePatched = true;
      report("active", "Discord MessageStore edit history and deletion retention fallback is active.");
      return true;
    } catch (_error) {
      return false;
    }
  }

  function patchMessageStore(store, dispatcher) {
    const node = messageStoreHandlerNode(store, dispatcher);
    if (!node) {
      patchDispatcherRetention(store, dispatcher);
      return;
    }
    if (patchedHandlerNodes.has(node)) return;
    const handlers = node.actionHandler;
    let editPatched = false;
    const deletePatched = new Set();
    const originalUpdate = handlers.MESSAGE_UPDATE;
    if (typeof originalUpdate === "function") {
      const retainingUpdateHandler = function localArchiveEditHandler(action) {
        emitEditBefore(editLifecycle(store, action));
        return originalUpdate.apply(this, arguments);
      };
      try {
        handlers.MESSAGE_UPDATE = retainingUpdateHandler;
        if (handlers.MESSAGE_UPDATE === retainingUpdateHandler) editPatched = true;
      } catch (_error) {}
    }
    for (const [type, isBulk] of [["MESSAGE_DELETE", false], ["MESSAGE_DELETE_BULK", true]]) {
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
        if (handlers[type] === retainingHandler) deletePatched.add(type);
      } catch (_error) {}
    }
    const missingDeleteTypes = new Set(["MESSAGE_DELETE", "MESSAGE_DELETE_BULK"]
      .filter((type) => !deletePatched.has(type)));
    const needsFallback = !editPatched || missingDeleteTypes.size > 0;
    const fallbackPatched = needsFallback && patchDispatcherRetention(store, dispatcher, {
      edits: !editPatched,
      deleteTypes: missingDeleteTypes
    });
    if (needsFallback && !fallbackPatched) {
      patchedHandlerNodes.add(node);
      messageStorePatched = false;
      report("degraded", "Discord MessageStore is only partially patchable; edit history or deletion retention may be unavailable.");
      return;
    }
    patchedHandlerNodes.add(node);
    messageStorePatched = true;
    report("active", "Discord MessageStore edit history and deletion retention are active.");
  }

  function shouldIgnoreValue(value) {
    if (!value || value === window) return true;
    try {
      const tag = value[Symbol.toStringTag];
      if (tag === "IntlMessagesProxy" || tag === "DOMTokenList") return true;
      const probe = "__ldma_proxy_probe_7d31__";
      if (value[probe] !== undefined) {
        try { Reflect.deleteProperty(value, probe); } catch (_ignored) {}
        return true;
      }
    } catch (_error) {
      return true;
    }
    return false;
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
      const storeInfo = coreStoreInfo(value);
      if (storeInfo) {
        subscribeDispatcher(storeInfo.dispatcher, true);
        const usableMessageStore = storeInfo.name === "MessageStore" &&
          dataFunction(value, "getMessage") && dataFunction(value, "getMessages");
        // Do not let a decoy/partial named store claim global hook health. Its
        // dispatcher must first pass subscription and become the accepted core
        // dispatcher, and the store must expose the cache reads retention needs.
        if (usableMessageStore && storeInfo.dispatcher === coreDispatcher) {
          messageStoreCandidate = value;
          patchMessageStore(value, storeInfo.dispatcher);
        }
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

  function scanWebpack(requireFunction) {
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
      if (seen.has(moduleId)) continue;
      seen.add(moduleId);
      try { inspectExports(module && module.exports); } catch (_error) {}
    }
    if (!coreDispatcher && !fallbackDispatcher && fallbackDispatchers.size) {
      subscribeDispatcher(fallbackDispatchers.values().next().value, false);
    }
    if (!messageStorePatched && messageStoreCandidate && coreDispatcher) {
      patchMessageStore(messageStoreCandidate, coreDispatcher);
    }
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
      attachWebpackArray(window[property]);
      return;
    }
    try {
      Object.defineProperty(window, property, {
        configurable: true,
        enumerable: false,
        set(value) {
          delete window[property];
          window[property] = value;
          attachWebpackArray(value);
        }
      });
    } catch (_error) {
      report("degraded", "Could not observe Discord's module loader; DOM fallback remains active.");
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

  report("searching", "Waiting for Discord's lifecycle dispatcher; DOM deletion fallback is active.");
  observeWebpackGlobal();
  setInterval(() => {
    for (const requireFunction of webpackInstances) scanWebpack(requireFunction);
    if (!dispatchers.size && !webpackInstances.size && "webpackChunkdiscord_app" in window) attachWebpackArray(window.webpackChunkdiscord_app);
  }, 1500);
})();
