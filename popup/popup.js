(function runPopup() {
  "use strict";

  const T = globalThis.LocalDiscordArchiveProtocol.TYPES;
  const paused = document.getElementById("paused");
  const pauseHelp = document.getElementById("pause-help");
  const recordCount = document.getElementById("record-count");
  const editedCount = document.getElementById("edited-count");
  const deletedCount = document.getElementById("deleted-count");
  const mediaCount = document.getElementById("media-count");
  const mediaBytes = document.getElementById("media-bytes");
  const mediaCacheDetail = document.getElementById("media-cache-detail");
  const mediaAccess = document.getElementById("media-access");
  const clearButton = document.getElementById("clear");
  const status = document.getElementById("status");
  const health = document.getElementById("health");
  const search = document.getElementById("search");
  const searchResults = document.getElementById("search-results");
  const searchEmpty = document.getElementById("search-empty");
  const searchSummary = document.getElementById("search-summary");
  const Core = globalThis.LocalDiscordArchiveCore;
  let currentArchive = { records: [] };
  let missingMediaOrigins = [];

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
    editedCount.textContent = String(records.filter(Core.hasEdits).length);
    deletedCount.textContent = String(records.filter((record) => Core.isDeletedStatus(record.status)).length);
    const currentHealth = archive.health || { status: "starting", detail: "Waiting for Discord." };
    const healthState = currentHealth.status;
    health.dataset.state = healthState;
    health.textContent = `${healthState === "active" ? "Active" : "Degraded"}: ${currentHealth.detail}`;
    renderSearch();
  }

  function formatBytes(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
  }

  async function refreshMediaStats() {
    const response = await send({ type: T.GET_MEDIA_STATS });
    const stats = response.stats || { cached: 0, bytes: 0, origins: [] };
    mediaCount.textContent = String(stats.cached || 0);
    mediaBytes.textContent = formatBytes(stats.bytes);
    missingMediaOrigins = [];
    for (const origin of stats.origins || []) {
      const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
      if (!granted) missingMediaOrigins.push(origin);
    }
    mediaAccess.hidden = missingMediaOrigins.length === 0;
    mediaAccess.textContent = `Allow ${missingMediaOrigins.length} external media site${missingMediaOrigins.length === 1 ? "" : "s"}`;
    const missingHosts = missingMediaOrigins.map((origin) => new URL(origin).hostname).join(", ");
    mediaCacheDetail.textContent = missingMediaOrigins.length
      ? `${stats.permissionRequired || missingMediaOrigins.length} item(s) are waiting for permission: ${missingHosts}.`
      : `${stats.cached || 0} cached · ${stats.pending || 0} downloading · ${stats.failed || 0} failed`;
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

  mediaAccess.addEventListener("click", async () => {
    if (!missingMediaOrigins.length) return;
    const granted = await chrome.permissions.request({ origins: missingMediaOrigins.map((origin) => `${origin}/*`) });
    if (!granted) {
      status.textContent = "External media permission was not granted.";
      return;
    }
    status.textContent = "Caching external media…";
    await send({ type: T.CACHE_ALL_MEDIA });
    await refreshMediaStats();
    status.textContent = "External media caching enabled for the selected sites.";
  });

  search.addEventListener("input", renderSearch);

  function connectUpdates() {
    const port = chrome.runtime.connect({ name: "ldma-updates" });
    port.onMessage.addListener((message) => {
      if (message.type === "LDMA_ARCHIVE_CHANGED") refresh().catch(() => {});
      if (message.type === "LDMA_MEDIA_CHANGED") refreshMediaStats().catch(() => {});
    });
    port.onDisconnect.addListener(() => setTimeout(connectUpdates, 500));
  }
  connectUpdates();
  Promise.all([refresh(), refreshMediaStats()]).catch(() => { status.textContent = "Could not reach the local archive broker."; });
})();
