import type { ListRows, RowFilter, RowValue } from './tenant-data.js';

const operators = {
  eq: '=',
  ne: '<>',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
} as const;

/** Compiles validated list options while leaving all filter values in parameters. */
export function tenantListSql(
  { columns, orderBy, limit, offset, where }: ListRows,
  identifier: (name: string) => string,
  bind: (value: RowValue) => string,
) {
  if (!columns.length || !Number.isSafeInteger(limit) || limit < 1)
    throw new Error('A list requires columns and a positive integer limit');
  if (
    offset !== undefined &&
    (!Number.isSafeInteger(offset) || offset < 0 || !orderBy?.length)
  )
    throw new Error(
      'Pagination requires a nonnegative integer offset and an order',
    );

  const filters = tenantFilters(where, identifier, bind);

  const order = (orderBy ?? []).map(({ column, direction }) => {
    if (direction !== 'asc' && direction !== 'desc')
      throw new Error('Unsupported sort direction');
    return `${identifier(column)} ${direction}`;
  });
  if (offset !== undefined && !orderBy?.some(({ column }) => column === 'id'))
    order.push(`${identifier('id')} asc`);

  return {
    projection: columns.map(identifier).join(', '),
    predicate: filters.length ? `AND ${filters.join(' AND ')}` : '',
    order: order.length ? `ORDER BY ${order.join(', ')}` : '',
  };
}

export function tenantFilters(
  where: readonly RowFilter[] | undefined,
  columnSql: (column: string) => string,
  bind: (value: RowValue) => string,
) {
  return (where ?? []).map(({ column, op, value }) => {
    const name = columnSql(column);
    if (!Object.hasOwn(operators, op))
      throw new Error('Unsupported filter operator');
    if (value === null) {
      if (op !== 'eq' && op !== 'ne')
        throw new Error('Null filters require eq or ne');
      return `${name} IS ${op === 'ne' ? 'NOT ' : ''}NULL`;
    }
    if (
      typeof value !== 'string' &&
      !(typeof value === 'number' && Number.isFinite(value)) &&
      !(typeof value === 'boolean' && (op === 'eq' || op === 'ne'))
    )
      throw new Error('Unsupported filter value');
    return `${name} ${operators[op]} ${bind(value)}`;
  });
}
