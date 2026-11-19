import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID, randomInt } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { isIdempotencyKey } from './idempotency-key.js';
import type { JournalChange } from '../reactive/changelog/change-log.service.js';
import {
  MutationStore,
  type MutationScope,
  type MutationTransaction,
} from './mutation-store.js';
import { MutationRegistryService } from './mutation-registry.service.js';
import type { MutationRequest, MutationResult } from './mutation.types.js';

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${Array.from(value, canonicalJson).join(',')}]`;
  if (
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`;
  }
  throw new BadRequestException('Mutation arguments must be JSON values');
}

@Injectable()
export class MutationEngineService {
  private readonly metrics = {
    serializationFailures: 0,
    deadlocks: 0,
    retries: 0,
    exhausted: 0,
  };

  retryMetrics() {
    return { ...this.metrics };
  }

  constructor(
    private readonly store: MutationStore,
    private readonly registry: MutationRegistryService,
  ) {}

  /** Retries the entire transaction on serialization failures and deadlocks. */
  async runSerializable<T>(
    scope: MutationScope,
    run: (transaction: MutationTransaction) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.store.transaction(scope, run);
      } catch (error) {
        const reason = this.store.retryReason(error);
        if (!reason) throw error;
        if (reason === 'serialization') this.metrics.serializationFailures++;
        else this.metrics.deadlocks++;
        if (attempt >= 5) {
          this.metrics.exhausted++;
          throw new ServiceUnavailableException(
            'Transaction retry limit exhausted',
            { cause: error },
          );
        }
        this.metrics.retries++;
        await setTimeout(randomInt(10, 21) * 2 ** attempt);
      }
    }
  }

  /** Executes a mutation or returns its stored receipt within the same idempotency scope. */
  async execute({
    principal,
    name,
    args,
    idempotencyKey,
  }: MutationRequest): Promise<MutationResult> {
    if (!isIdempotencyKey(idempotencyKey)) {
      throw new BadRequestException('Idempotency-Key must be a UUID');
    }
    const handler = this.registry.get(name);
    const validated = handler.validate(args);
    handler.authorize(principal, validated);
    const hash = createHash('sha256')
      .update(canonicalJson(validated))
      .digest('hex');
    const scope: MutationScope = {
      tenantId: principal.tenantId,
      principalId: principal.userId,
      name,
      idempotencyKey: idempotencyKey.toLowerCase(),
    };

    return this.runSerializable(scope, async (transaction) => {
      const receipt = await transaction.reserve(hash);
      if (receipt) {
        if (receipt.requestHash !== hash)
          throw new ConflictException(
            'Idempotency key reused with different arguments',
          );
        return {
          data: receipt.response,
          commitSeq: receipt.commitSeq,
          replayed: true,
        };
      }

      const changes: JournalChange[] = [];
      const data = await handler.execute(
        {
          principal,
          get client() {
            return transaction.client;
          },
          data: transaction.data,
          recordChange: (change) =>
            changes.push({ ...structuredClone(change), eventId: randomUUID() }),
        },
        structuredClone(validated),
      );
      const response = JSON.stringify(data);
      if (response === undefined)
        throw new Error('A mutation must return a JSON result');
      const commitSeq = await transaction.complete(response, changes);
      return { data: JSON.parse(response), commitSeq, replayed: false };
    });
  }
}
