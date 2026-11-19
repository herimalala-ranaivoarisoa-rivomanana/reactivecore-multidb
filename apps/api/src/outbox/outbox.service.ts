import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service.js';
import { invalidationPayload } from './invalidation-payload.js';
import { invalidationChannel } from './invalidation-channel.js';
import { OutboxStore } from './outbox-store.js';

@Injectable()
export class OutboxService {
  constructor(
    private readonly store: OutboxStore,
    private readonly redis: RedisService,
  ) {}

  async publishNext(): Promise<boolean> {
    const lease = await this.store.claim();
    if (!lease) return false;

    try {
      await this.redis.publish(
        invalidationChannel(),
        JSON.stringify({
          ...lease.event,
          payload: invalidationPayload(lease.event.type, lease.event.payload),
        }),
      );
    } catch (error) {
      await this.store.retry(lease);
      throw error;
    }

    await this.store.acknowledge(lease);
    return true;
  }
}
