"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Core = require("../src/core.js");

const source = fs.readFileSync(path.join(__dirname, "../src/content.js"), "utf8");
const CHANNEL_ID = "777777777777777777";
const GUILD_ID = "666666666666666666";
const USER_ID = "999999999999999991";
const USERNAME = "curiousbro";
const surfaces = [
  { name: "live message", label: "Actions for message author", messageId: "888888888888888881" },
  { name: "deleted message", label: "Actions for deleted message author", messageId: "888888888888888882" }
];

function productionFunctions(startName, endName) {
  const start = source.indexOf(`  function ${startName}(`);
  const end = source.indexOf(`  function ${endName}(`, start);
  assert.ok(start >= 0 && end > start, `production function boundaries: ${startName} / ${endName}`);
  return source.slice(start, end);
}

// Execute the actual production click/resolve/copy functions, not a reimplementation.
// Only their browser boundaries are faked; renderer layout and Chrome injection are
// deliberately outside this harness.
const authorActionSource = [
  productionFunctions("resolvedAuthorIdentity", "resolvedAuthorId"),
  productionFunctions("suppressDiscordMessageGesture", "nativeHeaderActionInsertion"),
  "globalThis.createControls = createAuthorActionControls;"
].join("\n");

function createHarness(t, surface, options = {}) {
  const clipboardAttempts = [];
  const clipboardWrites = [];
  const legacyAttempts = [];
  const requests = [];
  const queuedRecords = [];
  const timers = new Map();
  let selected = null;
  let nextTimer = 0;
  let rowCurrent = true;

  function createElement(tagName) {
    const listeners = new Map();
    const attributes = new Map();
    const element = {
      tagName: tagName.toUpperCase(),
      children: [], parentElement: null, dataset: {}, style: {}, className: "", textContent: "",
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      append(...children) {
        for (const child of children) {
          child.parentElement = this;
          this.children.push(child);
        }
      },
      remove() {
        if (this.parentElement) {
          const siblings = this.parentElement.children;
          siblings.splice(siblings.indexOf(this), 1);
          this.parentElement = null;
        }
      },
      select() { selected = this; },
      addEventListener(type, callback) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(callback);
      },
      dispatch(event, pending) {
        for (const callback of listeners.get(event.type) || []) pending.push(callback(event));
        if (!event.stopped && this.parentElement) this.parentElement.dispatch(event, pending);
      },
      click() {
        if (this.disabled) return Promise.resolve();
        const pending = [];
        this.dispatch({ type: "click", stopPropagation() { this.stopped = true; } }, pending);
        return Promise.all(pending);
      }
    };
    element.classList = {
      contains(name) { return element.className.split(/\s+/).includes(name); },
      toggle(name, enabled) {
        const names = new Set(element.className.split(/\s+/).filter(Boolean));
        if (enabled) names.add(name);
        else names.delete(name);
        element.className = [...names].join(" ");
      },
      remove(name) { this.toggle(name, false); }
    };
    return element;
  }

  const document = {
    body: createElement("body"),
    createElement,
    execCommand(command) {
      assert.equal(command, "copy");
      assert.equal(selected?.tagName, "TEXTAREA");
      assert.equal(selected.parentElement, document.body);
      assert.equal(selected.getAttribute("readonly"), "");
      legacyAttempts.push(selected.value);
      if (options.legacyFails) return false;
      clipboardWrites.push(selected.value);
      return true;
    }
  };
  const context = {
    channelId: CHANNEL_ID, messageId: surface.messageId, guildId: GUILD_ID,
    userId: USER_ID, username: options.username || null, author: "Rizzist",
    isCurrent: () => rowCurrent
  };
  const state = {
    route: { channelId: CHANNEL_ID, guildId: GUILD_ID, routeKey: `${GUILD_ID}/${CHANNEL_ID}` },
    resolvedAuthorIds: new Map(), resolvedAuthorUsernames: new Map(), pendingTimeoutActions: new Set(),
    archive: { records: surface.name === "deleted message" ? [{
      channelId: CHANNEL_ID, messageId: surface.messageId, guildId: GUILD_ID,
      authorId: USER_ID, author: "Rizzist", status: "confirmed_deleted"
    }] : [] }
  };
  if (options.username) {
    state.resolvedAuthorIds.set(`${CHANNEL_ID}:${surface.messageId}`, USER_ID);
    state.resolvedAuthorUsernames.set(`${CHANNEL_ID}:${surface.messageId}`, options.username);
  }
  const sandbox = {
    Core, state, document,
    SNOWFLAKE: /^\d{15,25}$/,
    RESOLVE_MESSAGE_AUTHORS: "LDMA_RESOLVE_MESSAGE_AUTHORS",
    navigator: options.clipboardMissing ? {} : { clipboard: {
      async writeText(value) {
        clipboardAttempts.push(value);
        if (options.clipboardFails) throw new Error("clipboard denied");
        clipboardWrites.push(value);
      }
    } },
    async send(message) {
      requests.push(JSON.parse(JSON.stringify(message)));
      if (options.resolve) return options.resolve(message);
      return {
        ok: true,
        authors: [{ messageId: surface.messageId, userId: USER_ID, username: USERNAME }],
        reason: "message-authors-resolved"
      };
    },
    queueRecord(record) { queuedRecords.push(record); },
    queueAuthorResolution() {},
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  };
  vm.runInNewContext(authorActionSource, sandbox, { filename: "content-author-actions.js", timeout: 1000 });
  const controls = sandbox.createControls(surface.label, () => context);
  controls.update(context);
  t.after(() => controls.update.dispose());
  return {
    controls, context, state, document, clipboardAttempts, clipboardWrites, legacyAttempts, requests, queuedRecords,
    invalidateRow() { rowCurrent = false; }
  };
}

function assertCopied(harness) {
  assert.deepEqual(harness.clipboardWrites, [USERNAME]);
  assert.equal(harness.clipboardWrites.includes("Rizzist"), false);
  assert.equal(harness.clipboardWrites.includes(USER_ID), false);
  assert.equal(harness.controls.copyAction.textContent, "✓");
  assert.equal(harness.controls.copyAction.title, "Discord username copied");
  assert.equal(harness.controls.copyAction.classList.contains("error"), false);
  assert.equal(harness.controls.copyAction.disabled, false);
}

function assertNoCopy(harness) {
  assert.deepEqual(harness.clipboardWrites, []);
  assert.deepEqual(harness.clipboardAttempts, []);
  assert.deepEqual(harness.legacyAttempts, []);
  assert.equal(harness.controls.copyAction.textContent, "!");
  assert.equal(harness.controls.copyAction.classList.contains("error"), true);
  assert.equal(harness.controls.copyAction.disabled, false);
}

for (const surface of surfaces) {
  test(`${surface.name}: click resolves and writes the Discord username, not display name or ID`, async (t) => {
    const harness = createHarness(t, surface);
    assert.equal(harness.context.username, null);
    assert.equal(harness.controls.actions.getAttribute("aria-label"), surface.label);
    await harness.controls.copyAction.click();
    assertCopied(harness);
    assert.deepEqual(harness.clipboardAttempts, [USERNAME]);
    assert.deepEqual(harness.requests, [{ type: "LDMA_RESOLVE_MESSAGE_AUTHORS", messageIds: [surface.messageId] }]);
    assert.equal(harness.state.resolvedAuthorUsernames.get(`${CHANNEL_ID}:${surface.messageId}`), USERNAME);
    if (surface.name === "deleted message") {
      assert.equal(harness.queuedRecords.length, 1);
      assert.equal(harness.queuedRecords[0].authorUsername, USERNAME);
      assert.equal(harness.queuedRecords[0].author, "Rizzist");
    }
  });

  test(`${surface.name}: cached username copies directly without another resolver request`, async (t) => {
    const harness = createHarness(t, surface, { username: USERNAME });
    await harness.controls.copyAction.click();
    assertCopied(harness);
    assert.deepEqual(harness.requests, []);
    assert.deepEqual(harness.legacyAttempts, []);
  });

  test(`${surface.name}: rejected Clipboard API falls back to copying the same username`, async (t) => {
    const harness = createHarness(t, surface, { clipboardFails: true });
    await harness.controls.copyAction.click();
    assertCopied(harness);
    assert.deepEqual(harness.clipboardAttempts, [USERNAME]);
    assert.deepEqual(harness.legacyAttempts, [USERNAME]);
    assert.deepEqual(harness.document.body.children, []);
  });

  test(`${surface.name}: an ID-only resolution never copies the display name or numeric ID`, async (t) => {
    const harness = createHarness(t, surface, { resolve: () => ({
      ok: true, authors: [{ messageId: surface.messageId, userId: USER_ID }]
    }) });
    await harness.controls.copyAction.click();
    assertNoCopy(harness);
    assert.equal(harness.controls.copyAction.title, "Discord username unavailable");
  });

  for (const change of ["channel changed", "row stale"]) {
    test(`${surface.name}: no copy when ${change} while author resolution is in flight`, async (t) => {
      let finishResolution;
      const response = new Promise((resolve) => { finishResolution = resolve; });
      const harness = createHarness(t, surface, { resolve: () => response });
      const pendingClick = harness.controls.copyAction.click();
      assert.equal(harness.requests.length, 1);
      assert.equal(harness.controls.copyAction.disabled, true);
      if (change === "channel changed") {
        harness.state.route = { channelId: "777777777777777778", routeKey: `${GUILD_ID}/777777777777777778` };
      } else {
        harness.invalidateRow();
      }
      finishResolution({
        ok: true, authors: [{ messageId: surface.messageId, userId: USER_ID, username: USERNAME }]
      });
      await pendingClick;
      assertNoCopy(harness);
    });
  }
}

test("missing Clipboard API uses and removes the legacy textarea", async (t) => {
  const harness = createHarness(t, surfaces[0], { clipboardMissing: true });
  await harness.controls.copyAction.click();
  assertCopied(harness);
  assert.deepEqual(harness.clipboardAttempts, []);
  assert.deepEqual(harness.legacyAttempts, [USERNAME]);
  assert.deepEqual(harness.document.body.children, []);
});

test("clipboard failure reports failure rather than claiming a copy", async (t) => {
  const harness = createHarness(t, surfaces[0], { clipboardFails: true, legacyFails: true });
  await harness.controls.copyAction.click();
  assert.deepEqual(harness.clipboardWrites, []);
  assert.deepEqual(harness.clipboardAttempts, [USERNAME]);
  assert.deepEqual(harness.legacyAttempts, [USERNAME]);
  assert.equal(harness.controls.copyAction.title, "Clipboard access unavailable");
  assert.equal(harness.controls.copyAction.textContent, "!");
  assert.equal(harness.controls.copyAction.classList.contains("error"), true);
  assert.equal(harness.controls.copyAction.disabled, false);
  assert.deepEqual(harness.document.body.children, []);
});

test("a stale row cannot use even an already cached username", async (t) => {
  const harness = createHarness(t, surfaces[0], { username: USERNAME });
  harness.invalidateRow();
  await harness.controls.copyAction.click();
  assertNoCopy(harness);
  assert.deepEqual(harness.requests, []);
});

for (const [reason, title] of [
  ["author-resolution-controller-unavailable", "Discord author resolver unavailable"],
  ["author-resolution-controller-error", "Discord author lookup failed"],
  ["author-resolution-route-changed", "Discord channel changed"],
  ["author-resolution-result-unavailable", "Discord author lookup returned no result"],
  ["author-resolution-injection-failed", "Discord author lookup could not run"],
  ["message-store-unavailable", "Discord message data unavailable"],
  ["message-author-resolution-failed", "Discord author lookup failed"],
  ["unknown-failure", "Discord username unavailable"]
]) {
  test(`copy feedback preserves the specific resolver failure: ${reason}`, async (t) => {
    const harness = createHarness(t, surfaces[0], { resolve: () => ({ ok: false, reason }) });
    await harness.controls.copyAction.click();
    assertNoCopy(harness);
    assert.equal(harness.controls.copyAction.title, title);
    assert.equal(harness.controls.actions.children[2].textContent, title);
  });
}
