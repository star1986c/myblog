const MESSAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function resolveHermesChatMessageDeletion(rows, values) {
  const requestedIds = normalizeMessageDeletionIds(values);
  const parsedRows = (Array.isArray(rows) ? rows : []).map((row) => {
    let event = null;
    try {
      event = JSON.parse(String(row?.envelope || ""));
    } catch {
      // A corrupt row can still be removed when its authenticated outer id was selected.
    }
    return {
      seq: Number(row?.seq),
      id: String(row?.id || "").toLowerCase(),
      event,
    };
  });
  const requested = new Set(requestedIds);
  const targetSequences = new Set();
  const deletedIds = new Set();

  for (const row of parsedRows) {
    if (!requested.has(row.id)) continue;
    deletedIds.add(row.id);
    if (row.event?.type === "edit" && Number.isSafeInteger(row.event.targetSeq)) {
      targetSequences.add(row.event.targetSeq);
    } else if (Number.isSafeInteger(row.seq) && row.seq > 0) {
      targetSequences.add(row.seq);
    }
  }
  for (const row of parsedRows) {
    if (targetSequences.has(row.seq)) deletedIds.add(row.id);
    if (row.event?.type === "edit" && targetSequences.has(row.event.targetSeq)) {
      deletedIds.add(row.id);
    }
  }
  return { requestedIds, deletedIds: [...deletedIds] };
}

function normalizeMessageDeletionIds(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 100) {
    throw new Error("Hermes chat deletion requires 1 to 100 message ids.");
  }
  const ids = [...new Set(values.map((value) => String(value || "").toLowerCase()))];
  if (ids.length < 1 || ids.some((id) => !MESSAGE_ID_PATTERN.test(id))) {
    throw new Error("Invalid Hermes chat message id.");
  }
  return ids;
}

export { resolveHermesChatMessageDeletion };
