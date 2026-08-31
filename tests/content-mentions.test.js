"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Core = require("../src/core.js");

const source = fs.readFileSync(path.join(__dirname, "../src/content.js"), "utf8");

function productionFunction(name) {
  const start = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(source);
  assert.ok(start, `production function exists: ${name}`);
  const remainder = source.slice(start.index);
  const end = /^  }\r?$/m.exec(remainder);
  assert.ok(end, `production function ends: ${name}`);
  return remainder.slice(0, end.index + end[0].length);
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName || "span").toUpperCase();
    this.childNodes = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.type = "";
    this.className = "";
  }

  get firstChild() { return this.childNodes[0] || null; }
  get textContent() { return this.childNodes.map((item) => item.nodeValue ?? item.textContent ?? "").join(""); }
  set textContent(value) { this.replaceChildren({ nodeType: 3, nodeValue: String(value) }); }
  replaceChildren(...nodes) { this.childNodes = nodes; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }
  getBoundingClientRect() { return { left: 120, top: 240, width: 70, height: 22 }; }
  dispatch(type) {
    const event = { currentTarget: this, stopPropagation() {} };
    for (const callback of this.listeners.get(type) || []) callback(event);
  }
}

function createHarness() {
  const sent = [];
  const document = {
    createTextNode(value) { return { nodeType: 3, nodeValue: String(value) }; },
    createElement(tagName) { return new FakeElement(tagName); },
    getElementById() { return null; },
    createRange() {
      let endElement = null;
      return {
        setStart() {},
        setEnd(element) { endElement = element; },
        toString() { return endElement?.prefix || ""; }
      };
    }
  };
  const context = vm.createContext({
    Core,
    SNOWFLAKE: /^\d{15,25}$/,
    MAX_MENTION_TOKENS: 50,
    Node: { TEXT_NODE: 3 },
    document,
    send: async (command) => { sent.push(command); return { ok: true }; }
  });
  vm.runInContext([
    "captureMentionSpans", "replaceText", "suppressDiscordMessageGesture", "openCompactProfile", "renderMentionedContent"
  ].map(productionFunction).join("\n"), context);
  return { context, sent };
}

test("native mention spans bind only when every ordered Discord token matches the rendered body", () => {
  const { context } = createHarness();
  const makeMention = (text, prefix) => ({
    textContent: text,
    prefix,
    getAttribute(name) { return name === "role" ? "button" : null; }
  });
  const elements = [
    makeMention("@here", ""),
    makeMention("@MauveXD", "@here ban "),
    makeMention("@Staff", "@here ban @MauveXD and ")
  ];
  const exact = { querySelectorAll: () => elements };
  const row = { querySelector: () => exact, contains: (value) => value === exact };
  const content = "@here ban @MauveXD and @Staff";
  const bound = context.captureMentionSpans(row, "888888888888888881", content, [
    { kind: "broadcast" },
    { kind: "user", userId: "111111111111111111" },
    { kind: "role" }
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(bound)), [
    { start: 10, end: 18, userId: "111111111111111111" }
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(context.captureMentionSpans(
    row, "888888888888888881", content, [{ kind: "user", userId: "111111111111111111" }]
  ))), [], "a partial or ambiguous token sequence must fail closed");
});

test("restored user mentions render as compact-profile buttons with exact identity and anchor", async () => {
  const { context, sent } = createHarness();
  const element = new FakeElement("span");
  const record = {
    content: "ban @MauveXD bot",
    guildId: "666666666666666666",
    mentions: [{ start: 4, end: 12, userId: "111111111111111111" }]
  };
  context.renderMentionedContent(element, record);
  assert.equal(element.childNodes.length, 3);
  assert.equal(element.childNodes[0].nodeValue, "ban ");
  const button = element.childNodes[1];
  assert.equal(button.tagName, "BUTTON");
  assert.equal(button.className, "content-mention");
  assert.equal(button.textContent, "@MauveXD");
  assert.equal(button.getAttribute("aria-expanded"), "false");
  assert.match(button.getAttribute("aria-label"), /Open MauveXD's profile/);
  assert.equal(element.childNodes[2].nodeValue, " bot");
  button.dispatch("click");
  await Promise.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{
    type: "LDMA_USER_ACTION",
    action: "open-profile",
    userId: "111111111111111111",
    guildId: "666666666666666666",
    anchor: { left: 120, top: 240, width: 70, height: 22 }
  }]);
});

test("malformed and stale mention ranges remain inert plain text", () => {
  const { context, sent } = createHarness();
  for (const mentions of [
    [{ start: 4, end: 12, userId: "invalid" }],
    [{ start: 0, end: 3, userId: "111111111111111111" }],
    [{ start: 4, end: 999, userId: "111111111111111111" }]
  ]) {
    const element = new FakeElement("span");
    context.renderMentionedContent(element, { content: "ban @MauveXD bot", guildId: null, mentions });
    assert.equal(element.childNodes.length, 1);
    assert.equal(element.textContent, "ban @MauveXD bot");
    assert.equal(element.firstChild.nodeType, 3);
  }
  assert.deepEqual(sent, []);
});
