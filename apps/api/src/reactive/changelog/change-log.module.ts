import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { ChangeFeed } from '../contracts/change-feed.js';
import { ChangeLogService } from './change-log.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [
    ChangeLogService,
    { provide: ChangeFeed, useExisting: ChangeLogService },
  ],
  exports: [ChangeLogService, ChangeFeed],
})
export class ChangeLogModule {}
