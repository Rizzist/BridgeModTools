"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../src/core.js");
const MediaStore = require("../src/media-store.js");

function response(body, options) {
  const settings = Object.assign({
    url: "https://cdn.discordapp.com/attachments/111111111111111111/222222222222222222/photo.png",
    type: "image/png",
    status: 200
  }, options || {});
  const blob = new Blob([body], { type: settings.type });
  return {
    ok: settings.status >= 200 && settings.status < 300,
    status: settings.status,
    url: settings.url,
    headers: new Headers({
      "content-type": settings.type,
      "content-length": settings.length === undefined ? String(blob.size) : String(settings.length)
    }),
    body: blob.stream(),
    blob: async () => blob
  };
}

test("media URLs and filenames reject unsafe input", () => {
  assert.equal(Core.safeMediaUrl("https://cdn.discordapp.com/attachments/1/file.png#fragment"),
    "https://cdn.discordapp.com/attachments/1/file.png");
  for (const value of [
    "http://cdn.discordapp.com/file.png",
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "blob:https://discord.com/id",
    "file:///tmp/a.png",
    "https://user:pass@example.com/a.png",
    "https://example.com:8443/a.png",
    "https://example.com/a\u202eb.png",
    "https://localhost/a.png",
    "https://localhost./a.png",
    "https://127.0.0.1/a.png",
    "https://192.168.1.10/a.png",
    "https://router.local./a.png",
    "https://service.internal./a.png",
    "https://[::]/a.png",
    "https://[::ffff:127.0.0.1]/a.png",
    "https://service.internal/a.png"
  ]) assert.equal(Core.safeMediaUrl(value), null, value);
  assert.equal(Core.safeMediaName("../SPOILER_hello\u0000\\world.png"), ".. SPOILER_hello world.png");
  assert.equal(Core.exportMediaUrl("https://cdn.discordapp.com/attachments/1/a.png?ex=secret&is=signature"),
    "https://cdn.discordapp.com/attachments/1/a.png");
});

test("media kind inference and sanitization are bounded and deduplicated", () => {
  assert.equal(Core.mediaKindFromUrl("https://example.com/image.webp?x=1"), "image");
  assert.equal(Core.mediaKindFromUrl("https://example.com/movie.webm"), "video");
  assert.equal(Core.mediaKindFromUrl("https://example.com/voice.ogg"), "audio");
  assert.equal(Core.mediaKindFromUrl("https://example.com/page"), "link");
  assert.equal(Core.mediaKindFromMime("video/mp4; charset=binary", "file"), "video");

  const raw = Array.from({ length: 24 }, (_value, index) => ({
    url: `https://cdn.discordapp.com/attachments/111111111111111111/22222222222222222${index}/file-${index}.png`,
    kind: "image", source: "attachment", name: `file-${index}.png`, width: 99999, height: -1
  }));
  raw.unshift(Object.assign({}, raw[0]));
  const items = Core.sanitizeMediaItems(raw);
  assert.equal(items.length, 16);
  assert.equal(items[0].width, 10000);
  assert.equal(items[0].height, undefined);
  assert.equal(new Set(items.map((item) => item.url)).size, 16);
});

test("record merge and search retain sanitized media metadata without binary data", () => {
  const base = {
    channelId: "111111111111111111", messageId: "222222222222222222", author: "A",
    content: "", status: "seen", capturedAt: 1,
    media: [{
      url: "https://cdn.discordapp.com/attachments/111111111111111111/333333333333333333/clip.mp4",
      kind: "video", source: "attachment", name: "demo clip.mp4", cacheable: true
    }]
  };
  const merged = Core.mergeRecords([], [base], { now: 2, maxRecords: 10, maxBytes: 100000, seenReserve: 1 });
  assert.equal(merged[0].media[0].kind, "video");
  assert.equal("blob" in merged[0].media[0], false);
  assert.equal(Core.searchRecords(merged, "demo clip", "all").length, 1);
  assert.equal(Core.searchRecords(merged, "cdn.discordapp.com", "all").length, 1);
});

test("media downloader omits credentials, validates MIME, and returns a bounded blob", async () => {
  let requestOptions;
  const item = {
    url: "https://cdn.discordapp.com/attachments/111111111111111111/222222222222222222/photo.png",
    kind: "image", source: "attachment", name: "photo.png", cacheable: true
  };
  const downloaded = await MediaStore.downloadAsset(item, async (_url, options) => {
    requestOptions = options;
    return response("png-data");
  }, { maxAssetBytes: 1024, timeoutMs: 1000 });
  assert.equal(requestOptions.credentials, "omit");
  assert.equal(requestOptions.redirect, "follow");
  assert.equal(requestOptions.referrerPolicy, "no-referrer");
  assert.equal(downloaded.kind, "image");
  assert.equal(downloaded.mimeType, "image/png");
  assert.equal(downloaded.size, 8);
});

test("production cache path streams through the byte limiter without building a download blob", async () => {
  const originalCaches = globalThis.caches;
  let storedBytes = null;
  globalThis.caches = {
    open: async () => ({
      put: async (_key, cachedResponse) => { storedBytes = (await cachedResponse.arrayBuffer()).byteLength; }
    })
  };
  try {
    const item = {
      url: "https://cdn.discordapp.com/attachments/111111111111111111/222222222222222222/voice.ogg",
      kind: "audio", source: "attachment", cacheable: true
    };
    const streamed = await MediaStore.streamAssetToCache(item, MediaStore.cacheRequestUrl(item.url), async () =>
      response("streamed-audio", { url: item.url, type: "audio/ogg" }), { maxAssetBytes: 1024 });
    assert.equal(streamed.size, 14);
    assert.equal(storedBytes, 14);
    assert.equal(streamed.kind, "audio");
  } finally {
    globalThis.caches = originalCaches;
  }
});

test("media downloader rejects oversize, active content, HTTP failures, and redirect escapes", async () => {
  const item = {
    url: "https://cdn.discordapp.com/attachments/111111111111111111/222222222222222222/photo.png",
    kind: "image", source: "attachment", name: "photo.png", cacheable: true
  };
  await assert.rejects(() => MediaStore.downloadAsset(item, async () => response("x", { length: 2048 }),
    { maxAssetBytes: 1024 }), /asset-too-large/);
  await assert.rejects(() => MediaStore.downloadAsset(item, async () => response("<svg/>", { type: "image/svg+xml" })),
    /unsupported-content-type/);
  await assert.rejects(() => MediaStore.downloadAsset(item, async () => response("no", { status: 403 })), /http-403/);
  await assert.rejects(() => MediaStore.downloadAsset(item, async () => response("x", {
    url: "https://example.com/escaped.png"
  })), /cross-origin-redirect/);
});

test("cache keys are deterministic and permission origins are exact", () => {
  const url = "https://media.discordapp.net/attachments/111111111111111111/222222222222222222/a.mp4?ex=1";
  const rotated = "https://cdn.discordapp.com/attachments/111111111111111111/222222222222222222/a.mp4?ex=2&hm=new";
  assert.equal(MediaStore.cacheRequestUrl(url), MediaStore.cacheRequestUrl(url));
  assert.equal(MediaStore.mediaStorageKey(url), MediaStore.mediaStorageKey(rotated));
  assert.equal(MediaStore.cacheRequestUrl(url), MediaStore.cacheRequestUrl(rotated));
  assert.equal(MediaStore.permissionOrigin(url), "https://media.discordapp.net");
  assert.equal(MediaStore.safeRedirect(url, "https://cdn.discordapp.com/attachments/1/2/a.mp4"), true);
  assert.equal(MediaStore.safeRedirect(url, "https://example.com/a.mp4"), false);
  assert.equal(MediaStore.fetchableMedia({ url, kind: "video", cacheable: true }), true);
  assert.equal(MediaStore.fetchableMedia({ url, kind: "link", cacheable: false }), false);
  const deduped = MediaStore.dedupeRefs([
    { ownerKey: "1:1", media: { url, kind: "video", source: "attachment", cacheable: true } },
    { ownerKey: "1:2", deleted: true, media: { url, kind: "video", source: "attachment", cacheable: true } }
  ]);
  assert.equal(deduped.length, 1);
  assert.deepEqual(deduped[0].ownerKeys, ["1:1", "1:2"]);
  assert.equal(deduped[0].deleted, true);
});

test("ownership repair is rebuilt from every archive reference, including posters", () => {
  const url = "https://cdn.discordapp.com/attachments/111111111111111111/222222222222222222/a.mp4?ex=1";
  const poster = "https://media.discordapp.net/attachments/111111111111111111/333333333333333333/poster.png?ex=1";
  const owners = MediaStore.expectedOwnerMap([
    { channelId: "111111111111111111", messageId: "444444444444444444", status: "seen", media: [{ url, posterUrl: poster, kind: "video", source: "attachment", cacheable: true }] },
    { channelId: "111111111111111111", messageId: "555555555555555555", status: "confirmed_deleted", media: [{ url, kind: "video", source: "attachment", cacheable: true }] }
  ]);
  assert.deepEqual(owners.get(MediaStore.mediaStorageKey(url)).ownerKeys, [
    "111111111111111111:444444444444444444",
    "111111111111111111:555555555555555555"
  ]);
  assert.equal(owners.get(MediaStore.mediaStorageKey(url)).protected, true);
  assert.deepEqual(owners.get(MediaStore.mediaStorageKey(poster)).ownerKeys, ["111111111111111111:444444444444444444"]);
});
