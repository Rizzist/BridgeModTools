# BridgeModTools

BridgeModTools is a local Chrome extension for moderators who need a searchable, persistent record of Discord messages that were rendered while the extension was active—including messages later deleted by their authors or by moderators.

It is an unpacked Chrome Manifest V3 extension that records messages **only after Discord has rendered them in the page**. Its primary path intercepts Discord's local `MessageStore` handlers for `MESSAGE_DELETE` and `MESSAGE_DELETE_BULK`: the cached record is marked `deleted: true` instead of being removed long enough to capture and confirm it. The extension then hides that retained native row and replaces it in the same list position with its own persistent Discord-style row. This includes messages deleted by moderators and messages you delete yourself. A conservative DOM inference path remains as a fallback when store retention is unavailable.

It does not read Chrome's disk cache. A browser cache is not a dependable message history: it stores selected HTTP resources and can be evicted or encoded, while Discord's live message state is rendered by the app. This extension instead observes the already-visible page from the moment it is enabled.

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

The toolbar popup shows archived and saved-deleted counts and includes an immediate local search over saved deleted content, authors, channels, and attachment names. It can also pause capture, open the full history page, or clear all local history. The full history page adds status filtering, JSON export, per-record deletion, and delete-all.

## Privacy and security properties

- Manifest permission: `storage` only.
- Page match: `https://discord.com/channels/*` only.
- One local service worker serializes every archive read/write; content and UI pages cannot access storage directly.
- A `document_start`, main-world adapter discovers Discord's `MessageStore` and retains cached records during single or bulk deletion. It sends only validated channel/message IDs to the isolated content script. Message content, tokens, cookies, and store objects never cross that bridge.
- Clear, per-record delete, and pause/resume advance an archive generation. Stale in-flight capture or inference writes are rejected.
- No programmatic network requests, remote scripts, analytics, cookies, tokens, Discord API calls, or browser-cache access. A restored row may display its captured avatar URL through an ordinary image element restricted to Discord's CDN hosts.
- Data stays in `chrome.storage.local` for the Chrome profile where the extension is loaded.
- Saved records survive Discord refreshes, tab/browser restarts, and MV3 service-worker suspension. Removing the extension or clearing its local history still removes them.
- Stored fields are message/channel IDs, visible channel name, visible author/content, attachment **names**, timestamps, local capture/deletion times, and bounded presentation metadata (Discord CDN avatar/role-icon URLs, resolved username color or gradient, safe name-animation keyframes, visible timestamp text, badges, and reply preview).
- Presentation metadata is normalized on capture, merge, load, and render. Raw Discord HTML, class names, arbitrary CSS variables, remote CSS URLs, and scripts are never stored or replayed.
- Storage is pruned to at most 1,500 records and approximately 4 MiB of serialized record data. Confirmed/suspected removals retain priority while a small rolling reserve keeps newly rendered messages eligible for a later deletion.
- Inline deleted-message content is rendered synchronously inside a closed Shadow DOM owned by the isolated content script. Discord's normal page selectors see only the generic host and record key, not the retained text.
- Rendering uses `textContent`; archived message text is never interpreted as HTML.

Use it only in conversations you are authorized to access, and respect other participants' privacy and applicable rules.

BridgeModTools is an independent project and is not affiliated with or endorsed by Discord. Discord can change its private client internals at any time; review the popup status after updates.

## How native deletion retention works

Discord's deletion actions contain IDs but not the deleted message content. The extension therefore captures visible text locally before deletion and changes only the local store behavior:

- The isolated content script archives visible text from Discord's rendered message list.
- The main-world adapter discovers Discord's local Flux dispatcher, named `MessageStore`, and that store's registered action-handler node.
- For a cached single or bulk deletion, the adapter marks the immutable message record `deleted: true`, writes it back through the channel's message cache, and returns before the original MessageStore removal code. Other Discord stores still receive the deletion action normally.
- The retained native row remains only as an internal safety copy. Once the deletion is persisted, the isolated script hides that row and mounts a packaged Discord-style replacement in the same list slot with avatar, author gradient/color, adjacent role/app/server icons, supported name motion, timestamp, reply preview, text, attachment names, red tint, and a deleted marker. Reduced-motion preferences are honored.
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
- It cannot recover attachment bytes; it stores visible attachment names only.
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

The test suite checks the classifier's accept/reject paths, fake Discord `MessageStore` retention for single and bulk deletions, the dispatcher compatibility fallback, ID-only bridge normalization, confirmed-deletion durability, storage merge/pruning/search behavior, JavaScript syntax, the exact manifest permissions/match, packaged scripts, and absence of network/cookie/token/cache primitives.

Open `demo/index.html` in a browser for a deterministic fixture. Its controls feed fixed signals into the same pure classifier used by the extension; it does not contact Discord or write extension storage.

## File map

- `src/page-hook.js` — main-world Webpack/Flux discovery, MessageStore deletion retention, and ID-only bridge.
- `src/core.js` — pure classifier, route/list parsing, storage merge/prune/search, and tombstone cleanup utilities.
- `src/protocol.js` / `src/background.js` — generation-checked archive protocol and serialized storage broker.
- `src/content.js` / `src/content.css` — rendered-message capture, native-row replacement, chronological/deduplicated restoration, and mutation checks.
- `popup/` — capture pause/resume, counts, history shortcut, and clear.
- `history/` — local search, filter, JSON export, and deletion controls.
- `demo/` — deterministic visual classifier fixture.
- `tests/` — dependency-free Node test suite and static privacy audit.
