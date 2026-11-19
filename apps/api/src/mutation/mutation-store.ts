import type { JournalChange } from '../reactive/changelog/change-log.service.js';
import type { MutationContext } from './mutation.types.js';

export interface MutationScope {
  tenantId: string;
  principalId: string;
  name: string;
  idempotencyKey: string;
}

export interface MutationReceipt {
  requestHash: string;
  response: unknown;
  commitSeq: string;
}

export interface MutationTransaction {
  /** The application handler's current PostgreSQL query interface. */
  readonly client: MutationContext['client'];
  readonly data: MutationContext['data'];

  /** Reserves a new key or returns the previously committed receipt. */
  reserve(requestHash: string): Promise<MutationReceipt | undefined>;

  /** Persists the journal, outbox, and receipt in the handler's transaction. */
  complete(
    response: string,
    changes: readonly JournalChange[],
  ): Promise<string>;
}

export type MutationRetryReason = 'serialization' | 'deadlock';

/** Storage contract for one atomic mutation, scoped to the verified identity. */
export abstract class MutationStore {
  abstract transaction<T>(
    scope: MutationScope,
    run: (transaction: MutationTransaction) => Promise<T>,
  ): Promise<T>;

  /** Recognizes failures known to have rolled back. Ambiguous failures must be surfaced. */
  abstract retryReason(error: unknown): MutationRetryReason | undefined;
}
