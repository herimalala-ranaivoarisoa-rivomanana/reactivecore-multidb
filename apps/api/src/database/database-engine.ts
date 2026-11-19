export function databaseEngine(): 'postgres' | 'mysql' {
  return process.env.DATABASE_URL?.startsWith('mysql://')
    ? 'mysql'
    : 'postgres';
}

export abstract class DatabaseHealth {
  abstract ping(): Promise<boolean>;
}

export function mysqlIdentifier(name: string): string {
  if (typeof name !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(name))
    throw new Error(
      'Expected a lowercase SQL identifier of at most 63 characters',
    );
  return `\`${name}\``;
}

export function mysqlLegacyClient(): never {
  throw new Error('MySQL handlers must use ctx.data');
}
