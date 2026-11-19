import { Module } from '@nestjs/common';
import { DatabaseHealth } from '../database-engine.js';
import { MysqlDatabase } from './mysql-database.js';

@Module({
  providers: [
    MysqlDatabase,
    { provide: DatabaseHealth, useExisting: MysqlDatabase },
  ],
  exports: [MysqlDatabase, DatabaseHealth],
})
export class MysqlModule {}
