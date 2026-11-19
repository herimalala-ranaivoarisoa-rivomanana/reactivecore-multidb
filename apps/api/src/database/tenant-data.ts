export interface ListRows {
  table: string;
  columns: readonly string[];
  orderBy?: readonly { column: string; direction: 'asc' | 'desc' }[];
  limit: number;
  offset?: number;
  where?: readonly RowFilter[];
}

export type RowFilter =
  | { column: string; op: 'eq' | 'ne'; value: RowValue }
  | { column: string; op: 'lt' | 'lte' | 'gt' | 'gte'; value: string | number };

export type RowValue = string | number | boolean | null;
export type RowValues = Readonly<Record<string, RowValue>>;

/** Returns the columns that can be assigned without replacing a row's identity. */
export function updateColumns(values: RowValues): string[] {
  const columns = Object.keys(values);
  if (
    !columns.length ||
    columns.includes('tenant_id') ||
    columns.includes('id')
  )
    throw new Error(
      'An update requires application columns and cannot modify id or tenant_id',
    );
  return columns;
}

/** Rejects tables that do not enforce a unique row ID within the tenant. */
export function matchedTenantRow(count: number | null): boolean {
  if (count !== 0 && count !== 1)
    throw new Error('Expected an unambiguous tenant row ID');
  return count === 1;
}

export interface GetRow {
  table: string;
  id: string;
  columns: readonly string[];
}

export interface TenantReport {
  from: { table: string; as: string };
  joins?: readonly {
    table: string;
    as: string;
    type: 'inner' | 'left';
    on: { left: string; right: string };
  }[];
  /** Selected columns also form the GROUP BY keys. Use alias.column references. */
  groupBy?: readonly { column: string; as: string }[];
  aggregates: readonly (
    | { fn: 'count'; column?: string; as: string }
    | { fn: 'sum'; column: string; as: string }
  )[];
  where?: readonly RowFilter[];
  limit: number;
}

/** Reads rows for the authenticated tenant in the current query snapshot. */
export interface TenantReader {
  /** Returns grouped aggregates as decimal strings, or null for an empty sum. */
  report(request: TenantReport): Promise<Record<string, unknown>[]>;

  /** Returns the tenant's row by ID, or null when it is absent. */
  get<Row extends Record<string, unknown> = Record<string, unknown>>(
    request: GetRow,
  ): Promise<Row | null>;

  list<Row extends Record<string, unknown> = Record<string, unknown>>(
    request: ListRows,
  ): Promise<Row[]>;
}

/** Writes rows for the authenticated tenant in the current mutation transaction. */
export interface TenantWriter {
  /** Locks a tenant row until the mutation transaction ends. */
  getForUpdate<Row extends Record<string, unknown> = Record<string, unknown>>(
    request: GetRow,
  ): Promise<Row | null>;

  /** Supplies the tenant ID itself. Application values must omit tenant_id. */
  insert(table: string, values: RowValues): Promise<void>;

  /** Updates one tenant row by its stable ID. Returns whether it exists. */
  update(table: string, id: string, values: RowValues): Promise<boolean>;

  /** Deletes one tenant row by its stable ID. Returns whether it existed. */
  delete(table: string, id: string): Promise<boolean>;

  /** Updates and increments version only when the locked row has the expected version. */
  updateVersioned(
    table: string,
    id: string,
    expectedVersion: number,
    values: RowValues,
  ): Promise<VersionedWrite>;

  /** Deletes only when the locked row has the expected version. */
  deleteVersioned(
    table: string,
    id: string,
    expectedVersion: number,
  ): Promise<VersionedWrite>;
}

export type VersionedWrite = 'applied' | 'not-found' | 'conflict';

/** Builds version-checked writes using a locking read on the same transaction. */
export function versionedWrites(
  writer: Pick<TenantWriter, 'update' | 'delete'>,
  lockVersion: (table: string, id: string) => Promise<number | null>,
): Pick<TenantWriter, 'updateVersioned' | 'deleteVersioned'> {
  async function apply(
    table: string,
    id: string,
    expectedVersion: number,
    write: () => Promise<boolean>,
  ): Promise<VersionedWrite> {
    if (
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 1 ||
      expectedVersion > 2147483647
    )
      throw new Error('Expected a positive 32-bit row version');
    const version = await lockVersion(table, id);
    if (version === null) return 'not-found';
    if (version !== expectedVersion) return 'conflict';
    if (!(await write()))
      throw new Error('Locked tenant row could not be written');
    return 'applied';
  }

  return {
    updateVersioned(table, id, expectedVersion, values) {
      if (Object.hasOwn(values, 'version') || expectedVersion === 2147483647)
        throw new Error('A versioned update increments version automatically');
      return apply(table, id, expectedVersion, () =>
        writer.update(table, id, { ...values, version: expectedVersion + 1 }),
      );
    },
    deleteVersioned(table, id, expectedVersion) {
      return apply(table, id, expectedVersion, () => writer.delete(table, id));
    },
  };
}
