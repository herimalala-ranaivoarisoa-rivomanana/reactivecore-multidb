import type { ChangeDescriptor } from './dependency.types.js';

export interface SequencedChange extends ChangeDescriptor {
  seq: string;
  ordinal: number;
  eventId: string;
}

/** Durable, tenant-scoped change feed used to catch subscriptions up to a commit. */
export abstract class ChangeFeed {
  abstract currentSeq(): Promise<string>;

  abstract hasChanges(
    tenantId: string,
    afterSeq: string,
    throughSeq: string,
  ): Promise<boolean>;

  /** Reads whole commits in (afterSeq, throughSeq] and reports the boundary covered. */
  abstract readBatch(
    tenantId: string,
    afterSeq: string,
    throughSeq: string,
  ): Promise<{ changes: SequencedChange[]; coveredSeq: string }>;
}
