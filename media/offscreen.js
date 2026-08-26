(function runOffscreenMediaDownloader() {
  "use strict";

  const MediaStore = globalThis.BridgeModToolsMediaStore;
  let queue = Promise.resolve();

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.target !== "ldma-offscreen-media" || message.type !== "CACHE_REFS") return false;
    let senderPath = null;
    try { senderPath = sender.url ? new URL(sender.url).pathname : null; } catch (_error) {}
    if (sender.id !== chrome.runtime.id || sender.tab || (senderPath && senderPath !== "/src/background.js")) {
      sendResponse({ ok: false, error: "untrusted-offscreen-sender" });
      return false;
    }
    queue = queue.catch(() => undefined).then(() => MediaStore.cacheRefs(message.refs || [], {
      force: Boolean(message.force),
      skipPrune: true
    }));
    queue.then((summary) => sendResponse({ ok: true, summary })).catch((error) => {
      sendResponse({ ok: false, error: String(error && error.message || error) });
    });
    return true;
  });
})();
