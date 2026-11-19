import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ChangeFeed } from '../contracts/change-feed.js';
import type {
  ChangeDescriptor,
  Dependency,
} from '../contracts/dependency.types.js';
import type { QueryPrincipal } from '../contracts/query-context.js';
import { DependencyIndex } from '../engine/dependency-index.js';
import { QueryExecutorService } from '../engine/query-executor.service.js';
import { InvalidationService } from '../invalidation/invalidation.service.js';

export interface SubscriptionResult {
  subscriptionId: string;
  data: unknown;
  revision: number;
  snapshotSeq: string;
}

interface Subscription {
  principal: QueryPrincipal;
  name: string;
  args: unknown;
  listener: (result: SubscriptionResult) => void;
  data: unknown;
  revision: number;
  coveredSeq: string;
  dependencies: Dependency[];
  detach?: () => void;
  generation: number;
  dirty: boolean;
  retry?: ReturnType<typeof setTimeout>;
}

@Injectable()
export class SubscriptionManagerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly running = new Set<string>();
  private readonly index: DependencyIndex;
  private readonly logger = new Logger(SubscriptionManagerService.name);
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private closed = false;

  constructor(
    private readonly executor: QueryExecutorService,
    private readonly invalidation: InvalidationService,
    private readonly journal: ChangeFeed,
  ) {
    this.index = new DependencyIndex(invalidation);
  }

  onModuleInit(): void {
    this.timer = setInterval(() => this.reconcileAll(), 1000);
    this.timer.unref();
  }

  /** Registers a subscription and closes it when the optional abort signal fires. */
  async subscribe(
    principal: QueryPrincipal,
    name: string,
    args: unknown,
    listener: (result: SubscriptionResult) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.closed) throw new Error('Subscription manager is closed');
    signal?.throwIfAborted();
    const id = randomUUID();
    const subscription: Subscription = {
      principal: structuredClone(principal),
      name,
      args: structuredClone(args),
      listener,
      data: undefined,
      revision: 0,
      coveredSeq: '0',
      dependencies: [],
      generation: 0,
      dirty: true,
    };
    this.subscriptions.set(id, subscription);
    if (signal) {
      const abort = () => this.unsubscribe(id);
      signal.addEventListener('abort', abort, { once: true });
      subscription.detach = () => signal.removeEventListener('abort', abort);
    }
    try {
      await this.refresh(id, subscription);
      if (!this.subscriptions.has(id))
        throw new Error('Subscription closed during initialization');
      if (subscription.dirty) this.scheduleRefresh(id, subscription);
      return id;
    } catch (error) {
      this.unsubscribe(id);
      throw error;
    }
  }

  /** Schedules affected subscriptions for a fresh query snapshot. */
  invalidate(change: ChangeDescriptor): void {
    const candidates = this.index.candidates(change);
    // A running query may discover dependencies absent from its previous result.
    for (const id of this.running) {
      if (this.subscriptions.get(id)?.principal.tenantId === change.tenantId)
        candidates.add(id);
    }
    for (const id of candidates) {
      const subscription = this.subscriptions.get(id);
      if (subscription) this.markDirty(id, subscription);
    }
  }

  /** Schedules a catch-up pass from the durable change log. */
  reconcileAll(): void {
    void this.poll().catch((error: unknown) => {
      if (!this.closed) this.logger.warn(error);
    });
  }

  private async poll(): Promise<void> {
    if (this.closed || this.polling || this.subscriptions.size === 0) return;
    this.polling = true;
    try {
      const through = await this.journal.currentSeq();
      for (const [id, subscription] of this.subscriptions) {
        if (this.running.has(id) || subscription.dirty || subscription.retry)
          continue;
        const after = subscription.coveredSeq;
        if (BigInt(after) >= BigInt(through)) continue;
        const batch = await this.journal.readBatch(
          subscription.principal.tenantId,
          after,
          through,
        );
        if (
          !this.subscriptions.has(id) ||
          this.running.has(id) ||
          subscription.dirty ||
          subscription.coveredSeq !== after
        )
          continue;
        const affected = batch.changes.some((change) =>
          subscription.dependencies.some((dependency) =>
            this.invalidation.affects(dependency, change),
          ),
        );
        if (affected) this.markDirty(id, subscription);
        else subscription.coveredSeq = batch.coveredSeq;
      }
    } finally {
      this.polling = false;
    }
  }

  private markDirty(id: string, subscription: Subscription): void {
    subscription.generation++;
    subscription.dirty = true;
    this.refreshInBackground(id, subscription);
  }

  private scheduleRefresh(id: string, subscription: Subscription): void {
    if (!this.subscriptions.has(id) || subscription.retry) return;
    subscription.retry = setTimeout(() => {
      subscription.retry = undefined;
      this.refreshInBackground(id, subscription);
    }, 1000);
    subscription.retry.unref();
  }

  private refreshInBackground(id: string, subscription: Subscription): void {
    if (this.running.has(id) || subscription.retry) return;
    void this.refresh(id, subscription)
      .catch((error: unknown) => {
        if (!this.subscriptions.has(id)) return;
        this.logger.warn(error);
        subscription.dirty = true;
      })
      .finally(() => {
        if (subscription.dirty) this.scheduleRefresh(id, subscription);
      });
  }

  private async refresh(id: string, subscription: Subscription): Promise<void> {
    this.running.add(id);
    try {
      for (let attempt = 0; attempt < 2 && subscription.dirty; attempt++) {
        subscription.dirty = false;
        const generation = subscription.generation;
        const result = await this.executor.execute(
          subscription.principal,
          subscription.name,
          subscription.args,
        );
        if (!this.subscriptions.has(id)) return;
        // Check the journal even if Redis was offline throughout the initial read.
        if (subscription.revision === 0 && attempt === 0) {
          const through = await this.journal.currentSeq();
          if (
            await this.journal.hasChanges(
              subscription.principal.tenantId,
              result.snapshotSeq,
              through,
            )
          ) {
            subscription.dirty = true;
          }
        }
        if (!this.subscriptions.has(id)) return;
        if (generation !== subscription.generation) subscription.dirty = true;
        if (subscription.dirty && attempt === 0) continue;

        this.index.replace(id, result.dependencies);
        subscription.dependencies = result.dependencies;
        subscription.coveredSeq = result.snapshotSeq;
        if (
          subscription.revision === 0 ||
          !isDeepStrictEqual(subscription.data, result.data)
        ) {
          subscription.data = result.data;
          subscription.revision++;
          try {
            subscription.listener({
              subscriptionId: id,
              data: structuredClone(result.data),
              revision: subscription.revision,
              snapshotSeq: result.snapshotSeq,
            });
          } catch (error) {
            this.logger.warn(error);
          }
        }
      }
    } finally {
      this.running.delete(id);
    }
  }

  unsubscribe(id: string): void {
    const subscription = this.subscriptions.get(id);
    clearTimeout(subscription?.retry);
    subscription?.detach?.();
    this.index.remove(id);
    this.subscriptions.delete(id);
  }

  onModuleDestroy(): void {
    this.closed = true;
    clearInterval(this.timer);
    for (const id of this.subscriptions.keys()) this.unsubscribe(id);
  }
}
