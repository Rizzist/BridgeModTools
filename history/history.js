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
  let archive = { version: 3, generation: 0, paused: false, records: [] };

  function send(command) {
    return chrome.runtime.sendMessage(command);
  }

  async function refresh() {
    const response = await send({ type: T.GET_ARCHIVE });
    if (response.archive) archive = response.archive;
  }

  function formatDate(value) {
    if (!value) return "Time unavailable";
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? "Time unavailable" : date.toLocaleString();
  }

  function createRecord(record) {
    const deleted = Core.isDeletedStatus(record.status);
    const confirmed = record.status === "confirmed_deleted";
    const article = document.createElement("article");
    article.className = `record${deleted ? " deleted" : ""}`;
    const top = document.createElement("div");
    top.className = "record__top";
    const heading = document.createElement("div");
    const author = document.createElement("div");
    author.className = "record__author";
    author.textContent = record.author || "Unknown author";
    const meta = document.createElement("div");
    meta.className = "record__meta";
    const badge = document.createElement("span");
    badge.className = `badge${deleted ? " deleted" : ""}`;
    badge.textContent = record.deletionSource === "message_store_preserved"
      ? "Retained deleted"
      : confirmed ? "Lifecycle + removal" : record.status === "inferred_deleted" ? "Possibly removed" : "Seen";
    meta.append(badge, document.createTextNode(`${record.channelName || record.channelId || "Unknown channel"} · ${formatDate(record.messageTimestamp || record.capturedAt)}`));
    heading.append(author, meta);
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "record__delete";
    deleteButton.textContent = "Delete record";
    deleteButton.addEventListener("click", () => deleteOne(record));
    top.append(heading, deleteButton);
    article.append(top);
    if (record.content) {
      const content = document.createElement("p");
      content.className = "record__content";
      content.textContent = record.content;
      article.append(content);
    }
    if (record.attachments?.length) {
      const attachments = document.createElement("p");
      attachments.className = "record__attachments";
      attachments.textContent = `Attachment names: ${record.attachments.join(", ")}`;
      article.append(attachments);
    }
    return article;
  }

  function render() {
    const filtered = Core.searchRecords(archive.records, search.value, statusFilter.value);
    recordsElement.replaceChildren(...filtered.map(createRecord));
    empty.hidden = filtered.length !== 0;
    summary.textContent = `${filtered.length} of ${archive.records.length} records`;
  }

  async function deleteOne(record) {
    const response = await send({ type: T.DELETE_RECORD, key: Core.recordKey(record) });
    if (response.archive) archive = response.archive;
    render();
  }

  function exportJson() {
    const payload = {
      exportedAt: new Date().toISOString(),
      source: "BridgeModTools",
      note: "Retained deletions were preserved in Discord's local MessageStore; lifecycle deletions correlate a local signal with row removal; suspected removals use conservative DOM observation.",
      records: archive.records
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
