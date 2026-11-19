import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';

import { DatabaseHealth, databaseEngine } from '../database/database-engine.js';
import { ChangeFeed } from '../reactive/contracts/change-feed.js';
import { RedisService } from '../redis/redis.service.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly database: DatabaseHealth,
    private readonly changeFeed: ChangeFeed,
    private readonly redis: RedisService,
  ) {}

  @Get('live')
  live() {
    return { status: 'alive' };
  }

  @Get('ready')
  async ready() {
    try {
      await this.changeFeed.currentSeq();
      return { status: 'ready' };
    } catch {
      throw new ServiceUnavailableException(
        'Database or the commit clock is unavailable',
      );
    }
  }

  @Get()
  async check() {
    const [database, redis] = await Promise.allSettled([
      this.database.ping(),
      this.redis.ping(),
    ]);

    const databaseOk =
      database.status === 'fulfilled' && database.value === true;

    const redisOk = redis.status === 'fulfilled' && redis.value === 'PONG';

    return {
      status: databaseOk && redisOk ? 'healthy' : 'degraded',

      services: {
        [databaseEngine()]: databaseOk ? 'up' : 'down',
        redis: redisOk ? 'up' : 'down',
      },

      timestamp: new Date().toISOString(),
    };
  }
}
