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

test("manifest is MV3 with bounded local-media permissions and a narrow Discord match", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, "133");
  assert.deepEqual(manifest.permissions, ["storage", "offscreen", "unlimitedStorage"]);
  assert.deepEqual(manifest.host_permissions, [
    "https://cdn.discordapp.com/*",
    "https://media.discordapp.net/*",
    "https://images-ext-1.discordapp.net/*",
    "https://images-ext-2.discordapp.net/*"
  ]);
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);
  assert.equal(manifest.host_permissions.includes("https://*/*"), false);
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://discord.com/channels/*"]);
  assert.deepEqual(manifest.content_scripts[0].js, ["src/page-hook.js"]);
  assert.equal(manifest.content_scripts[0].world, "MAIN");
  assert.equal(manifest.content_scripts[0].run_at, "document_start");
  assert.deepEqual(manifest.content_scripts[1].matches, ["https://discord.com/channels/*"]);
  assert.equal(manifest.version, "2.2.0");
  assert.equal(manifest.web_accessible_resources.length, 1);
  assert.deepEqual(manifest.web_accessible_resources[0].matches, ["https://discord.com/*"]);
  assert.equal(manifest.web_accessible_resources[0].use_dynamic_url, true);
  assert.deepEqual(manifest.web_accessible_resources[0].resources, [
    "media/view.html", "media/view.css", "media/view.js",
    "src/core.js", "src/protocol.js", "src/media-store.js"
  ]);
  assert.match(manifest.content_security_policy.extension_pages, /media-src 'self' blob:/);
  assert.match(manifest.content_security_policy.extension_pages, /frame-ancestors 'self' https:\/\/discord\.com/);
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
  assert.match(content, /function groupRootFromNode/);
  assert.match(content, /message-content-\$\{messageId\}/);
  assert.match(content, /groupRootMessageId/);
  assert.match(content, /sourceContinuation/);
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
  assert.match(content, /allowAnchorless: placementRows\.length === 0/);
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
  assert.match(content, /const renderer = state\.tombstoneRenderers\.get\(key\)[\s\S]*renderer\(record\)/);
  assert.match(content, /authorNameElement/);
  assert.match(content, /Core\.sanitizeRecordPresentation/);
  assert.match(content, /author\.animate/);
  assert.match(content, /authorBadges/);
  assert.match(content, /scheduleTombstoneSpacing/);
  assert.match(content, /Core\.balancedTombstoneShift/);
  assert.match(content, /pendingReleaseKeys/);
  assert.match(content, /confirmRetainedDeletion[\s\S]*mountConfirmedFromSnapshots\(channelId, deletions\)/);
  assert.match(content, /Core\.tombstoneInRenderedRange/);
  assert.match(content, /outsideRenderedRange/);
  assert.match(content, /candidate !== element/);
  assert.match(content, /\.moveBefore\(element,/);
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
  assert.match(content, /function mountConfirmedFromSnapshots[\s\S]*const nativeRow = findMessage[\s\S]*insertTombstone\(archived, placement, nativeRow\)[\s\S]*nativeRow\.dataset\.ldmaNativeReplaced = "true"/);
  assert.match(content, /insertTombstone\(record, Object\.assign/);
  assert.match(content, /const mount = document\.createElement\("div"\)[\s\S]*host\.append\(mount\)[\s\S]*mount\.attachShadow\(\{ mode: "closed" \}\)/);
  assert.equal(/host\.attachShadow/.test(content), false);
  assert.match(content, /createElement\("iframe"\)/);
  assert.match(content, /chrome\.runtime\.getURL\("media\/view\.html"\)/);
  assert.match(content, /function extensionFrameOrigin/);
  assert.match(content, /`chrome-extension:\/\/\$\{chrome\.runtime\.id\}`/);
  assert.match(content, /extensionFrameOrigin\(\)/);
  assert.match(content, /allow-scripts allow-same-origin/);
  assert.match(content, /replaceText\(content, record\.content/);
  assert.match(content, /attachments\.replaceChildren/);
  assert.match(content, /state\.tombstoneRenderers\.delete/);
  assert.match(content, /function findEmptyConfirmedRestoreList/);
  assert.match(content, /outsideActiveList/);
  assert.match(content, /active\.node\?\.contains\(element\)/);
  assert.match(content, /retainedRow\(route\.channelId, record\.messageId, active\.node\)/);
  assert.match(content, /Core\.anchorlessRestoreAllowed/);
  assert.match(content, /outsideRenderedRange/);
  assert.match(content, /element\.dataset\.ldmaEmptyRestore = "true"/);
  assert.match(content, /function nativeRangeSignature/);
  assert.match(content, /function anchorlessMountIsCurrent/);
  assert.match(content, /const tailAuthorized = Boolean\(record\.inferredTail && atBottom && newestLiveId/);
  assert.match(content, /if \(anchorlessAuthorized \|\| tailAuthorized \|\| replacementNode\)/);
  assert.match(content, /element\.dataset\.ldmaAnchorlessEpoch = String\(state\.anchorlessEpoch\)/);
  assert.match(content, /element\.dataset\.ldmaAnchorlessRange = nativeRangeSignature\(active\)/);
  assert.match(content, /element\.dataset\.ldmaMountKind = active\.rows\.length === 0/);
  assert.match(content, /element\.dataset\.ldmaMountKind === "empty"/);
  assert.match(content, /!anchorlessMountIsCurrent\(element, active\)/);
  assert.match(content, /nativeRow\.dataset\.ldmaNativeReplaced === "true" \|\| rowRect\.height <= 0/);
  assert.match(content, /event\?\.type === "wheel" \|\| event\?\.type === "touchmove"/);
  assert.match(content, /function reconcileTombstoneGrouping/);
  assert.match(content, /Core\.messageContinues\(previous, record\)/);
  assert.match(content, /capturedRoot && capturedRoot !== record\.messageId/);
  assert.match(content, /Core\.messageContinues\(previous, record, \{ ignoreGroupRoot: true \}\)/);
  assert.match(content, /Native Discord rows are presentation-authoritative/);
  assert.equal(/setNativeContinuation/.test(content), false);
  assert.match(content, /render\.setContinuation/);
  assert.match(content, /host\.dataset\.ldmaContinuation = String\(continuation\)/);
  assert.match(content, /\.message\.continuation \{ min-height:22px; padding-block:0; \}/);
  assert.match(content, /\.message\.continuation \.avatar,.message\.continuation \.header \{ display:none; \}/);
  assert.match(content, /new CSSStyleSheet\(\)/);
  assert.match(content, /shadow\.adoptedStyleSheets = \[sheet\]/);
  for (const field of ["avatarUrl", "authorColor", "displayTimestamp", "replyPreview"]) {
    assert.match(content, new RegExp(field));
  }

  assert.match(hostCss, /\[data-ldma-native-replaced="true"\]/);
  assert.match(hostCss, /display:\s*none\s*!important/);
  assert.equal(/ldma-native-continuation-after-tombstone/.test(hostCss), false);
  assert.equal(/ldma-native-group-hidden/.test(hostCss), false);
  assert.match(hostCss, /\.ldma-tombstone__mount/);
  assert.match(content, /grid-template-columns:40px minmax\(0,1fr\)/);
  assert.match(content, /min-height:48px/);
  assert.match(content, /deleted\.textContent = "• DELETED"/);
  assert.match(content, /else renderer\(record\)[\s\S]*scheduleTombstoneSpacing\(\)/);
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

test("history targets the chrome-extension scheme and host for media capabilities", () => {
  const history = fs.readFileSync(path.join(root, "history", "history.js"), "utf8");
  assert.match(history, /function extensionFrameOrigin/);
  assert.match(history, /extensionFrameOrigin\(\)/);
  assert.equal(/new URL\(frame\.src\)\.origin/.test(history), false);
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

test("only the bounded media store uses network and Cache Storage primitives", () => {
  const javascript = filesBelow(root).filter((file) => file.endsWith(".js") && !file.includes(`${path.sep}tests${path.sep}`));
  const alwaysForbidden = [
    /\bXMLHttpRequest\b/,
    /\bWebSocket\b/,
    /document\.cookie/,
    /chrome\.cookies/,
    /localStorage/,
    /sessionStorage/,
    /Authorization/i
  ];
  for (const file of javascript) {
    execFileSync(process.execPath, ["--check", file]);
    const source = fs.readFileSync(file, "utf8");
    for (const pattern of alwaysForbidden) {
      assert.equal(pattern.test(source), false, `${path.relative(root, file)} matched ${pattern}`);
    }
    if (path.basename(file) !== "media-store.js") {
      assert.equal(/\bfetch\s*\(/.test(source), false, `${path.relative(root, file)} performs a fetch`);
      assert.equal(/caches\.open/.test(source), false, `${path.relative(root, file)} opens Cache Storage`);
    }
  }
  const mediaStore = fs.readFileSync(path.join(root, "src", "media-store.js"), "utf8");
  assert.match(mediaStore, /credentials:\s*"omit"/);
  assert.match(mediaStore, /referrerPolicy:\s*"no-referrer"/);
  assert.match(mediaStore, /cross-origin-redirect/);
  assert.match(mediaStore, /maxAssetBytes:\s*32 \* 1024 \* 1024/);
  assert.match(mediaStore, /maxTotalBytes:\s*512 \* 1024 \* 1024/);
  assert.match(mediaStore, /concurrency:\s*1/);
  assert.match(mediaStore, /GENERATION_KEY/);
  assert.match(mediaStore, /jobGeneration/);
  assert.match(mediaStore, /refsNeedingCache/);
  assert.match(mediaStore, /TransformStream/);
  assert.match(mediaStore, /streamAssetToCache/);
  assert.match(mediaStore, /maxTotalBytes:\s*Math\.max\(0, settings\.maxTotalBytes - settings\.maxAssetBytes\)/);
});

test("media capture, cache broker, offscreen downloader, and local player are packaged", () => {
  const content = fs.readFileSync(path.join(root, "src", "content.js"), "utf8");
  const background = fs.readFileSync(path.join(root, "src", "background.js"), "utf8");
  const viewer = fs.readFileSync(path.join(root, "media", "view.js"), "utf8");
  const viewerCss = fs.readFileSync(path.join(root, "media", "view.css"), "utf8");
  const history = fs.readFileSync(path.join(root, "history", "history.js"), "utf8");
  const offscreen = fs.readFileSync(path.join(root, "media", "offscreen.js"), "utf8");
  const popup = fs.readFileSync(path.join(root, "popup", "popup.js"), "utf8");
  assert.match(content, /function captureMedia/);
  assert.match(content, /img, video, audio, source\[src\], source\[srcset\]/);
  assert.match(content, /getAttribute\("srcset"\)/);
  assert.match(content, /T\.CACHE_MEDIA/);
  assert.match(content, /record\.media/);
  assert.match(content, /element\.currentSrc,[\s\S]*element\.getAttribute\("src"\)/);
  assert.match(content, /requestMediaRecovery/);
  assert.match(content, /embedProvider_/);
  assert.match(content, /actionRow_/);
  assert.match(background, /chrome\.offscreen\.createDocument/);
  assert.match(background, /discordContentSender/);
  assert.match(background, /chrome\.permissions\.contains/);
  assert.match(background, /MediaStore\.reconcileArchive/);
  assert.match(background, /CREATE_MEDIA_CAPABILITY/);
  assert.match(background, /REDEEM_MEDIA_CAPABILITY/);
  assert.match(background, /MediaStore\.setGeneration/);
  assert.match(background, /chrome\.offscreen\.closeDocument/);
  assert.match(background, /mediaMetadataQueue/);
  assert.match(background, /mutateMediaMetadata/);
  assert.match(background, /untrusted-command-sender/);
  assert.match(viewer, /URL\.createObjectURL/);
  assert.match(viewer, /URL\.revokeObjectURL/);
  assert.match(viewer, /video\.controls = true/);
  assert.match(viewer, /audio\.controls = true/);
  assert.match(viewer, /video\.autoplay = false/);
  assert.match(viewer, /details\.className = "spoiler"/);
  assert.match(viewer, /LDMA_MEDIA_CAPABILITY/);
  assert.equal(/URLSearchParams/.test(viewer), false);
  assert.equal(/postMessage\([^)]*,\s*["']\*["']/.test(viewer), false);
  assert.equal(/Promise\.all/.test(viewer), false);
  assert.equal(/innerHTML/.test(viewer), false);
  assert.match(viewerCss, /\.pager/);
  assert.match(viewerCss, /overflow:\s*auto/);
  assert.match(history, /Core\.exportMediaUrl/);
  assert.match(history, /recordViews/);
  assert.equal(/recordsElement\.replaceChildren/.test(history), false);
  assert.match(offscreen, /skipPrune:\s*true/);
  assert.match(popup, /chrome\.permissions\.request/);
  assert.match(popup, /missingMediaOrigins\.map/);
  for (const relative of ["media/view.html", "media/view.css", "media/view.js", "media/offscreen.html", "media/offscreen.js", "src/media-store.js"]) {
    assert.equal(fs.existsSync(path.join(root, relative)), true, `${relative} is missing`);
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
