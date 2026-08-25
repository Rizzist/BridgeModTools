(function runDemo() {
  "use strict";

  const Core = globalThis.LocalDiscordArchiveCore;
  const list = document.getElementById("messages");
  const result = document.getElementById("result");
  const original = list.innerHTML;

  function acceptedSignal(overrides) {
    return Object.assign({
      candidateKnown: true,
      documentHidden: false,
      routeChanged: false,
      sameChannel: true,
      rootReplacement: false,
      removedMessageCount: 1,
      totalRemovedElementCount: 4,
      addedMessageCount: 0,
      msSinceScroll: 5000,
      msSinceRouteChange: 5000,
      targetConnected: true,
      listUnchanged: true,
      parentUnchanged: true,
      wasVisible: true,
      visibleRatio: 1,
      innerViewport: true,
      snapshotAgeMs: 100,
      currentlyPresent: false,
      previousAnchorPresent: true,
      nextAnchorPresent: true,
      anchorsAdjacent: true,
      previousAnchorDeltaPx: 0
    }, overrides || {});
  }

  function showDecision(decision) {
    result.textContent = `${decision.highConfidence ? "Tombstone inserted" : "No tombstone"} — ${decision.reason}.`;
  }

  document.getElementById("delete-one").addEventListener("click", () => {
    const target = list.querySelector("[data-id='102']");
    if (!target) return;
    const content = target.querySelector("p").textContent;
    target.remove();
    const decision = Core.classifyRemoval(acceptedSignal());
    if (decision.highConfidence) {
      const tombstone = document.createElement("li");
      tombstone.className = "tombstone";
      const label = document.createElement("b");
      label.textContent = "Locally preserved — removed from Discord view";
      const text = document.createElement("span");
      text.textContent = content;
      tombstone.append(label, text);
      list.insertBefore(tombstone, list.querySelector("[data-id='103']"));
    }
    showDecision(decision);
  });

  document.getElementById("scroll-unload").addEventListener("click", () => {
    list.querySelector("[data-id='102']")?.remove();
    showDecision(Core.classifyRemoval(acceptedSignal({ msSinceScroll: 20 })));
  });

  document.getElementById("mass-remove").addEventListener("click", () => {
    list.querySelectorAll("[data-id]").forEach((node) => node.remove());
    showDecision(Core.classifyRemoval(acceptedSignal({
      routeChanged: true,
      sameChannel: false,
      rootReplacement: true,
      removedMessageCount: 4,
      totalRemovedElementCount: 60
    })));
  });

  document.getElementById("reset").addEventListener("click", () => {
    list.innerHTML = original;
    result.textContent = "Ready.";
  });
})();
