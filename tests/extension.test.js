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

test("manifest is MV3 with bounded media access and route-safe Discord bootstrap permissions", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, "133");
  assert.deepEqual(manifest.permissions, ["storage", "offscreen", "unlimitedStorage", "scripting", "webNavigation", "clipboardWrite"]);
  assert.equal(manifest.permissions.includes("clipboardRead"), false);
  assert.deepEqual(manifest.host_permissions, [
    "https://discord.com/*",
    "https://cdn.discordapp.com/*",
    "https://media.discordapp.net/*",
    "https://images-ext-1.discordapp.net/*",
    "https://images-ext-2.discordapp.net/*"
  ]);
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);
  assert.equal(manifest.host_permissions.includes("https://*/*"), false);
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://discord.com/*"]);
  assert.deepEqual(manifest.content_scripts[0].js, ["src/page-hook.js"]);
  assert.equal(manifest.content_scripts[0].world, "MAIN");
  assert.equal(manifest.content_scripts[0].run_at, "document_start");
  assert.deepEqual(manifest.content_scripts[1].matches, ["https://discord.com/*"]);
  assert.equal("css" in manifest.content_scripts[1], false);
  assert.equal(manifest.version, "2.6.7");
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

test("tagged releases are tested, version-checked, packaged, and published as latest", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "release.yml"), "utf8");
  assert.match(workflow, /tags:\s*\n\s*- "v\*"/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /require\('\.\/package\.json'\)\.version/);
  assert.match(workflow, /require\('\.\/manifest\.json'\)\.version/);
  assert.match(workflow, /BridgeModTools-\$\{GITHUB_REF_NAME\}\.zip/);
  assert.match(workflow, /sha256sum/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /--latest/);
  assert.match(workflow, /--verify-tag/);
});

test("background self-heals fresh, restored, updated, and SPA Discord documents", () => {
  const background = fs.readFileSync(path.join(root, "src", "background.js"), "utf8");
  const content = fs.readFileSync(path.join(root, "src", "content.js"), "utf8");
  const hook = fs.readFileSync(path.join(root, "src", "page-hook.js"), "utf8");

  assert.match(background, /LDMA_ENSURE_BOOTSTRAP/);
  assert.match(background, /chrome\.tabs\.query\(\{ url: \[DISCORD_TAB_PATTERN\] \}\)/);
  assert.match(background, /chrome\.scripting\.executeScript/);
  assert.match(background, /files: \["src\/page-hook\.js"\][\s\S]*world: "MAIN"/);
  assert.match(background, /PAGE_HOOK_API_VERSION = 3/);
  assert.match(background, /chrome\.storage\.session\.get\(PAGE_HOOK_RELOAD_SESSION_KEY\)/);
  assert.match(background, /if \(!await claimPageHookReload\(tabId\)\)/);
  assert.match(background, /typeof controller\.resolveMessageAuthors === "function"/);
  assert.match(background, /await chrome\.tabs\.reload\(tabId\)/);
  assert.match(background, /files: \["src\/core\.js", "src\/protocol\.js", "src\/content\.js"\][\s\S]*world: "ISOLATED"/);
  assert.match(background, /Symbol\.for\("BridgeModTools\.contentStyle\.v1"\)/);
  assert.match(background, /documentIds: \[documentId\]/);
  assert.match(background, /chrome\.webNavigation\.onCommitted\.addListener/);
  assert.match(background, /chrome\.webNavigation\.onHistoryStateUpdated\.addListener/);
  assert.match(background, /chrome\.webNavigation\.onTabReplaced\.addListener/);
  assert.match(background, /chrome\.tabs\.onActivated\.addListener/);
  assert.match(background, /chrome\.runtime\.onInstalled\.addListener/);
  assert.match(background, /chrome\.runtime\.onStartup\.addListener/);
  assert.match(background, /sender\.origin !== "https:\/\/discord\.com"/);
  assert.match(background, /url\.hostname === "discord\.com"/);
  assert.equal(/discord\.com\/channels/.test(background), false);

  assert.match(content, /Symbol\.for\("BridgeModTools\.contentScript\.v1"\)/);
  assert.match(content, /existingController[\s\S]*recover\("duplicate-injection"\)/);
  assert.match(content, /requestPageHook\("content-start"\)/);
  assert.match(content, /requestPageHook\("channel-route-entered"\)/);
  assert.match(content, /requestPageHook\("lifecycle-watchdog"\)/);
  assert.match(content, /message\.kind === "ready-request"[\s\S]*signalPageBridgeReady\(\)/);
  assert.match(content, /installPageBridge\(\);[\s\S]*await refreshArchive\(\);[\s\S]*signalPageBridgeReady\(\)/);

  assert.match(hook, /Symbol\.for\("BridgeModTools\.pageHook\.v1"\)/);
  assert.match(hook, /existingController[\s\S]*recover\("duplicate-injection"\)/);
  assert.equal(/(?:window|globalThis)\.location\.reload\s*\(/.test(hook), false);
  assert.match(hook, /scanWebpack\(requireFunction, true\)/);
  assert.match(hook, /bridgeMessage\("ready-request"\)/);
  assert.match(hook, /reconcileMessageStore/);
  assert.match(hook, /if \(!messageStorePatched\) \{[\s\S]*scanWebpack\(requireFunction\)/);
  assert.match(hook, /recoveryTicks % 4/);
  assert.match(hook, /recoveryTicks % 20/);
});

test("only the serialized background broker accesses chrome storage", () => {
  const javascript = filesBelow(root).filter((file) => file.endsWith(".js") && !file.includes(`${path.sep}tests${path.sep}`));
  for (const file of javascript) {
    const source = fs.readFileSync(file, "utf8");
    if (path.basename(file) === "background.js") {
      assert.match(source, /chrome\.storage\.local\.get/);
      assert.match(source, /chrome\.storage\.local\.set/);
      assert.match(source, /chrome\.storage\.local\.getBytesInUse/);
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
  assert.match(content, /scheduleScrollingCapture\(true\)[\s\S]*scheduleSnapshot\(true, 0\)[\s\S]*}, 2000\)/);
  assert.match(content, /Core\.createTrailingFrameScheduler/);
  assert.match(content, /Core\.createRateLimitedScheduler/);
  assert.match(content, /function rememberRecentRemovedMessages/);
  assert.match(content, /mediaFrameWindows\.get\(event\.source\)/);
  assert.match(content, /else deactivate\(\)/);
  assert.match(content, /function extensionOnlyMutation/);
  assert.match(content, /performance\.now\(\) - state\.lastScrollAt < Core\.DEFAULTS\.scrollQuietMs/);
  assert.doesNotMatch(content, /setTimeout\(\(\) => snapshotRenderedMessages\(false\), Core\.DEFAULTS\.scrollQuietMs/);
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
  assert.match(content, /function queueConfirmedMounts/);
  assert.match(content, /function drainConfirmedMounts/);
  assert.match(content, /pendingConfirmedMounts/);
  assert.match(content, /\[0, 50, 150, 350, 750, 1500, 3000, 4500, 5100\]/);
  assert.match(content, /snapshotUsable[\s\S]*currentActive/);
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
  assert.match(content, /confirmRetainedDeletion[\s\S]*queueConfirmedMounts\(channelId, deletions\)/);
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
  assert.match(content, /const shadow = host\.attachShadow\(\{ mode: "closed" \}\)/);
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
  assert.match(content, /if \(anchorlessAuthorized \|\| tailAuthorized \|\| replacementNode \|\| active\.confirmedMount\)/);
  assert.match(content, /active\.confirmedMount \? "confirmed" : "range"/);
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
  assert.match(content, /\.message\.continuation \.avatar \{ display:none; \}/);
  assert.match(content, /\.message\.continuation \.header \{ position:absolute;/);
  assert.match(content, /\.message\.continuation \.header \.author-group,.message\.continuation \.header \.timestamp \{ display:none; \}/);
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

test("live and deleted rows expose exactly two header-adjacent hover actions", () => {
  const content = fs.readFileSync(path.join(root, "src", "content.js"), "utf8");
  const hook = fs.readFileSync(path.join(root, "src", "page-hook.js"), "utf8");
  const hostCss = fs.readFileSync(path.join(root, "src", "content.css"), "utf8");

  assert.match(content, /const avatar = document\.createElement\("button"\)/);
  assert.match(content, /const author = document\.createElement\("button"\)/);
  assert.match(content, /avatar\.setAttribute\("aria-label", profileLabel\)/);
  assert.match(content, /author\.setAttribute\("aria-label", profileLabel\)/);
  assert.match(content, /function createAuthorActionControls/);
  assert.match(content, /role", "toolbar"/);
  for (const label of ["Copy Discord username", "Timeout user for 7 days"]) {
    assert.match(content, new RegExp(label));
  }
  assert.match(content, /actions\.append\(copyAction, timeoutAction, status\)/);
  assert.equal(/copyMentionAction|profileAction/.test(content), false);
  assert.match(content, /header\.append\(authorGroup, timestamp, controls\.actions\)/);
  assert.match(content, /function nativeHeaderActionInsertion/);
  assert.match(content, /`\[id="message-username-\$\{messageId\}"\]`/);
  assert.match(content, /function reconcileLiveAuthorActions/);
  assert.match(content, /reconcileLiveAuthorActions\(active, records\)/);
  assert.match(content, /function handleLiveAuthorActionInterest/);
  assert.match(content, /document\.addEventListener\("pointerover", handleLiveAuthorActionInterest, true\)/);
  assert.equal((content.match(/type: RESOLVE_MESSAGE_AUTHORS/g) || []).length, 1,
    "author resolution must occur only in the click-time resolver");
  assert.equal(/queueAuthorResolution/.test(content), false,
    "scroll-time live action rendering must not resolve authors eagerly");
  assert.match(content, /data-ldma-author-actions-host/);
  assert.match(content, /host\.attachShadow\(\{ mode: "closed" \}\)/);
  assert.match(content, /child\.matches\("\[class\*='hiddenVisually_'\], \[aria-hidden='true'\], \[data-ldma-author-actions\]"\)/);
  assert.match(content, /navigator\.clipboard\.writeText\(username\)/);
  assert.equal(/navigator\.clipboard\.read/.test(content), false);
  assert.match(content, /copyAction\.textContent = "@"/);
  assert.match(content, /function copyDiscordUsername/);
  assert.equal(/function copyUserId/.test(content), false);
  assert.match(content, /document\.execCommand\("copy"\)/);
  assert.match(content, /window\.confirm\(`Timeout \$\{author\} \(\$\{userId\}\) for 7 days\?`\)/);
  assert.match(content, /type: "LDMA_USER_ACTION",\s*action: "open-profile",\s*userId: actionUserId,\s*guildId: actionGuildId/);
  assert.match(content, /type: "LDMA_USER_ACTION",\s*action: "timeout-7d",\s*userId,\s*guildId: context\.guildId,\s*messageId: context\.messageId/);
  assert.match(content, /Core\.messageRowOwnsElement\(row, host, identity\.messageId\)/);
  assert.match(content, /pendingTimeoutActions\.has\(timeoutKey\)/);
  assert.match(content, /role", "status"/);
  assert.match(content, /aria-live", "polite"/);
  assert.match(content, /timeoutAction\.hidden = !SNOWFLAKE\.test\(String\(context\?\.guildId/);
  assert.match(content, /type: RESOLVE_MESSAGE_AUTHORS, messageIds: \[context\.messageId\]/);
  assert.match(content, /const identity = context && await resolveActionAuthorIdentity\(context, true\)/);
  assert.match(content, /let username = Core\.discordUsernameValue\(context\?\.username\)/);
  assert.match(content, /await resolveActionAuthorIdentity\(context, true\)/);
  assert.match(content, /copyDiscordUsername\(username\)/);
  assert.match(content, /Core\.boundAuthorIdentity\(resolvedUserId, resolvedUsername, fallbackUserId, fallbackUsername\)/);
  assert.match(content, /Clipboard access unavailable/);
  assert.match(content, /background independently proves/);
  assert.match(content, /function removeLiveAuthorActions/);
  assert.match(content, /removeLiveAuthorActions\(\)/);
  assert.match(hook, /const HOOK_API_VERSION = 3/);
  assert.match(hook, /existingController\.apiVersion !== HOOK_API_VERSION/);
  assert.equal(/window\.location\.reload\(\)/.test(hook), false);
  assert.match(hook, /onInstalled path owns the single bounded document reload/);
  assert.match(hook, /storeInfo\.name === "UserStore" && moduleExportFunction\(value, "getUser"\)/);
  assert.match(hook, /structuralUserStoreCandidates\.add\(value\)/);
  assert.match(hook, /structuralUserStoreCandidates\.size > 12/);
  assert.match(content, /event\.stopPropagation\(\)/);
  assert.match(hostCss, /\[data-ldma-author-actions-host="true"\]/);
  assert.match(hostCss, /:hover \[data-ldma-author-actions-host="true"\]/);
  assert.match(hostCss, /opacity:\s*0/);
  assert.match(hostCss, /pointer-events:\s*none/);
  assert.equal(/\bfetch\s*\(/.test(content), false);
  assert.equal(/Authorization/i.test(content), false);
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
  const protocol = fs.readFileSync(path.join(root, "src", "protocol.js"), "utf8");
  assert.match(html, /id="deleted-count"/);
  assert.match(html, /id="search" type="search"/);
  assert.match(html, /id="search-results"/);
  assert.match(html, /id="storage-bytes"/);
  assert.match(html, /local data used/);
  assert.match(source, /Core\.searchRecords/);
  assert.match(source, /Core\.isDeletedStatus/);
  assert.match(source, /replaceChildren/);
  assert.match(source, /LDMA_GET_LIVE_HEALTH/);
  assert.match(source, /healthAge >= 0 && healthAge <= 45000/);
  assert.match(source, /LDMA_LIVE_HEALTH_CHANGED/);
  assert.match(source, /storageBytes\.textContent = formatBytes\(stats\.totalBytes\)/);
  assert.match(source, /stats\.archiveBytes/);
  assert.equal(/innerHTML/.test(source), false);
  assert.equal(/reload Discord once/i.test(`${html}\n${source}\n${protocol}`), false);
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
  assert.match(viewer, /function beginRetryWindow/);
  assert.match(viewer, /function scheduleRetry/);
  assert.match(viewer, /retryable: !state \|\| state === "pending"/);
  assert.match(viewer, /refreshable: true/);
  assert.match(viewer, /currentRetryable \|\| currentRefreshable/);
  assert.match(viewer, /refreshAfterRender/);
  assert.match(viewer, /retryDeadline = Date\.now\(\) \+ 130000/);
  assert.match(viewer, /video\.controls = true/);
  assert.match(viewer, /audio\.controls = true/);
  assert.match(viewer, /video\.autoplay = false/);
  assert.match(viewer, /details\.className = "spoiler"/);
  assert.match(viewer, /LDMA_MEDIA_CAPABILITY/);
  assert.equal(/URLSearchParams/.test(viewer), false);
  assert.equal(/postMessage\([^)]*,\s*["']\*["']/.test(viewer), false);
  assert.equal(/Promise\.all/.test(viewer), false);
  assert.equal(/innerHTML/.test(viewer), false);
  assert.equal(/\.pager/.test(viewerCss), false);
  assert.match(viewerCss, /max-height:\s*350px/);
  assert.match(viewerCss, /border-radius:\s*8px/);
  assert.match(viewerCss, /overflow-y: auto/);
  assert.match(viewer, /LDMA_MEDIA_SIZE/);
  assert.match(content, /mediaFrameWindows\.get\(event\.source\)/);
  assert.match(content, /new IntersectionObserver/);
  assert.match(viewer, /lastReportedSize/);
  assert.match(viewer, /window\.addEventListener\("pagehide", disposeView\)/);
  assert.equal(/height:480px/.test(content.replace(/\s+/g, "")), false);
  assert.match(history, /Core\.exportMediaUrl/);
  assert.match(history, /recordViews/);
  assert.match(history, /revision\.revisionId/);
  assert.match(history, /LDMA_MEDIA_SIZE/);
  assert.equal(/recordsElement\.replaceChildren/.test(history), false);
  assert.match(offscreen, /skipPrune:\s*true/);
  assert.match(popup, /chrome\.permissions\.request/);
  assert.match(popup, /missingMediaOrigins\.map/);
  for (const relative of ["media/view.html", "media/view.css", "media/view.js", "media/offscreen.html", "media/offscreen.js", "src/media-store.js"]) {
    assert.equal(fs.existsSync(path.join(root, relative)), true, `${relative} is missing`);
  }
});

test("Discord edit lifecycle is event-gated, versioned, and rendered independently from deletion", () => {
  const core = fs.readFileSync(path.join(root, "src", "core.js"), "utf8");
  const protocol = fs.readFileSync(path.join(root, "src", "protocol.js"), "utf8");
  const hook = fs.readFileSync(path.join(root, "src", "page-hook.js"), "utf8");
  const content = fs.readFileSync(path.join(root, "src", "content.js"), "utf8");
  const background = fs.readFileSync(path.join(root, "src", "background.js"), "utf8");
  const mediaStore = fs.readFileSync(path.join(root, "src", "media-store.js"), "utf8");

  assert.match(hook, /MESSAGE_UPDATE/);
  assert.match(hook, /editedTimestamp \|\| value\.edited_timestamp/);
  assert.match(hook, /new CustomEvent\(EDIT_EVENT/);
  assert.match(hook, /emitEditSignal\("edit-before"/);
  assert.match(hook, /MESSAGE_START_EDIT/);
  assert.match(hook, /MESSAGE_END_EDIT/);
  assert.match(hook, /emitEditSignal\("edit-stage"/);
  assert.match(hook, /emitEditSignal\("edit-cancel"/);
  assert.match(protocol, /CONFIRM_EDIT/);
  assert.match(protocol, /editHistory/);
  assert.match(core, /maxEditRevisions/);
  assert.match(core, /editPayloadSignature/);
  assert.match(content, /function confirmEditLifecycle/);
  assert.match(content, /function verifyPendingEdit/);
  assert.match(content, /function commitPendingEdit/);
  assert.match(content, /baselineSignature/);
  assert.match(content, /stagedSelfEdits/);
  assert.match(content, /function stageSelfEditLifecycle/);
  assert.match(content, /validStaged \? staged\.baselineSignature/);
  assert.match(content, /function reconcileEditHistories/);
  assert.match(content, /data-ldma-edit-history/);
  assert.match(content, /• EDITED/);
  assert.match(content, /rgb\(240 178 50 \/ 8%\)/);
  assert.match(content, /• DELETED/);
  assert.match(background, /record\.editHistory/);
  assert.match(mediaStore, /record\.editHistory/);
  assert.match(background, /revisionId/);
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
