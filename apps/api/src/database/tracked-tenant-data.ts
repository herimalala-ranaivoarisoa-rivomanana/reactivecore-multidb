import { isUUID } from 'class-validator';
import type {
  ChangeDescriptor,
  Dependency,
} from '../reactive/contracts/dependency.types.js';
import type { TenantReader, TenantWriter } from './tenant-data.js';

type Change = Omit<ChangeDescriptor, 'tenantId'>;

export function trackReads(
  data: TenantReader,
  tenantId: string,
  track: (dependency: Dependency) => void,
): TenantReader {
  const tableDependency = (table: string) =>
    track({ tenantId, table, kind: 'table' });
  return {
    get(request) {
      track({
        tenantId,
        table: request.table,
        kind: 'document',
        documentId: request.id.toLowerCase(),
      });
      return data.get(request);
    },
    list(request) {
      tableDependency(request.table);
      return data.list(request);
    },
    report(request) {
      tableDependency(request.from.table);
      for (const join of request.joins ?? []) tableDependency(join.table);
      return data.report(request);
    },
  };
}

export function trackWrites<T extends TenantWriter>(
  data: T,
  track: (change: Change) => void,
): T {
  const trackRow = (
    table: string,
    id: unknown,
    operation: Change['operation'],
  ) => {
    if (typeof id === 'string' && isUUID(id))
      track({ table, documentId: id.toLowerCase(), operation });
  };
  return {
    ...data,
    async insert(table, values) {
      await data.insert(table, values);
      trackRow(table, values.id, 'insert');
    },
    async update(table, id, values) {
      const applied = await data.update(table, id, values);
      if (applied) trackRow(table, id, 'update');
      return applied;
    },
    async delete(table, id) {
      const applied = await data.delete(table, id);
      if (applied) trackRow(table, id, 'delete');
      return applied;
    },
    async updateVersioned(table, id, version, values) {
      const result = await data.updateVersioned(table, id, version, values);
      if (result === 'applied') trackRow(table, id, 'update');
      return result;
    },
    async deleteVersioned(table, id, version) {
      const result = await data.deleteVersioned(table, id, version);
      if (result === 'applied') trackRow(table, id, 'delete');
      return result;
    },
  };
}
