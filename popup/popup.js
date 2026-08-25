(function runPopup() {
  "use strict";

  const T = globalThis.LocalDiscordArchiveProtocol.TYPES;
  const paused = document.getElementById("paused");
  const pauseHelp = document.getElementById("pause-help");
  const recordCount = document.getElementById("record-count");
  const deletedCount = document.getElementById("deleted-count");
  const clearButton = document.getElementById("clear");
  const status = document.getElementById("status");
  const health = document.getElementById("health");
  const search = document.getElementById("search");
  const searchResults = document.getElementById("search-results");
  const searchEmpty = document.getElementById("search-empty");
  const searchSummary = document.getElementById("search-summary");
  const Core = globalThis.LocalDiscordArchiveCore;
  let currentArchive = { records: [] };

  function send(command) {
    return chrome.runtime.sendMessage(command);
  }

  function formatDate(value) {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.valueOf()) ? date.toLocaleString() : "Time unavailable";
  }

  function resultCard(record) {
    const card = document.createElement("article");
    card.className = "search-result";
    card.setAttribute("role", "listitem");

    const top = document.createElement("div");
    top.className = "search-result__top";
    const author = document.createElement("strong");
    author.textContent = record.author || "Unknown author";
    const badge = document.createElement("span");
    badge.textContent = record.deletionSource === "message_store_preserved" ? "retained" : "deleted";
    top.append(author, badge);

    const content = document.createElement("p");
    content.className = "search-result__content";
    content.textContent = record.content || (record.attachments?.length ? `[Attachments: ${record.attachments.join(", ")}]` : "No text content");

    const meta = document.createElement("p");
    meta.className = "search-result__meta";
    meta.textContent = `${record.channelName || record.channelId || "Unknown channel"} · ${formatDate(record.confirmedDeletedAt || record.inferredDeletedAt || record.updatedAt)}`;
    card.append(top, content, meta);
    return card;
  }

  function renderSearch() {
    const deleted = currentArchive.records.filter((record) => Core.isDeletedStatus(record.status));
    const matches = Core.searchRecords(deleted, search.value, "all").slice(0, 20);
    searchSummary.textContent = search.value
      ? `${matches.length} match${matches.length === 1 ? "" : "es"}`
      : `${deleted.length} saved`;
    searchResults.replaceChildren(...matches.map(resultCard));
    searchEmpty.hidden = matches.length !== 0;
    searchEmpty.textContent = deleted.length
      ? "No saved deleted messages match that search."
      : "No saved deleted messages yet.";
  }

  function render(archive) {
    currentArchive = archive;
    const records = Array.isArray(archive.records) ? archive.records : [];
    paused.checked = Boolean(archive.paused);
    pauseHelp.textContent = archive.paused ? "Paused — existing history is retained" : "Active on supported Discord channel pages";
    recordCount.textContent = String(records.length);
    deletedCount.textContent = String(records.filter((record) => Core.isDeletedStatus(record.status)).length);
    const currentHealth = archive.health || { status: "starting", detail: "Waiting for Discord." };
    const healthState = currentHealth.status;
    health.dataset.state = healthState;
    health.textContent = `${healthState === "active" ? "Active" : "Degraded"}: ${currentHealth.detail}`;
    renderSearch();
  }

  async function refresh() {
    const response = await send({ type: T.GET_ARCHIVE });
    if (response.archive) render(response.archive);
  }

  paused.addEventListener("change", async () => {
    const response = await send({ type: T.SET_PAUSED, paused: paused.checked });
    if (response.archive) render(response.archive);
    status.textContent = paused.checked ? "Capture paused." : "Capture resumed.";
  });

  clearButton.addEventListener("click", async () => {
    if (!confirm("Permanently delete all locally archived messages?")) return;
    const response = await send({ type: T.CLEAR_ARCHIVE });
    if (response.archive) render(response.archive);
    status.textContent = "Local history cleared.";
  });

  search.addEventListener("input", renderSearch);

  function connectUpdates() {
    const port = chrome.runtime.connect({ name: "ldma-updates" });
    port.onMessage.addListener((message) => {
      if (message.type === "LDMA_ARCHIVE_CHANGED") refresh().catch(() => {});
    });
    port.onDisconnect.addListener(() => setTimeout(connectUpdates, 500));
  }
  connectUpdates();
  refresh().catch(() => { status.textContent = "Could not reach the local archive broker."; });
})();
