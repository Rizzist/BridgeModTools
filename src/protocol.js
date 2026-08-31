(function attachProtocol(root) {
  "use strict";

  const Core = root.LocalDiscordArchiveCore || (typeof require === "function" ? require("./core.js") : null);
  const TYPES = Object.freeze({
    GET_ARCHIVE: "LDMA_GET_ARCHIVE",
    GET_RECORD: "LDMA_GET_RECORD",
    UPSERT_RECORDS: "LDMA_UPSERT_RECORDS",
    CONFIRM_EDIT: "LDMA_CONFIRM_EDIT",
    CONFIRM_DELETED: "LDMA_CONFIRM_DELETED",
    INFER_DELETED: "LDMA_INFER_DELETED",
    RETRACT_MESSAGE: "LDMA_RETRACT_MESSAGE",
    SET_PAUSED: "LDMA_SET_PAUSED",
    CLEAR_ARCHIVE: "LDMA_CLEAR_ARCHIVE",
    DELETE_RECORD: "LDMA_DELETE_RECORD",
    SET_HEALTH: "LDMA_SET_HEALTH",
    CACHE_MEDIA: "LDMA_CACHE_MEDIA",
    CACHE_ALL_MEDIA: "LDMA_CACHE_ALL_MEDIA",
    GET_MEDIA_STATS: "LDMA_GET_MEDIA_STATS",
    CREATE_MEDIA_CAPABILITY: "LDMA_CREATE_MEDIA_CAPABILITY",
    REDEEM_MEDIA_CAPABILITY: "LDMA_REDEEM_MEDIA_CAPABILITY"
  });

  function emptyArchive() {
    return {
      version: 6,
      generation: 0,
      revision: 0,
      paused: false,
      health: {
        status: "starting",
        detail: "Open a Discord channel; capture connects without a manual page refresh.",
        updatedAt: 0
      },
      records: []
    };
  }

  function normalizeArchive(value) {
    const base = emptyArchive();
    if (!value || !Array.isArray(value.records)) return base;
    return Object.assign(base, value, {
      version: 6,
      generation: Number.isInteger(value.generation) ? value.generation : 0,
      revision: Number.isInteger(value.revision) ? value.revision : 0,
      paused: Boolean(value.paused),
      records: Core.pruneRecords(value.records.map(Core.sanitizeRecordPresentation))
    });
  }

  function stale(archive, command) {
    return !Number.isInteger(command.generation) || command.generation !== archive.generation;
  }

  function changedArchive(archive, patch) {
    return Object.assign({}, archive, patch, { revision: archive.revision + 1 });
  }

  function shouldApplyArchive(currentValue, incomingValue) {
    const current = normalizeArchive(currentValue);
    const incoming = normalizeArchive(incomingValue);
    if (incoming.generation < current.generation) return false;
    if (incoming.generation === current.generation && incoming.revision < current.revision) return false;
    return true;
  }

  function newerCapturedSnapshot(existing, incoming) {
    if (!existing) return true;
    if (existing.status === "confirmed_deleted") return false;
    if (existing.captureSessionId && existing.captureSessionId === incoming.captureSessionId &&
      existing.captureSequence && incoming.captureSequence) {
      return incoming.captureSequence > existing.captureSequence;
    }
    const existingTime = Number(existing.capturedAt) || 0;
    const incomingTime = Number(incoming.capturedAt) || 0;
    return Number.isFinite(incomingTime) && incomingTime > existingTime;
  }

  function applyCommand(current, command, nowValue) {
    const archive = normalizeArchive(current);
    const now = nowValue || Date.now();
    const unchanged = (accepted, reason, data) => ({ archive, accepted, changed: false, reason, data });
    if (!command || !command.type) return unchanged(false, "invalid-command");
    if (command.type === TYPES.GET_ARCHIVE) return unchanged(true, "read", archive);
    if (command.type === TYPES.GET_RECORD) {
      const record = archive.records.find((item) => Core.recordKey(item) === String(command.key || "")) || null;
      return unchanged(true, record ? "record-read" : "record-missing", record);
    }

    if (command.type === TYPES.SET_PAUSED) {
      const next = changedArchive(archive, {
        generation: archive.generation + 1,
        paused: Boolean(command.paused)
      });
      return { archive: next, accepted: true, changed: true, reason: "pause-changed", data: next };
    }
    if (command.type === TYPES.CLEAR_ARCHIVE) {
      const next = changedArchive(archive, {
        generation: archive.generation + 1,
        records: []
      });
      return { archive: next, accepted: true, changed: true, reason: "cleared", data: next };
    }
    if (command.type === TYPES.DELETE_RECORD) {
      const next = changedArchive(archive, {
        generation: archive.generation + 1,
        records: archive.records.filter((record) => Core.recordKey(record) !== command.key)
      });
      return { archive: next, accepted: true, changed: true, reason: "record-deleted", data: next };
    }
    if (command.type === TYPES.SET_HEALTH) {
      const next = changedArchive(archive, {
        health: {
          status: command.status || "degraded",
          detail: command.detail || "Capture support is degraded.",
          updatedAt: now
        }
      });
      return { archive: next, accepted: true, changed: true, reason: "health-updated", data: next };
    }

    if (stale(archive, command)) return unchanged(false, "stale-generation", archive);
    if (archive.paused && (command.type === TYPES.UPSERT_RECORDS || command.type === TYPES.CONFIRM_EDIT || command.type === TYPES.CONFIRM_DELETED || command.type === TYPES.INFER_DELETED)) {
      return unchanged(false, "paused", archive);
    }

    if (command.type === TYPES.UPSERT_RECORDS) {
      const next = changedArchive(archive, {
        records: Core.mergeRecords(archive.records, command.records || [], { now })
      });
      return { archive: next, accepted: true, changed: true, reason: "records-upserted", data: next };
    }
    if (command.type === TYPES.CONFIRM_EDIT) {
      const baseline = Core.sanitizeRecordPresentation(command.record);
      if (!baseline?.messageId || !baseline?.channelId) return unchanged(false, "missing-record");
      const sessionId = Core.normalizeText(command.editSessionId).slice(0, 100);
      const sequence = Math.max(0, Math.floor(Number(command.editSequence) || 0));
      const supersededAt = Number(command.editedAt);
      if (!sessionId || !sequence || !Number.isFinite(supersededAt) || supersededAt <= 0) {
        return unchanged(false, "invalid-edit-lifecycle");
      }
      const key = Core.recordKey(baseline);
      const existing = archive.records.find((record) => Core.recordKey(record) === key) || null;
      const mergedReply = Core.mergeReplySnapshots(existing?.reply, baseline.reply);
      const revisionId = `${sessionId}:${sequence}`;
      if (existing?.editHistory?.some((revision) => revision.revisionId === revisionId)) {
        return unchanged(true, "duplicate-edit", archive);
      }
      const revision = Core.editRevisionFromRecord(baseline, { revisionId, supersededAt });
      const history = Core.sanitizeEditHistory([...(existing?.editHistory || []), revision]
        .sort((left, right) => (Number(left.supersededAt) || 0) - (Number(right.supersededAt) || 0) ||
          String(left.revisionId || "").localeCompare(String(right.revisionId || ""))));
      const olderSameSession = existing?.editSessionId === sessionId && Number(existing.lastEditSequence) >= sequence;
      if (olderSameSession) {
        if (JSON.stringify(history) === JSON.stringify(existing.editHistory || [])) {
          return unchanged(true, "duplicate-edit-payload", archive);
        }
        const next = changedArchive(archive, {
          records: Core.pruneRecords([
            ...archive.records.filter((record) => Core.recordKey(record) !== key),
            Object.assign({}, existing, mergedReply ? { reply: mergedReply } : {}, { editHistory: history, updatedAt: now })
          ])
        });
        return { archive: next, accepted: true, changed: true, reason: "out-of-order-edit", data: next };
      }
      if (existing && Number(existing.lastEditedAt) >= supersededAt) {
        return unchanged(true, "stale-edit", archive);
      }
      const current = Object.assign({}, existing || baseline, mergedReply ? { reply: mergedReply } : {}, {
        editHistory: history,
        lastEditedAt: supersededAt,
        editSessionId: sessionId,
        lastEditSequence: sequence,
        updatedAt: now
      });
      const next = changedArchive(archive, {
        records: Core.pruneRecords([
          ...archive.records.filter((record) => Core.recordKey(record) !== key),
          current
        ])
      });
      return { archive: next, accepted: true, changed: true, reason: "edit-confirmed", data: next };
    }
    if (command.type === TYPES.CONFIRM_DELETED) {
      const deletions = (Array.isArray(command.deletions) ? command.deletions : []).slice(0, 200);
      const existingByKey = new Map(archive.records.map((record) => [Core.recordKey(record), record]));
      const confirmed = deletions.filter((item) => item && item.record &&
        (existingByKey.has(Core.recordKey(item.record)) || item.source === "message_store_preserved"))
        .map((item) => {
          const incomingRecord = Core.sanitizeRecordPresentation(item.record);
          const existingRecord = existingByKey.get(Core.recordKey(item.record));
          const newerSnapshot = newerCapturedSnapshot(existingRecord, incomingRecord);
          let observedRecord = existingRecord || incomingRecord;
          if (existingRecord && newerSnapshot) {
            // A retained deletion may arrive before its latest seen UPSERT. Use
            // observation freshness, not broker arrival time, to select its body.
            // Only CONFIRM_EDIT owns the accumulated edit history and cursor.
            const observed = Object.assign({}, incomingRecord, { status: "seen" });
            for (const field of ["editHistory", "editSessionId", "lastEditSequence", "lastEditedAt"]) delete observed[field];
            observedRecord = Core.mergeRecords([existingRecord], [observed], {
              now,
              // This is a one-record merge, not archive admission. The final
              // merge below still enforces the ordinary archive byte bound.
              maxBytes: Number.MAX_SAFE_INTEGER
            })[0] || existingRecord;
          }
          if (existingRecord?.status === "confirmed_deleted" && incomingRecord.mentions?.length &&
            String(existingRecord.content || "") === String(incomingRecord.content || "")) {
            // A retained MessageStore event can race an ordinary delete
            // confirmation. Permit one exact-body enrichment with the
            // deletion-time mention bindings without reopening the body,
            // edit history, reply, or lifecycle truth.
            observedRecord = Object.assign({}, observedRecord, { mentions: incomingRecord.mentions });
          }
          const reply = existingRecord?.status === "confirmed_deleted" ? existingRecord.reply
            : newerSnapshot ? Core.mergeReplySnapshots(existingRecord?.reply, incomingRecord?.reply)
              : existingRecord?.reply || incomingRecord?.reply;
          return Object.assign({}, observedRecord, reply ? { reply } : {}, {
            status: "confirmed_deleted",
            confirmedDeletedAt: now,
            deletionSource: item.source === "message_store_preserved" ? "message_store_preserved" : "discord_lifecycle",
            inferredPreviousId: item.previousId || null,
            inferredNextId: item.nextId || null,
            inferredTail: Boolean(item.tail),
            inferredListIdentity: item.listIdentity || null,
            updatedAt: now
          });
        });
      if (!confirmed.length) return unchanged(false, "missing-records");
      const next = changedArchive(archive, {
        records: Core.mergeRecords(archive.records, confirmed, { now })
      });
      return { archive: next, accepted: true, changed: true, reason: "deletion-confirmed", data: next };
    }
    if (command.type === TYPES.INFER_DELETED) {
      if (!command.record) return unchanged(false, "missing-record");
      const deleted = Object.assign({}, command.record, {
        status: "inferred_deleted",
        inferredDeletedAt: now,
        inferredPreviousId: command.previousId || null,
        inferredNextId: command.nextId || null,
        inferredTail: Boolean(command.tail),
        inferredListIdentity: command.listIdentity || null,
        updatedAt: now
      });
      const next = changedArchive(archive, {
        records: Core.mergeRecords(archive.records, [deleted], { now })
      });
      return { archive: next, accepted: true, changed: true, reason: "deletion-inferred", data: next };
    }
    if (command.type === TYPES.RETRACT_MESSAGE) {
      let found = false;
      const records = archive.records.map((record) => {
        if (Core.recordKey(record) !== command.key || record.status !== "inferred_deleted") return record;
        found = true;
        const next = Object.assign({}, record, { status: "seen", updatedAt: now });
        delete next.inferredDeletedAt;
        delete next.inferredPreviousId;
        delete next.inferredNextId;
        delete next.inferredTail;
        delete next.inferredListIdentity;
        return next;
      });
      if (!found) return unchanged(true, "nothing-to-retract", archive);
      const next = changedArchive(archive, { records: Core.pruneRecords(records) });
      return { archive: next, accepted: true, changed: true, reason: "deletion-retracted", data: next };
    }
    return unchanged(false, "unknown-command");
  }

  const api = Object.freeze({ TYPES, emptyArchive, normalizeArchive, shouldApplyArchive, applyCommand });
  root.LocalDiscordArchiveProtocol = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
