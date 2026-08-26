# BridgeModTools

BridgeModTools is a local Chrome extension for moderators who need a searchable, persistent record of Discord messages that were rendered while the extension was active—including messages later deleted by their authors or by moderators.

Requires Chrome 133 or newer so chronological tombstone moves preserve active iframe/video/audio playback state.

It is an unpacked Chrome Manifest V3 extension that records messages **only after Discord has rendered them in the page**. Its primary path intercepts Discord's local `MessageStore` handlers for `MESSAGE_DELETE` and `MESSAGE_DELETE_BULK`: the cached record is marked `deleted: true` instead of being removed long enough to capture and confirm it. The extension then hides that retained native row and replaces it in the same list position with its own persistent Discord-style row. This includes messages deleted by moderators and messages you delete yourself. A conservative DOM inference path remains as a fallback when store retention is unavailable.

Version 2.2 preserves Discord message grouping: consecutive messages in the same captured author group render as compact continuations without repeating the avatar, author name, badges, or header timestamp. Replies, group/time boundaries, date dividers, and different authors start a full row. Older cached records without native grouping metadata use a conservative fallback that requires matching stable author identity, the same local day, and a seven-minute window.

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
7. Open or reload Discord, visit a DM, group DM, or server channel, and open the BridgeModTools toolbar popup.
8. Wait until the popup reports **Active: Discord MessageStore deletion retention is active.**

Chrome cannot install an unpacked extension directly from a GitHub URL. Each user must approve the local folder through `chrome://extensions`.

### Install with Git

```sh
git clone https://github.com/Rizzist/BridgeModTools.git
```

Then use **Load unpacked** in `chrome://extensions` and select the cloned `BridgeModTools` folder.

### Update

- Git install: run `git pull` inside the repository.
- ZIP install: download the latest ZIP and replace the old extracted files.
- In both cases, click **Reload** on the BridgeModTools card in `chrome://extensions`, then reload Discord once.

### First test

1. With the popup showing **Active**, send a harmless test message in a channel you are authorized to moderate.
2. Delete it yourself or remove it as a moderator.
3. Confirm that the row remains in place with a red deleted marker.
4. Reload Discord and confirm that the saved row is restored once, without duplication.

The toolbar popup shows archived, saved-deleted, and cached-media counts and includes immediate local search. It can grant exact third-party origins when direct external media needs permission, pause capture, open full history, or clear everything. Full history adds status filtering, cached playback, JSON metadata export, per-record deletion, and delete-all.

## Privacy and security properties

- Manifest permissions: `storage`, `offscreen`, and `unlimitedStorage`. Required hosts are limited to Discord's CDN/media proxy domains. Arbitrary HTTPS is optional; Chrome prompts only when you click the popup button for the exact origins currently waiting.
- Page match: `https://discord.com/channels/*` only.
- One local service worker serializes every archive read/write; content and UI pages cannot access storage directly.
- A `document_start`, main-world adapter discovers Discord's `MessageStore` and retains cached records during single or bulk deletion. It sends only validated channel/message IDs to the isolated content script. Message content, tokens, cookies, and store objects never cross that bridge.
- Clear, per-record delete, and pause/resume advance an archive generation. Stale in-flight capture or inference writes are rejected.
- The only programmatic network requests are bounded media downloads. They omit credentials and referrers, follow no cross-origin redirect, enforce MIME/size limits, and run in a packaged offscreen document. There are no remote scripts, analytics, cookies, tokens, authorization headers, Discord API calls, or ordinary browser-cache access.
- Message metadata stays in `chrome.storage.local`; cached bodies and their local index stay in extension-origin Cache Storage/IndexedDB for the same Chrome profile.
- Saved records survive Discord refreshes, tab/browser restarts, and MV3 service-worker suspension. Removing the extension or clearing its local history still removes them.
- Stored metadata includes message/channel IDs, visible channel/author/content, HTTPS links and media descriptors, attachment names, timestamps, local capture/deletion times, and bounded presentation metadata. Media bytes never enter the JSON archive.
- Presentation metadata is normalized on capture, merge, load, and render. Raw Discord HTML, class names, arbitrary CSS variables, remote CSS URLs, and scripts are never stored or replayed.
- Storage is pruned to at most 1,500 records and approximately 4 MiB of serialized record data. Confirmed/suspected removals retain priority while a small rolling reserve keeps newly rendered messages eligible for a later deletion.
- Media is capped at 32 MiB per asset, 512 MiB total, 1,000 cached assets, and one download at a time. Downloads stream through a byte-counting limiter directly into Cache Storage, and space is reserved before each download. Old media referenced only by seen messages is evicted before deleted-message media. Record deletion and archive pruning remove unshared bodies; clear-all invalidates in-flight jobs and deletes the complete media cache.
- Pending and transiently failed downloads are recovered from persisted cache metadata on later archive refreshes, with bounded retry/backoff. Missing Cache Storage bodies are repaired instead of being reported as cached forever.
- Inline deleted-message content is rendered inside a closed Shadow DOM. A sandboxed, packaged extension-origin frame reads cached bodies, creates temporary blob URLs, provides native image/video/audio controls or file download, and revokes those URLs on unload.
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
- The latest rendered text replaces an earlier captured edit; this is not an edit-version tracker.
- Clearing Chrome extension data or removing the extension deletes its local archive unless it was exported first.

## Test and inspect

No package installation is needed. With Node.js 18 or newer:

```sh
npm test
```

The test suite checks deletion classification, fake Discord `MessageStore` retention, dispatcher fallback, ID-only bridge normalization, archive durability, media URL/name sanitization, MIME/size/redirect enforcement, omitted credentials/referrers, storage merge/prune/search, exact manifest permissions and host scope, packaged offscreen/player files, and absence of cookie/token/remote-script primitives.

Open `demo/index.html` in a browser for a deterministic fixture. Its controls feed fixed signals into the same pure classifier used by the extension; it does not contact Discord or write extension storage.

## File map

- `src/page-hook.js` — main-world Webpack/Flux discovery, MessageStore deletion retention, and ID-only bridge.
- `src/core.js` — pure classifier, route/list parsing, storage merge/prune/search, and tombstone cleanup utilities.
- `src/protocol.js` / `src/background.js` — generation-checked archive protocol and serialized storage broker.
- `src/media-store.js` / `media/offscreen.*` — bounded extension-owned media cache and downloader.
- `media/view.*` — sandboxed cached image/video/audio/file/link renderer shared by Discord rows and history.
- `src/content.js` / `src/content.css` — rendered-message capture, native-row replacement, chronological/deduplicated restoration, and mutation checks.
- `popup/` — capture pause/resume, counts, history shortcut, and clear.
- `history/` — local search, filter, JSON export, and deletion controls.
- `demo/` — deterministic visual classifier fixture.
- `tests/` — dependency-free Node test suite and static privacy audit.
