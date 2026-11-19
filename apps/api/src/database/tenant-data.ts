export interface ListRows {
  table: string;
  columns: readonly string[];
  orderBy?: readonly { column: string; direction: 'asc' | 'desc' }[];
  limit: number;
}

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

/** Reads rows for the authenticated tenant in the current query snapshot. */
export interface TenantReader {
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
  /** Supplies the tenant ID itself. Application values must omit tenant_id. */
  insert(table: string, values: RowValues): Promise<void>;

  /** Updates one tenant row by its stable ID. Returns whether it exists. */
  update(table: string, id: string, values: RowValues): Promise<boolean>;

  /** Deletes one tenant row by its stable ID. Returns whether it existed. */
  delete(table: string, id: string): Promise<boolean>;
}
