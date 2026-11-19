import type { JournalChange } from '../reactive/changelog/change-log.service.js';

type Change = Omit<JournalChange, 'eventId'>;

/** Omitted row images are treated as unknown by the invalidation engine. */
export function minimizeJournalChange(change: Change): Change {
  return {
    table: change.table,
    documentId: change.documentId,
    operation: change.operation,
  };
}
