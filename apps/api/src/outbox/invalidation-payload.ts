/** Limits reactive Redis notifications to the fields needed for conservative invalidation. */
export function invalidationPayload(type: string, payload: unknown): unknown {
  if (
    type !== 'reactive.changed' ||
    typeof payload !== 'object' ||
    payload === null
  )
    return payload;
  const event = payload as Record<string, unknown>;
  const { schemaVersion, tenantId, documentId, table, operation, commitSeq } =
    event;
  return { schemaVersion, tenantId, documentId, table, operation, commitSeq };
}
