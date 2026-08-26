(function runHistory() {
  "use strict";

  const Core = globalThis.LocalDiscordArchiveCore;
  const T = globalThis.LocalDiscordArchiveProtocol.TYPES;
  const search = document.getElementById("search");
  const statusFilter = document.getElementById("status-filter");
  const recordsElement = document.getElementById("records");
  const empty = document.getElementById("empty");
  const summary = document.getElementById("summary");
  const exportButton = document.getElementById("export");
  const clearButton = document.getElementById("clear");
  let archive = { version: 5, generation: 0, paused: false, records: [] };
  const recordViews = new Map();
  let lastMediaRecoveryAt = -Infinity;

  function send(command) {
    return chrome.runtime.sendMessage(command);
  }

  function extensionFrameOrigin() {
    return `chrome-extension://${chrome.runtime.id}`;
  }

  function configureMediaFrame(frame, key, revisionId) {
    const onSize = (event) => {
      if (event.source !== frame.contentWindow || event.origin !== extensionFrameOrigin() || event.data?.type !== "LDMA_MEDIA_SIZE") return;
      frame.style.width = `${Math.max(40, Math.min(550, Math.ceil(Number(event.data.width) || 550)))}px`;
      frame.style.height = `${Math.max(24, Math.min(1600, Math.ceil(Number(event.data.height) || 40)))}px`;
    };
    const onLoad = () => {
      send({ type: T.CREATE_MEDIA_CAPABILITY, key, revisionId: revisionId || undefined }).then((response) => {
        if (!response.ok || !response.capability || !frame.contentWindow) return;
        frame.contentWindow.postMessage({
          type: "LDMA_MEDIA_CAPABILITY",
          capability: response.capability
        }, extensionFrameOrigin());
      }).catch(() => {});
    };
    window.addEventListener("message", onSize);
    frame.addEventListener("load", onLoad);
    return () => {
      window.removeEventListener("message", onSize);
      frame.removeEventListener("load", onLoad);
      frame.removeAttribute("src");
    };
  }

  function mediaFrame(key, revisionId, title) {
    const frame = document.createElement("iframe");
    frame.className = "record__media";
    frame.loading = "lazy";
    frame.title = title;
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads");
    const dispose = configureMediaFrame(frame, key, revisionId);
    frame.src = new URL(chrome.runtime.getURL("media/view.html")).href;
    return { frame, dispose };
  }

  async function refresh() {
    const response = await send({ type: T.GET_ARCHIVE });
    if (response.archive) {
      archive = response.archive;
      if (!archive.paused && performance.now() - lastMediaRecoveryAt >= 5 * 60 * 1000) {
        lastMediaRecoveryAt = performance.now();
        send({ type: T.CACHE_ALL_MEDIA }).catch(() => {});
      }
    }
  }

  function formatDate(value) {
    if (!value) return "Time unavailable";
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? "Time unavailable" : date.toLocaleString();
  }

  function createRecordView(initialRecord) {
    let record = initialRecord;
    const key = Core.recordKey(initialRecord);
    const article = document.createElement("article");
    const top = document.createElement("div");
    top.className = "record__top";
    const heading = document.createElement("div");
    const author = document.createElement("div");
    author.className = "record__author";
    const meta = document.createElement("div");
    meta.className = "record__meta";
    const badge = document.createElement("span");
    const metaText = document.createTextNode("");
    meta.append(badge, metaText);
    heading.append(author, meta);
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "record__delete";
    deleteButton.textContent = "Delete record";
    deleteButton.addEventListener("click", () => deleteOne(record));
    top.append(heading, deleteButton);
    article.append(top);
    const content = document.createElement("p");
    content.className = "record__content";
    const attachments = document.createElement("p");
    attachments.className = "record__attachments";
    const revisions = document.createElement("div");
    revisions.className = "record__revisions";
    revisions.setAttribute("aria-label", "Earlier edited versions");
    article.append(revisions, content, attachments);
    let frame = null;
    let disposeFrame = null;
    let currentMediaSignature = "";
    let revisionDisposers = [];
    let revisionSignature = "";

    function ensureMediaFrame() {
      if (frame) return frame;
      const created = mediaFrame(key, null, `Cached media from ${record.author || "message author"}`);
      frame = created.frame;
      disposeFrame = created.dispose;
      article.append(frame);
      return frame;
    }

    function update(nextRecord) {
      record = nextRecord;
      const deleted = Core.isDeletedStatus(record.status);
      const confirmed = record.status === "confirmed_deleted";
      article.className = `record${deleted ? " deleted" : ""}`;
      author.textContent = record.author || "Unknown author";
      badge.className = `badge${deleted ? " deleted" : ""}`;
      const lifecycle = record.deletionSource === "message_store_preserved"
        ? "Retained deleted"
        : confirmed ? "Lifecycle + removal" : record.status === "inferred_deleted" ? "Possibly removed" : "Seen";
      const editCount = record.editHistory?.length || 0;
      badge.textContent = `${lifecycle}${editCount ? ` · Edited ${editCount}×` : ""}`;
      metaText.data = `${record.channelName || record.channelId || "Unknown channel"} · ${formatDate(record.messageTimestamp || record.capturedAt)}`;
      content.hidden = !record.content;
      content.textContent = record.content || "";
      attachments.hidden = !record.attachments?.length;
      attachments.textContent = record.attachments?.length ? `Attachment names: ${record.attachments.join(", ")}` : "";
      const nextRevisionSignature = JSON.stringify(record.editHistory || []);
      if (nextRevisionSignature !== revisionSignature) {
        revisionSignature = nextRevisionSignature;
        revisionDisposers.forEach((dispose) => dispose());
        revisionDisposers = [];
        revisions.replaceChildren(...(record.editHistory || []).map((revision, index) => {
        const section = document.createElement("section");
        section.className = "record__revision";
        section.setAttribute("role", "note");
        const label = document.createElement("strong");
        label.textContent = `EDITED VERSION ${index + 1} · ${formatDate(revision.supersededAt)}`;
        const priorContent = document.createElement("p");
        priorContent.textContent = revision.content || "No text content";
        priorContent.hidden = !revision.content;
        section.append(label, priorContent);
        if (revision.attachments?.length && !revision.media?.length) {
          const priorAttachments = document.createElement("p");
          priorAttachments.className = "record__revision-attachments";
          priorAttachments.textContent = `Attachment names: ${revision.attachments.join(", ")}`;
          section.append(priorAttachments);
        }
        if (revision.media?.length) {
          const created = mediaFrame(key, revision.revisionId, `Cached media from edited version ${index + 1}`);
          created.frame.classList.add("record__revision-media");
          section.append(created.frame);
          revisionDisposers.push(created.dispose);
        }
        return section;
        }));
      }
      if (record.media?.length) {
        const nextMediaSignature = JSON.stringify(Core.sanitizeMediaItems(record.media));
        if (frame && currentMediaSignature !== nextMediaSignature) {
          disposeFrame?.();
          frame.remove();
          frame = null;
          disposeFrame = null;
        }
        currentMediaSignature = nextMediaSignature;
        const mediaFrame = ensureMediaFrame();
        mediaFrame.hidden = false;
        mediaFrame.title = `Cached media from ${record.author || "message author"}`;
      } else {
        currentMediaSignature = "";
        if (frame) frame.hidden = true;
      }
    }

    update(initialRecord);
    return {
      element: article,
      update,
      dispose() {
        revisionDisposers.forEach((dispose) => dispose());
        revisionDisposers = [];
        disposeFrame?.();
      }
    };
  }

  function render() {
    const filtered = Core.searchRecords(archive.records, search.value, statusFilter.value);
    const liveKeys = new Set(archive.records.map(Core.recordKey));
    for (const [key, view] of recordViews) {
      if (liveKeys.has(key)) continue;
      view.dispose();
      view.element.remove();
      recordViews.delete(key);
    }
    const visibleKeys = new Set(filtered.map(Core.recordKey));
    filtered.forEach((record, index) => {
      const key = Core.recordKey(record);
      let view = recordViews.get(key);
      if (!view) {
        view = createRecordView(record);
        recordViews.set(key, view);
        recordsElement.append(view.element);
      } else view.update(record);
      view.element.hidden = false;
      view.element.style.order = String(index);
    });
    for (const [key, view] of recordViews) {
      if (!visibleKeys.has(key)) view.element.hidden = true;
    }
    empty.hidden = filtered.length !== 0;
    summary.textContent = `${filtered.length} of ${archive.records.length} records`;
  }

  async function deleteOne(record) {
    const response = await send({ type: T.DELETE_RECORD, key: Core.recordKey(record) });
    if (response.archive) archive = response.archive;
    render();
  }

  function exportJson() {
    const exportMedia = (media) => Core.sanitizeMediaItems(media).map((item) => Object.assign({}, item, {
        url: Core.exportMediaUrl(item.url),
        posterUrl: item.posterUrl ? Core.exportMediaUrl(item.posterUrl) : undefined
      }));
    const records = archive.records.map((record) => Object.assign({}, record, {
      media: exportMedia(record.media),
      editHistory: (record.editHistory || []).map((revision) => Object.assign({}, revision, {
        media: exportMedia(revision.media)
      }))
    }));
    const payload = {
      exportedAt: new Date().toISOString(),
      source: "BridgeModTools",
      note: "Retained deletions were preserved in Discord's local MessageStore; lifecycle deletions correlate a local signal with row removal; suspected removals use conservative DOM observation.",
      records
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `discord-local-message-history-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  search.addEventListener("input", render);
  statusFilter.addEventListener("change", render);
  exportButton.addEventListener("click", exportJson);
  clearButton.addEventListener("click", async () => {
    if (!confirm("Permanently delete every local record?")) return;
    const response = await send({ type: T.CLEAR_ARCHIVE });
    if (response.archive) archive = response.archive;
    render();
  });

  function connectUpdates() {
    const port = chrome.runtime.connect({ name: "ldma-updates" });
    port.onMessage.addListener((message) => {
      if (message.type === "LDMA_ARCHIVE_CHANGED") refresh().then(render).catch(() => {});
    });
    port.onDisconnect.addListener(() => setTimeout(connectUpdates, 500));
  }
  connectUpdates();
  refresh().then(render).catch(() => {
    empty.hidden = false;
    empty.textContent = "Could not reach the local archive broker.";
  });
})();
