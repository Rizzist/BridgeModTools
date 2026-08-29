"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const history = fs.readFileSync(path.join(root, "history", "history.js"), "utf8");
const historyCss = fs.readFileSync(path.join(root, "history", "history.css"), "utf8");
const historyHtml = fs.readFileSync(path.join(root, "history", "history.html"), "utf8");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

test("history renders one structured reply header before every version payload", () => {
  assert.match(history, /let archive = \{ version: 6,/);
  assert.match(history, /function updateReply\(value\)/);
  assert.match(history, /function resolvedReply\(record, recordsByKey\)/);
  assert.match(history, /const recordsByKey = new Map/);
  const resolverStart = history.indexOf("function resolvedReply(");
  const resolverEnd = history.indexOf("function createRecordView(", resolverStart);
  const resolver = history.slice(resolverStart, resolverEnd);
  assert.match(resolver, /recordsByKey\?\.get/);
  assert.equal(/archive\.records\.(?:find|filter)/.test(resolver), false,
    "each reply must resolve from the one per-render archive map");
  assert.match(history, /updateReply\(nextReply\)/);
  assert.match(history, /Core\.sanitizeReply\(record\?\.reply, record\?\.replyPreview\)/);
  assert.match(history, /reply\.state === "deleted" \|\| Core\.isDeletedStatus\(target\.status\)/);
  assert.match(history, /article\.append\(top, replyView, revisions, content, attachments\)/);
  assert.equal((history.match(/article\.append\(top, replyView, revisions, content, attachments\)/g) || []).length, 1);
  assert.match(history, /String\(reply\.content \|\| ""\)/);
  assert.match(history, /String\(reply\.fallbackText \|\| ""\)/);
  assert.match(history, /reply\.attachmentNames/);
  assert.match(history, /Core\.sanitizeMediaItems\(reply\.media\)/);
  assert.match(history, /Core\.safeDiscordAssetUrl\(reply\.avatarUrl\)/);
  assert.match(history, /Core\.safePresentationColor\(reply\.authorColor\)/);
  for (const state of ["deleted", "unavailable", "unknown", "legacy"]) {
    assert.match(history, new RegExp(`state === ["']${state}["']`));
  }
  assert.equal(/state === ["'](?:resolved|edited)["']/.test(history), false);
  assert.equal(/innerHTML/.test(history), false);
});

test("history exports reply media and avatar URLs through the safe URL helpers", () => {
  const start = history.indexOf("const exportReply =");
  const end = history.indexOf("const records =", start);
  assert.notEqual(start, -1);
  assert.ok(end > start);
  const exportReply = history.slice(start, end);
  assert.match(exportReply, /media: exportMedia\(safeReply\.media\)/);
  assert.match(exportReply, /Core\.safeDiscordAssetUrl\(safeReply\.avatarUrl\)/);
  assert.match(exportReply, /Core\.exportMediaUrl\(avatarUrl\)/);
  assert.match(history, /reply: exportReply\(record\.reply\)/);
  assert.match(history, /archiveVersion: archive\.version/);
  assert.equal(/mediaFrame\([^\n]*reply/i.test(history), false,
    "compact reply previews must not create a second media player");
});

test("history reply styling and documentation preserve Discord-like structure and v5 migration truth", () => {
  assert.match(historyCss, /\.record__reply::before/);
  assert.match(historyCss, /border-top:\s*2px solid/);
  assert.match(historyCss, /border-left:\s*2px solid/);
  assert.match(historyCss, /\.record__reply-avatar/);
  assert.match(historyCss, /\.record__reply\[data-state="deleted"\]/);
  assert.match(historyCss, /text-overflow:\s*ellipsis/);
  assert.match(historyHtml, /compact reply header is preserved once above the message/);

  assert.match(readme, /archive schema v6 preserve[s]? Discord replies as structured/i);
  for (const field of [
    "messageId", "channelId", "guildId", "author", "authorId", "authorUsername",
    "avatarUrl", "authorColor", "content", "fallbackText", "attachmentNames", "media", "state"
  ]) assert.match(readme, new RegExp(`\\b${field}\\b`));
  assert.match(readme, /Schema v5 records containing only `replyPreview` migrate to `reply\.fallbackText`/);
  assert.match(readme, /at most four rows or five milliseconds per frame/);
  assert.match(readme, /no eager broker lookup per row/);
  assert.match(readme, /reply-only updates do not rebuild edit history or reload cached media players/);
});
