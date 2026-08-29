# BridgeModTools

BridgeModTools is a local Chrome extension for moderators who need a searchable, persistent record of Discord messages that were rendered while the extension was active—including messages later deleted by their authors or by moderators.

Requires Chrome 133 or newer so chronological tombstone moves preserve active iframe/video/audio playback state.

It is an unpacked Chrome Manifest V3 extension that records messages **only after Discord has rendered them in the page**. Its primary path intercepts Discord's local `MessageStore` handlers for `MESSAGE_DELETE` and `MESSAGE_DELETE_BULK`: the cached record is marked `deleted: true` instead of being removed long enough to capture and confirm it. The extension then hides that retained native row and replaces it in the same list position with its own persistent Discord-style row. This includes messages deleted by moderators and messages you delete yourself. A conservative DOM inference path remains as a fallback when store retention is unavailable.

Version 2.2 preserves Discord message grouping: consecutive messages in the same captured author group render as compact continuations without repeating the avatar, author name, badges, or header timestamp. Replies, group/time boundaries, date dividers, and different authors start a full row. Older cached records without native grouping metadata use a conservative fallback that requires matching stable author identity, the same local day, and a seven-minute window.

Version 2.2.2 fixes live deletion recovery for the entire archived row. If Discord replaces its virtual message list while deletion confirmation is in flight, Bridge Mod Tools remounts the deleted text, author presentation, replies, embeds, attachments, and media against the newest list without requiring a refresh. Already-mounted media players also recover if local caching completes before their one-time notification arrives.

Version 2.3 adds local edit history. A genuine Discord `MESSAGE_UPDATE` with a new edited timestamp stages the currently rendered payload before Discord applies the edit, then commits it only after the isolated script observes that exact row's text/media payload change. Earlier text, links, attachments, embeds, and media appear oldest-to-newest in dark yellow with an explicit **EDITED** marker while Discord's real latest row remains untouched. Multiple edits are preserved, and a later deletion composes the yellow edit trail with the latest red **DELETED** version. Ordinary DOM churn, lazy embeds, reactions, presentation changes, and scrolling do not create revisions. Each record keeps its original plus the newest revisions within a 20-revision/512-KiB bound.

Version 2.3.1 fixes cold-start capture. The document-start lifecycle hook now installs on every `discord.com` application route, survives Discord's `/app`/login-to-channel soft navigation, and is idempotently re-ensured for restored tabs, extension updates, browser startup, and History API navigation. A document-scoped watchdog forces Discord Webpack rescans and repairs replaced MessageStore handlers without requiring a page refresh.

An extension update automatically reloads any already-open Discord tabs once so the new MAIN-world controller replaces the previous bundle cleanly. This is automatic and does not happen on ordinary Discord launches or route changes.

Version 2.4 keeps saved deleted-row author identity actionable. Click the restored avatar or author name to open Discord's native profile modal, or use the row toolbar to open the profile, copy the raw user ID, copy a Discord `<@USER_ID>` mention, or apply a fixed seven-day server timeout. Timeout is shown only in server channels and always requires a confirmation naming the archived author; Discord still enforces the moderator's current permission and role hierarchy.

Version 2.5 fixes edit history for messages you edit yourself in DMs, group DMs, and servers. BridgeModTools now stages the rendered original when Discord enters local edit mode, commits it only after Discord reports a successful edit, and suppresses the duplicate gateway update. Other users' edits continue through the existing server-update path, while canceled, failed, and semantically unchanged local edits create no history.

Version 2.6 adds two compact author actions beside the name and timestamp on hover for both live and restored deleted messages. **ID** copies the raw Discord user ID, while **7d** applies a confirmed seven-day server timeout through Discord's native moderation action. Timeout is hidden in DMs, remains available for saved deleted rows after reload, revalidates the clicked message's author against the current MessageStore or exact deleted archive record, and suppresses concurrent duplicate requests.

Version 2.6.1 changes the copy action to **@** and copies the account's real Discord username (for example, `curiousbro`, without an `@`) instead of its numeric snowflake. Usernames are cached with archived records, and saved deleted messages can recover a missing username after reload through Discord's UserStore using only the exact trusted archived author binding.

Version 2.6.2 fixes the **@** action showing `!` after an extension update. It versions the page-world resolver so a surviving older Discord hook is replaced by one automatic page refresh, supports Discord UserStore builds without `getCurrentUser`, preserves an exact verified cached username when an older resolver returns only the author ID, and carries trusted cached usernames for restored deleted rows. Clipboard failures and genuinely unavailable usernames now report distinct status text.

Version 2.6.3 grants the **@** action Chrome's write-only clipboard capability so resolved usernames are actually copied; the extension never reads the clipboard. The popup also displays combined local data usage—message metadata plus cached-media payload bytes—while retaining the separate media-cache total.

Version 2.6.4 fixes canonical username copying across Discord's current UserStore module shapes, DMs, restored deleted messages, and legacy ID-only archive records. Every username remains atomically bound to its exact verified Discord user ID, structural store conflicts fail closed, and bulk recovery performs at most one bounded module refresh. It also removes page-hook-initiated reloads entirely, preventing unpacked-extension upgrades from putting Discord into a refresh loop; only the background update handler may reload an existing Discord tab once.

Version 2.6.6 fixes an injection-serialization bug behind “Discord author resolver unavailable.” All programmatic callbacks now serialize as standalone functions, including author lookup, profile/timeout actions, and readiness probes. DM route checks also normalize null guild fields omitted by Chrome's argument conversion. A failed probe no longer triggers a reload, and lookup errors distinguish missing controllers, exceptions, channel changes, and absent results. Regression tests serialize the callbacks and JSON arguments into separate page worlds instead of invoking background functions directly.

Version 2.6.7 removes heavy Discord scrolling lag in image-rich channels. Scroll capture is limited to changed rows, four records or five milliseconds of work per frame, and one non-resetting persistence batch per 1.25 seconds. Real lifecycle removals receive priority over Discord virtualization, hover actions no longer trigger global scans while moving, healthy MessageStore retention avoids repeated Webpack cache walks, and restored media unloads outside the viewport without losing its measured layout. Activation epochs prevent stale media capabilities from crossing iframe reloads.

Restored visual media now uses Discord-like inline sizing and spacing instead of a fixed-height generic card. Images and videos retain intrinsic dimensions up to a 550×350-pixel display box, small GIFs stay small, multiple visuals use a compact grid, and audio remains a compact native player. Cached files and plain links keep a small labeled tile.

Version 2 also captures links and rendered upload/embed media. Discord-hosted images, videos, audio, voice messages, and files are downloaded immediately into an extension-owned local cache; direct third-party media can be enabled per site from the popup. Restored deleted rows and full history use the cached bytes, so supported media remains viewable or playable after the original message disappears.

It does not read Chrome's ordinary disk cache. Message metadata stays in the bounded JSON archive; media bodies use a separate, explicit Cache Storage layer with an IndexedDB ownership/status index.

## Install from GitHub

Repository: [github.com/Rizzist/BridgeModTools](https://github.com/Rizzist/BridgeModTools)

Stable downloads: [github.com/Rizzist/BridgeModTools/releases/latest](https://github.com/Rizzist/BridgeModTools/releases/latest)

### Download the ZIP

1. Download the source ZIP from the latest release, or open the repository and choose **Code → Download ZIP**.
2. Extract the ZIP somewhere permanent. Do not delete that folder while the extension is installed.
3. Open `chrome://extensions` in Chrome.
4. Turn on **Developer mode**.
5. Click **Load unpacked**.
6. Select the extracted `BridgeModTools-main` folder—the folder containing `manifest.json`.
7. Open Discord, visit a DM, group DM, or server channel, and open the BridgeModTools toolbar popup. A manual Discord refresh is not required.
8. Wait until the popup reports **Active: Discord MessageStore edit history and deletion retention are active.**

Chrome cannot install an unpacked extension directly from a GitHub URL. Each user must approve the local folder through `chrome://extensions`.

### Install with Git

```sh
git clone https://github.com/Rizzist/BridgeModTools.git
```

Then use **Load unpacked** in `chrome://extensions` and select the cloned `BridgeModTools` folder.

### Update

- Git install: run `git pull` inside the repository.
- ZIP install: download the latest ZIP and replace the old extracted files.
- In both cases, click **Reload** on the BridgeModTools card in `chrome://extensions`. BridgeModTools reconnects already-open Discord tabs automatically.

### First test

1. With the popup showing **Active**, send a harmless test message in a channel you are authorized to moderate.
2. Delete it yourself or remove it as a moderator.
3. Confirm that the row remains in place with a red deleted marker.
4. Reload Discord and confirm that the saved row is restored once, without duplication.

The toolbar popup shows archived, edited, saved-deleted, and cached-media counts and includes immediate local search. It can grant exact third-party origins when direct external media needs permission, pause capture, open full history, or clear everything. Full history adds status filtering, cached playback for current and earlier edited versions, JSON metadata export, per-record deletion, and delete-all.

## Privacy and security properties

- Manifest permissions: `storage`, `offscreen`, `unlimitedStorage`, `scripting`, `webNavigation`, and write-only `clipboardWrite` for the explicit username-copy button. BridgeModTools never reads the clipboard. Required hosts are limited to the exact Discord application origin plus Discord's CDN/media proxy domains. Arbitrary HTTPS is optional; Chrome prompts only when you click the popup button for the exact origins currently waiting.
- Bootstrap page match: `https://discord.com/*`. Message capture remains route-gated internally to real `/channels/<guild-or-@me>/<channelId>` views.
- One local service worker serializes every archive read/write; content and UI pages cannot access storage directly.
- A `document_start`, main-world adapter discovers Discord's `MessageStore`, signals genuine edits, and retains cached records during single or bulk deletion. It sends only validated channel/message IDs plus an edit timestamp/ordering token to the isolated content script. Message content, tokens, cookies, and store objects never cross that bridge.
- Live/deleted-row profile and timeout actions pass only validated message/user/guild IDs through the document-bound service worker. The worker derives the channel and guild from the current Discord route, rechecks that route in the MAIN world, proves timeout authorship against Discord's current MessageStore or the exact saved deleted record, allows only profile-open or fixed seven-day timeout, and invokes Discord's structurally discovered native client actions. It does not read a token or construct a Discord REST request; missing or changed native modules fail closed.
- Clear, per-record delete, and pause/resume advance an archive generation. Stale in-flight capture or inference writes are rejected.
- The only programmatic network requests are bounded media downloads. They omit credentials and referrers, follow no cross-origin redirect, enforce MIME/size limits, and run in a packaged offscreen document. There are no remote scripts, analytics, cookies, tokens, authorization headers, Discord API calls, or ordinary browser-cache access.
- Message metadata stays in `chrome.storage.local`; cached bodies and their local index stay in extension-origin Cache Storage/IndexedDB for the same Chrome profile.
- Saved records survive Discord refreshes, tab/browser restarts, and MV3 service-worker suspension. Removing the extension or clearing its local history still removes them.
- Stored metadata includes message/channel IDs, the account username, visible channel/author/content, HTTPS links and media descriptors, attachment names, timestamps, local capture/deletion times, and bounded presentation metadata. Media bytes never enter the JSON archive.
- Presentation metadata is normalized on capture, merge, load, and render. Raw Discord HTML, class names, arbitrary CSS variables, remote CSS URLs, and scripts are never stored or replayed.
- Storage is pruned to at most 1,500 records and approximately 4 MiB of serialized record data. Deleted and edited records retain priority while a small rolling reserve keeps newly rendered messages eligible for a later lifecycle event. Per-message edit history is independently bounded to the original plus the newest revisions, at most 20 revisions and approximately 512 KiB.
- Media is capped at 32 MiB per asset, 512 MiB total, 1,000 cached assets, and one download at a time. Downloads stream through a byte-counting limiter directly into Cache Storage, and space is reserved before each download. Old media referenced only by seen messages is evicted before deleted-message media. Record deletion and archive pruning remove unshared bodies; clear-all invalidates in-flight jobs and deletes the complete media cache.
- Pending and transiently failed downloads are recovered from persisted cache metadata on later archive refreshes, with bounded retry/backoff. Missing Cache Storage bodies are repaired instead of being reported as cached forever.
- Inline edited/deleted content is rendered inside a closed Shadow DOM. A sandboxed, packaged extension-origin frame reads cached bodies, creates temporary blob URLs, uses responsive Discord-like inline image/video/audio presentation or a compact file tile, and revokes those URLs on unload.
- Rendering uses `textContent`; archived message text is never interpreted as HTML.

Use it only in conversations you are authorized to access, and respect other participants' privacy and applicable rules.

BridgeModTools is an independent project and is not affiliated with or endorsed by Discord. Discord can change its private client internals at any time; review the popup status after updates.

## How native deletion retention works

Discord's deletion actions contain IDs but not the deleted message content. The extension therefore captures visible text locally before deletion and changes only the local store behavior:

- The isolated content script archives visible text from Discord's rendered message list.
- The main-world adapter discovers Discord's local Flux dispatcher, named `MessageStore`, and that store's registered action-handler node.
- For a cached single or bulk deletion, the adapter marks the immutable message record `deleted: true`, writes it back through the channel's message cache, and returns before the original MessageStore removal code. Other Discord stores still receive the deletion action normally.
- The retained native row remains only as an internal safety copy. Once deletion is persisted, the isolated script hides that row and mounts a packaged Discord-style replacement in the same list slot with captured presentation, text, links, cached media, red tint, and a deleted marker. Reduced-motion preferences are honored.
- Native Discord group-root metadata is stored with each rendered row. After every chronological insertion, removal, or virtual-list change, a presentation-only pass recomputes restored deleted-row continuations from visible adjacency. Native live rows remain untouched, so a message Discord promotes to the top of a group keeps its real avatar, author, badges, and timestamp. Regrouping changes only restored row classes in place, preserving active media iframe and audio/video state.
- Self-authored messages are not filtered. On a retained deletion, the isolated script immediately snapshots the still-native row before flushing storage, covering the race where you send and delete your own message before the normal capture debounce completes.
- On later Discord loads, confirmed records are read back from `chrome.storage.local`. The extension first uses the archived neighboring message IDs, then falls back to the nearest older/newer Discord snowflake IDs currently rendered. It restores the same compact Discord-style replacement in chronological position and deduplicates by `{channelId,messageId}`, so repeated reconciliation cannot create copies. Its exterior position is balanced from the real neighboring-row geometry, including Discord's grouped/full-message spacing, without changing list height. Older saved records without presentation metadata use a generated initial avatar and formatted timestamp. The record remains searchable in the popup even when the chat view is not open.
- If Discord exposes the store but not a writable action-handler node, a compatibility wrapper captures the record before dispatch and restores it before Flux finishes emitting changes.
- Direct messages and group DMs use `/channels/@me/<channelId>`; servers use `/channels/<guildId>/<channelId>`. Both paths key records by the same `{channelId, messageId}` pair.

The MAIN-to-isolated bridge shares the Discord page boundary and is therefore not cryptographically authentic against hostile same-page code. “Retained deleted” describes local client state, not independent proof from Discord's servers.

## How edit history works

- The main-world adapter wraps the exact `MessageStore` `MESSAGE_UPDATE` handler (or its dispatcher compatibility path) and recognizes an edit only when the incoming edited timestamp advances.
- Immediately before Discord mutates its store, an ID-only synchronous lifecycle event lets the isolated script stage the old payload from the already-rendered native row. It is persisted only after the isolated world observes a semantic text/media change on that exact row; no-op signals expire, and transient broker failures receive bounded retries. Content from the store/action never crosses worlds.
- The archive keeps the current payload at the top level and stores compact immutable prior payloads in chronological `editHistory`. Edit history is orthogonal to `seen`, suspected removal, and confirmed deletion status.
- Live history is injected inside the matching native message payload in a closed shadow root. Discord's actual current content, avatar, name, timestamp, grouping, and edited indicator remain untouched.
- On deletion, the one restored message row renders prior versions in yellow and the latest deleted payload in red. Revision media stays owned by the parent record and remains playable from both Discord and the full History page.
- An intermediate version that Discord never rendered cannot be reconstructed without importing private MessageStore content, so BridgeModTools deliberately preserves the existing rendered-only trust boundary.

If private Discord internals change, the popup reports a degraded or searching state. The extension then falls back to lifecycle/removal correlation and, finally, conservative DOM inference. Modern chat interfaces also remove DOM nodes while scrolling, changing channels, or replacing a list, so the DOM-only path is labeled **suspected removed**. Its fallback requires all of these:

- exactly one known, recently snapshotted message disappeared from the active list;
- it was substantially visible away from the viewport edges and the document is still visible;
- there was no recent scroll or navigation;
- the channel did not change and the mutation container remains connected;
- the active message list and direct row parent remain the same;
- row IDs belong to the current route's channel where Discord exposes a channel ID;
- the previous and next messages both remain in that same parent and are now adjacent; or, for the last row only, the previous message remains fixed and the chat scroller was already at the bottom;
- the previous anchor did not shift materially;
- no message was added in the same mutation batch;
- it remains absent after a 1.4-second reappearance grace window; and
- the operation was not a root swap, list replacement, or large DOM removal.

The fallback deliberately favors false negatives over false positives. MessageStore retention does not depend on viewport position, a surviving next sibling, grouped layout, moderator versus author deletion, or whether the channel is a DM, group DM, or server.

If the same live message ID reappears later, its status is retracted to **seen** and its tombstone is removed. Neighbor IDs are stored with inferred removals so tombstones can be reconciled after Discord remounts the view. Clear and per-record delete notifications also remove mounted tombstones through the broker's local update channel.

## Limitations

- It cannot recover messages deleted before they were rendered while capture was active.
- A media item must finish downloading while its signed source remains valid. Expired, oversized, unsupported, or repeatedly failed downloads keep their metadata and original link but may not be playable offline. JSON export strips Discord CDN signature query parameters.
- Generic provider pages, HLS/DRM streams, and embeds such as YouTube/Vimeo are preserved as links and rendered preview media; the extension does not scrape, transcode, or bypass provider controls.
- “Playable” means formats/codecs supported by the installed Chrome build. Other cached files remain downloadable.
- Captured avatar and role/server-icon imagery remains dependent on Discord's CDN cache/network; the extension does not copy those image bytes into storage.
- Unsupported proprietary name effects fall back to the captured resolved color/gradient. Safe background-position/color/opacity motion is replayed; arbitrary filters, transforms, CSS variables, and remote style resources are rejected.
- Store retention works for first-row, last-row, only-row, moderator, and bulk deletions when the message is still present in Discord's local channel cache.
- If a message is not in the local MessageStore, fallback tombstone placement is best-effort; the record remains available in searchable history if it had already been archived.
- Scroll virtualization, navigation, root replacement, and mass removal are ignored by the DOM fallback and never become confirmed deletions by themselves.
- Discord can change its private module or DOM structure at any time. The popup's last reported hook status is intended to make that failure visible.
- Discord structural rows such as date dividers share part of the message-row ID prefix. They are explicitly excluded from message-list validation so they cannot suspend persistent capture.
- A **suspected removed** DOM fallback is not authoritative proof that a user deleted a message.
- An edit that occurs while the message is not locally rendered/cached, or an intermediate edit that Discord replaces before it ever renders, cannot be recovered.
- Clearing Chrome extension data or removing the extension deletes its local archive unless it was exported first.

## Test and inspect

No package installation is needed. With Node.js 18 or newer:

```sh
npm test
```

The test suite checks deletion classification, fake Discord `MessageStore` edit/deletion lifecycle handling, live/deleted username-copy and timeout controls, trusted username recovery for saved deletions, document-bound moderation routing, fixed timeout arguments, ID-only lifecycle bridge normalization, multi-edit and edit-then-delete durability, stale-capture rejection, historical-media ownership, responsive inline media structure, dispatcher fallback, media URL/name sanitization, MIME/size/redirect enforcement, omitted credentials/referrers, storage merge/prune/search, exact manifest permissions and host scope, packaged offscreen/player files, and absence of cookie/token/remote-script primitives.

Open `demo/index.html` in a browser for a deterministic fixture. Its controls feed fixed signals into the same pure classifier used by the extension; it does not contact Discord or write extension storage.

## File map

- `src/page-hook.js` — main-world Webpack/Flux discovery, MessageStore deletion retention, ID-only lifecycle bridge, and native profile/timeout action adapter.
- `src/core.js` — pure classifier, route/list parsing, storage merge/prune/search, and tombstone cleanup utilities.
- `src/protocol.js` / `src/background.js` — generation-checked archive protocol and serialized storage broker.
- `src/media-store.js` / `media/offscreen.*` — bounded extension-owned media cache and downloader.
- `media/view.*` — sandboxed cached image/video/audio/file/link renderer shared by Discord rows and history.
- `src/content.js` / `src/content.css` — rendered-message capture, native-row replacement, chronological/deduplicated restoration, and mutation checks.
- `popup/` — capture pause/resume, counts, history shortcut, and clear.
- `history/` — local search, filter, JSON export, and deletion controls.
- `demo/` — deterministic visual classifier fixture.
- `tests/` — dependency-free Node test suite and static privacy audit.
