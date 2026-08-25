"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");

function filesBelow(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(full) : [full];
  });
}

test("manifest is MV3 with storage as its only permission and a narrow Discord match", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://discord.com/channels/*"]);
  assert.deepEqual(manifest.content_scripts[0].js, ["src/page-hook.js"]);
  assert.equal(manifest.content_scripts[0].world, "MAIN");
  assert.equal(manifest.content_scripts[0].run_at, "document_start");
  assert.deepEqual(manifest.content_scripts[1].matches, ["https://discord.com/channels/*"]);
  assert.equal(manifest.version, "1.9.0");
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.deepEqual(manifest.background, { service_worker: "src/background.js" });
});

test("only the serialized background broker accesses chrome storage", () => {
  const javascript = filesBelow(root).filter((file) => file.endsWith(".js") && !file.includes(`${path.sep}tests${path.sep}`));
  for (const file of javascript) {
    const source = fs.readFileSync(file, "utf8");
    if (path.basename(file) === "background.js") {
      assert.match(source, /chrome\.storage\.local\.get/);
      assert.match(source, /chrome\.storage\.local\.set/);
      assert.match(source, /brokerQueue/);
      assert.match(source, /archiveCache/);
    } else {
      assert.equal(/chrome\.storage/.test(source), false, `${path.relative(root, file)} bypasses broker`);
    }
  }
});

test("content contains retraction and tombstone reconciliation hooks", () => {
  const content = fs.readFileSync(path.join(root, "src", "content.js"), "utf8");
  assert.match(content, /RETRACT_MESSAGE/);
  assert.match(content, /reconcileTombstones/);
  assert.match(content, /removeTombstone/);
  assert.match(content, /inferredPreviousId/);
  assert.match(content, /reappearanceGraceMs/);
  assert.match(content, /generationAtMutation/);
  assert.match(content, /pendingRecords\.set\(key, \{ record, generation: state\.generation, signature \}\)/);
  assert.match(content, /Protocol\.shouldApplyArchive/);
  assert.match(content, /snapshotRenderedMessages\(true\), 2000/);
  assert.match(content, /broker-unavailable/);
  assert.match(content, /authorFromAriaLabelledBy/);
  assert.match(content, /refreshArchive\(\).*10000/s);
  assert.match(content, /message-content-\$\{messageId\}/);
  assert.match(content, /inferredTail/);
  assert.match(content, /findChatScrollContainer/);
  assert.match(content, /CONFIRM_DELETED/);
  assert.match(content, /LDMA_BRIDGE_V1/);
  assert.match(content, /snapshotsByKey/);
  assert.match(content, /mountConfirmedFromSnapshots/);
  assert.match(content, /incomingGeneration > state\.generation/);
  assert.match(content, /state\.snapshots = new WeakMap\(\)/);
  assert.match(content, /createTombstoneRenderer/);
  assert.match(content, /message\.ids\.slice\(0, 200\)/);
  assert.match(content, /flushAllRecords/);
  assert.match(content, /recentRemovals/);
  assert.match(content, /allowAnchorless: rows\.length === 0/);
  assert.equal(/textContent\s*=\s*record\.content/.test(content), false);
  assert.equal(/response\.reason === ["']stale-generation["'][\s\S]{0,300}CONFIRM_DELETED/.test(content), false);
  assert.match(content, /const reference = next \|\| previous/);
  assert.match(content, /confirmRetainedDeletion/);
  assert.match(content, /message_store_preserved/);
  assert.match(content, /ldma-retained-deleted/);
  assert.match(content, /confirmRetainedDeletion[\s\S]*snapshotRenderedMessages\(true\);[\s\S]*await flushAllRecords/);
  assert.match(content, /findMountedTombstone/);
  assert.match(content, /Core\.chronologicalNeighborIds/);
  assert.match(content, /Core\.compareSnowflakeIds/);
  assert.match(content, /existingRenderer\(record\)/);
  assert.match(content, /authorNameElement/);
  assert.match(content, /Core\.sanitizeRecordPresentation/);
  assert.match(content, /author\.animate/);
  assert.match(content, /authorBadges/);
  assert.match(content, /scheduleTombstoneSpacing/);
  assert.match(content, /Core\.balancedTombstoneShift/);
  assert.match(content, /pendingReleaseKeys/);
});

test("main-world hook retains Discord MessageStore records before native deletion", () => {
  const hook = fs.readFileSync(path.join(root, "src", "page-hook.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "src", "content.css"), "utf8");
  assert.match(hook, /patchMessageStore/);
  assert.match(hook, /localArchiveRetainingDeleteHandler/);
  assert.match(hook, /message\.set\("deleted", true\)/);
  assert.match(hook, /return undefined/);
  assert.match(hook, /patchDispatcherRetention/);
  assert.match(hook, /releaseRetainedMessages/);
  assert.match(hook, /retainedKeys/);
  assert.match(css, /\.ldma-retained-deleted/);
  assert.match(css, /#f23f42/);
});

test("persistent replacements use a Discord-style row and hide the retained native copy", () => {
  const content = fs.readFileSync(path.join(root, "src", "content.js"), "utf8");
  const hostCss = fs.readFileSync(path.join(root, "src", "content.css"), "utf8");

  assert.match(content, /function replaceVisibleRetainedRows/);
  assert.match(content, /data-ldma-native-replaced/);
  assert.match(content, /if \(mounted\) nativeRow\.dataset\.ldmaNativeReplaced = "true"/);
  assert.match(content, /insertTombstone\(record, Object\.assign/);
  assert.match(content, /const mount = document\.createElement\("div"\)[\s\S]*host\.append\(mount\)[\s\S]*mount\.attachShadow\(\{ mode: "closed" \}\)/);
  assert.equal(/host\.attachShadow/.test(content), false);
  assert.equal(/createElement\("iframe"\)/.test(content), false);
  assert.match(content, /replaceText\(content, record\.content/);
  assert.match(content, /attachments\.replaceChildren/);
  assert.match(content, /state\.tombstoneRenderers\.delete/);
  assert.match(content, /function findEmptyConfirmedRestoreList/);
  assert.match(content, /outsideActiveList/);
  assert.match(content, /active\.node\?\.contains\(existing\)/);
  assert.match(content, /retainedRow\(route\.channelId, record\.messageId, active\.node\)/);
  assert.match(content, /Core\.anchorlessRestoreAllowed/);
  assert.match(content, /needsRangeRevalidation/);
  assert.match(content, /element\.dataset\.ldmaEmptyRestore = "true"/);
  assert.match(content, /new CSSStyleSheet\(\)/);
  assert.match(content, /shadow\.adoptedStyleSheets = \[sheet\]/);
  for (const field of ["avatarUrl", "authorColor", "displayTimestamp", "replyPreview"]) {
    assert.match(content, new RegExp(field));
  }

  assert.match(hostCss, /\[data-ldma-native-replaced="true"\]/);
  assert.match(hostCss, /display:\s*none\s*!important/);
  assert.match(hostCss, /\.ldma-tombstone__mount/);
  assert.match(content, /grid-template-columns:40px minmax\(0,1fr\)/);
  assert.match(content, /min-height:48px/);
  assert.match(content, /deleted\.textContent = "• DELETED"/);
  assert.match(content, /existingRenderer\(record\);\s*scheduleTombstoneSpacing\(\)/);
  assert.match(content, /author-group/);
  assert.match(content, /badges\.replaceChildren/);
  assert.match(content, /reducedMotion\.addEventListener/);
  assert.match(content, /render\.dispose/);
  assert.equal(/innerHTML/.test(content), false);
});

test("popup and history reconnect their broker update ports", () => {
  for (const relative of ["popup/popup.js", "history/history.js"]) {
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    assert.match(source, /function connectUpdates/);
    assert.match(source, /port\.onDisconnect\.addListener/);
  }
});

test("popup exposes saved-deletion counts and local search without unsafe HTML rendering", () => {
  const html = fs.readFileSync(path.join(root, "popup", "popup.html"), "utf8");
  const source = fs.readFileSync(path.join(root, "popup", "popup.js"), "utf8");
  assert.match(html, /id="deleted-count"/);
  assert.match(html, /id="search" type="search"/);
  assert.match(html, /id="search-results"/);
  assert.match(source, /Core\.searchRecords/);
  assert.match(source, /Core\.isDeletedStatus/);
  assert.match(source, /replaceChildren/);
  assert.equal(/innerHTML/.test(source), false);
});

test("shipped JavaScript parses and contains no network, token, cookie, or cache primitives", () => {
  const javascript = filesBelow(root).filter((file) => file.endsWith(".js") && !file.includes(`${path.sep}tests${path.sep}`));
  const forbidden = [
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /\bWebSocket\b/,
    /document\.cookie/,
    /chrome\.cookies/,
    /caches\.open/,
    /localStorage/,
    /sessionStorage/,
    /Authorization/i,
    /["']https?:\/\//
  ];
  for (const file of javascript) {
    execFileSync(process.execPath, ["--check", file]);
    const source = fs.readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      assert.equal(pattern.test(source), false, `${path.relative(root, file)} matched ${pattern}`);
    }
  }
});

test("extension pages use only packaged scripts and no inline handlers", () => {
  const htmlFiles = filesBelow(root).filter((file) => file.endsWith(".html"));
  for (const file of htmlFiles) {
    const html = fs.readFileSync(file, "utf8");
    assert.equal(/<script[^>]+src=["']https?:/i.test(html), false);
    assert.equal(/\son[a-z]+\s*=/i.test(html), false);
  }
});

test("deterministic demo and user documentation are present", () => {
  assert.equal(fs.existsSync(path.join(root, "demo", "index.html")), true);
  assert.equal(fs.existsSync(path.join(root, "README.md")), true);
});

test("live Discord DOM fixture covers route variants, current rows, and grouped ARIA authors", () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(root, "tests", "fixtures", "live-discord-dom.json"), "utf8"));
  for (const route of fixture.routes) {
    const parsed = require("../src/core.js").parseDiscordRoute(route.pathname);
    assert.equal(parsed.guildId, route.guildId);
    assert.equal(parsed.channelId, route.channelId);
  }
  const Core = require("../src/core.js");
  assert.equal(fixture.liveList.tag, "OL");
  assert.equal(fixture.liveList.dataListId, "chat-messages");
  assert.equal(fixture.liveList.row.tag, "LI");
  assert.deepEqual(Core.parseMessageRowIdentity(fixture.liveList.row.id), fixture.liveList.expectedIdentity);
  assert.equal(fixture.liveList.row.article.role, "article");
  assert.deepEqual(Core.parseMessageRowIdentity(fixture.liveList.row.article.dataListItemId), fixture.liveList.expectedIdentity);
  assert.equal(Core.messageUsernameLabelId(fixture.grouped.secondRowAriaLabelledBy), fixture.grouped.firstUsernameId);
});
