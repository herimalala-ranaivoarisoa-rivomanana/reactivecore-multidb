import type { PoolClient } from 'pg';
import type { TenantWriter } from '../database/tenant-data.js';
import type { QueryPrincipal } from '../reactive/contracts/query-context.js';
import type { JournalChange } from '../reactive/changelog/change-log.service.js';

export type MutationPrincipal = QueryPrincipal;

/** Invocation of a registered mutation with a key stable across retries. */
export interface MutationRequest {
  principal: MutationPrincipal;
  name: string;
  args: unknown;
  idempotencyKey: string;
}

/** Committed response returned from the original execution or its persisted receipt. */
export interface MutationResult {
  data: unknown;
  commitSeq: string;
  replayed: boolean;
}

/** Tenant-scoped transaction passed to a mutation handler. */
export interface MutationContext {
  /** PostgreSQL SQL access for existing handlers. */
  client: PoolClient;
  data: TenantWriter;
  principal: MutationPrincipal;
  /** Records a change to persist in the journal and outbox in the same commit. */
  recordChange(change: Omit<JournalChange, 'eventId'>): void;
}
