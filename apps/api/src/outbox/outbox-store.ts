export interface OutboxEvent {
  eventId: string;
  tenantId: string;
  type: string;
  aggregateId: string;
  payload: unknown;
}

export interface OutboxLease {
  event: OutboxEvent;
  token: string;
}

/** Coordinates durable delivery between workers through expiring, exclusive leases. */
export abstract class OutboxStore {
  abstract assertWorkerAccess(): Promise<void>;
  abstract claim(): Promise<OutboxLease | undefined>;

  /** Releases a failed delivery for retry if the worker still owns the lease. */
  abstract retry(lease: OutboxLease): Promise<void>;

  /** Marks a delivery complete only while the worker's lease is valid. */
  abstract acknowledge(lease: OutboxLease): Promise<void>;
}
