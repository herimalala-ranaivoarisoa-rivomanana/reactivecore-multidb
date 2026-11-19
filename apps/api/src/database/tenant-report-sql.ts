import type { RowValue, TenantReport } from './tenant-data.js';
import { tenantFilters } from './tenant-list-sql.js';

interface ReportDialect {
  identifier(name: string): string;
  table(name: string): string;
  bind(value: RowValue): string;
  tenantParameter: string;
  asText(expression: string): string;
}

/** Builds a grouped read in which every joined table shares the root tenant. */
export function tenantReportSql(
  request: TenantReport,
  dialect: ReportDialect,
): string {
  if (
    !request.aggregates.length ||
    !Number.isSafeInteger(request.limit) ||
    request.limit < 1
  )
    throw new Error(
      'A report requires aggregates and a positive integer limit',
    );

  const { identifier, table, bind, asText } = dialect;
  const root = identifier(request.from.as);
  const aliases = new Set([request.from.as]);

  function column(reference: string | undefined): string {
    if (typeof reference !== 'string')
      throw new Error('Expected a qualified report column');
    const [alias, field, extra] = reference.split('.');
    if (!aliases.has(alias) || !field || extra !== undefined)
      throw new Error('Expected a column on a registered report alias');
    return `${identifier(alias)}.${identifier(field)}`;
  }

  const joins = (request.joins ?? []).map((join) => {
    if (aliases.has(join.as) || (join.type !== 'inner' && join.type !== 'left'))
      throw new Error('Invalid report join');
    const left = column(join.on.left);
    const right = identifier(join.as);
    aliases.add(join.as);
    return `${join.type === 'left' ? 'LEFT' : 'INNER'} JOIN ${table(join.table)} AS ${right}
      ON ${left} = ${right}.${identifier(join.on.right)}
      AND ${right}.${identifier('tenant_id')} = ${root}.${identifier('tenant_id')}`;
  });

  const outputNames = new Set<string>();
  function output(expression: string, name: string) {
    if (outputNames.has(name))
      throw new Error('Duplicate report output column');
    outputNames.add(name);
    return `${expression} AS ${identifier(name)}`;
  }

  const groups = (request.groupBy ?? []).map(({ column: ref, as }) => ({
    expression: column(ref),
    as,
  }));
  const projection = groups.map(({ expression, as }) => output(expression, as));
  for (const aggregate of request.aggregates) {
    if (aggregate.fn !== 'count' && aggregate.fn !== 'sum')
      throw new Error('Unsupported aggregate');
    const argument =
      aggregate.column === undefined && aggregate.fn === 'count'
        ? '*'
        : column(aggregate.column);
    const fn = aggregate.fn === 'count' ? 'COUNT' : 'SUM';
    projection.push(output(asText(`${fn}(${argument})`), aggregate.as));
  }

  const filters = tenantFilters(request.where, column, bind);
  const grouping = groups.length
    ? `GROUP BY ${groups.map(({ expression }) => expression).join(', ')}
       ORDER BY ${groups.map(({ expression }) => expression).join(', ')}`
    : '';
  return `SELECT ${projection.join(', ')} FROM ${table(request.from.table)} AS ${root}
    ${joins.join(' ')}
    WHERE ${root}.${identifier('tenant_id')} = ${dialect.tenantParameter}
    ${filters.length ? `AND ${filters.join(' AND ')}` : ''}
    ${grouping} LIMIT ${request.limit}`;
}
