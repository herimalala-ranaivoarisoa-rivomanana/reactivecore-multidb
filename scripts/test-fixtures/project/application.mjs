import { randomUUID } from 'node:crypto';

export default function createApplication({
  Module,
  ReactiveQuery,
  ReactiveMutation,
  BadRequestException,
  ConflictException,
  NotFoundException,
}) {
  function validateList(_principal, args) {
    if (
      !args ||
      typeof args !== 'object' ||
      Array.isArray(args) ||
      Object.keys(args).length
    ) {
      throw new BadRequestException('items.list expects an empty object');
    }
  }

  function validateCreate(args) {
    if (
      !args ||
      typeof args !== 'object' ||
      Object.keys(args).length !== 1 ||
      typeof args.title !== 'string' ||
      !args.title.trim() ||
      Array.from(args.title.trim()).length > 120 ||
      args.title.includes('\u0000')
    ) {
      throw new BadRequestException('Expected a title of 1 to 120 characters');
    }
    return { title: args.title.trim() };
  }

  function validateItemId(id) {
    if (
      typeof id !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        id,
      )
    ) {
      throw new BadRequestException('Expected an item UUID');
    }
    return id.toLowerCase();
  }

  function validateVersion(version, max = 2147483647) {
    if (!Number.isInteger(version) || version < 1 || version > max)
      throw new BadRequestException('Expected a positive row version in range');
    return version;
  }

  function validateUpdate(args) {
    if (!args || typeof args !== 'object' || Object.keys(args).length !== 3)
      throw new BadRequestException(
        'Expected an item ID, title, and expectedVersion',
      );
    return {
      id: validateItemId(args.id),
      ...validateCreate({ title: args.title }),
      expectedVersion: validateVersion(args.expectedVersion, 2147483646),
    };
  }

  function validateDelete(args) {
    if (!args || typeof args !== 'object' || Object.keys(args).length !== 2)
      throw new BadRequestException('Expected an item ID and expectedVersion');
    return {
      id: validateItemId(args.id),
      expectedVersion: validateVersion(args.expectedVersion),
    };
  }

  function validatePage(_principal, args) {
    if (
      !args ||
      typeof args !== 'object' ||
      Object.keys(args).length !== 2 ||
      !Number.isSafeInteger(args.offset) ||
      args.offset < 0 ||
      !Number.isSafeInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > 100
    ) {
      throw new BadRequestException(
        'Expected a nonnegative offset and a limit from 1 to 100',
      );
    }
  }

  function validateReserve(args) {
    if (!args || typeof args !== 'object' || Object.keys(args).length !== 1)
      throw new BadRequestException('Expected an item ID');
    return { id: validateItemId(args.id) };
  }

  function validateGet(_principal, args) {
    if (!args || typeof args !== 'object' || Object.keys(args).length !== 1)
      throw new BadRequestException('Expected an item ID');
    validateItemId(args.id);
  }

  function requireApplied(result) {
    if (result === 'not-found') throw new NotFoundException('Item not found');
    if (result === 'conflict')
      throw new ConflictException('Item version has changed');
  }

  function validateCharge(args) {
    if (
      !args ||
      typeof args !== 'object' ||
      Object.keys(args).length !== 3 ||
      typeof args.period !== 'string' ||
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(args.period) ||
      !Number.isSafeInteger(args.amountCents) ||
      args.amountCents < 1 ||
      args.amountCents > 2147483647
    )
      throw new BadRequestException(
        'Expected an item ID, a YYYY-MM period, and positive integer cents',
      );
    return {
      itemId: validateItemId(args.itemId),
      period: args.period,
      amountCents: args.amountCents,
    };
  }

  class ItemFunctions {
    async get(ctx, { id: inputId }) {
      const id = inputId.toLowerCase();
      ctx.dependencies.add({
        kind: 'document',
        tenantId: ctx.principal.tenantId,
        table: 'items',
        documentId: id,
      });
      return ctx.data.get({
        table: 'items',
        id,
        columns: ['id', 'title', 'version'],
      });
    }

    async list(ctx) {
      ctx.dependencies.add({
        kind: 'table',
        tenantId: ctx.principal.tenantId,
        table: 'items',
      });
      return ctx.data.list({
        table: 'items',
        columns: ['id', 'title', 'version'],
        orderBy: [
          { column: 'created_at', direction: 'desc' },
          { column: 'id', direction: 'asc' },
        ],
        limit: 100,
      });
    }

    async available(ctx, { offset, limit }) {
      ctx.dependencies.add({
        kind: 'table',
        table: 'items',
        tenantId: ctx.principal.tenantId,
      });
      return ctx.data.list({
        table: 'items',
        columns: ['id', 'title', 'version'],
        where: [{ column: 'reserved_by', op: 'eq', value: null }],
        orderBy: [{ column: 'title', direction: 'asc' }],
        limit,
        offset,
      });
    }

    async reserve(ctx, { id }) {
      const item = await ctx.data.getForUpdate({
        table: 'items',
        id,
        columns: ['reserved_by', 'version'],
      });
      if (!item) throw new NotFoundException('Item not found');
      if (item.reserved_by !== null)
        throw new ConflictException('Item is already reserved');
      const reservedBy = ctx.principal.userId;
      const version = item.version + 1;
      await ctx.data.update('items', id, { reserved_by: reservedBy, version });
      ctx.recordChange({
        table: 'items',
        documentId: id,
        operation: 'update',
        before: { reserved_by: null, version: item.version },
        after: { reserved_by: reservedBy, version },
      });
      return { id, reservedBy, version };
    }

    async monthlyCharges(ctx) {
      for (const table of ['items', 'charges']) {
        ctx.dependencies.add({
          kind: 'table',
          table,
          tenantId: ctx.principal.tenantId,
        });
      }
      return ctx.data.report({
        from: { table: 'charges', as: 'charge' },
        joins: [
          {
            table: 'items',
            as: 'item',
            type: 'inner',
            on: { left: 'charge.item_id', right: 'id' },
          },
        ],
        groupBy: [{ column: 'charge.period', as: 'period' }],
        aggregates: [
          { fn: 'count', as: 'count' },
          { fn: 'sum', column: 'charge.amount_cents', as: 'total_cents' },
        ],
        limit: 120,
      });
    }

    async addCharge(ctx, { itemId, period, amountCents }) {
      if (
        !(await ctx.data.getForUpdate({
          table: 'items',
          id: itemId,
          columns: ['id'],
        }))
      )
        throw new NotFoundException('Item not found');
      const id = randomUUID();
      const values = { id, item_id: itemId, period, amount_cents: amountCents };
      await ctx.data.insert('charges', values);
      ctx.recordChange({
        table: 'charges',
        documentId: id,
        operation: 'insert',
        before: null,
        after: values,
      });
      return { id };
    }

    async create(ctx, { title }) {
      const id = randomUUID();
      await ctx.data.insert('items', { id, title });
      ctx.recordChange({
        table: 'items',
        documentId: id,
        operation: 'insert',
        before: null,
        after: { title, version: 1 },
      });
      return { id, title };
    }

    async update(ctx, { id, title, expectedVersion }) {
      requireApplied(
        await ctx.data.updateVersioned('items', id, expectedVersion, { title }),
      );
      const version = expectedVersion + 1;
      ctx.recordChange({
        table: 'items',
        documentId: id,
        operation: 'update',
        after: { title, version },
      });
      return { id, title, version };
    }

    async delete(ctx, { id, expectedVersion }) {
      requireApplied(
        await ctx.data.deleteVersioned('items', id, expectedVersion),
      );
      ctx.recordChange({
        table: 'items',
        documentId: id,
        operation: 'delete',
        after: null,
      });
      return { id };
    }
  }

  const methods = ItemFunctions.prototype;
  ReactiveQuery('billing.monthly')(
    methods,
    'monthlyCharges',
    Object.getOwnPropertyDescriptor(methods, 'monthlyCharges'),
  );
  ReactiveMutation({
    name: 'billing.add_charge',
    validate: validateCharge,
    authorize: () => {},
  })(
    methods,
    'addCharge',
    Object.getOwnPropertyDescriptor(methods, 'addCharge'),
  );
  ReactiveQuery('items.available')(
    methods,
    'available',
    Object.getOwnPropertyDescriptor(methods, 'available'),
  );
  ReactiveMutation({
    name: 'items.reserve',
    validate: validateReserve,
    authorize: () => {},
  })(methods, 'reserve', Object.getOwnPropertyDescriptor(methods, 'reserve'));
  ReactiveQuery('items.get')(
    methods,
    'get',
    Object.getOwnPropertyDescriptor(methods, 'get'),
  );
  ReactiveQuery('items.list')(
    methods,
    'list',
    Object.getOwnPropertyDescriptor(methods, 'list'),
  );
  ReactiveMutation({
    name: 'items.create',
    validate: validateCreate,
    authorize: () => {},
  })(methods, 'create', Object.getOwnPropertyDescriptor(methods, 'create'));
  ReactiveMutation({
    name: 'items.update',
    validate: validateUpdate,
    authorize: () => {},
  })(methods, 'update', Object.getOwnPropertyDescriptor(methods, 'update'));
  ReactiveMutation({
    name: 'items.delete',
    validate: validateDelete,
    authorize: () => {},
  })(methods, 'delete', Object.getOwnPropertyDescriptor(methods, 'delete'));
  class Application {}
  Module({ providers: [ItemFunctions] })(Application);
  return {
    application: Application,
    functions: {
      queries: {
        'items.list': validateList,
        'items.get': validateGet,
        'items.available': validatePage,
        'billing.monthly': validateList,
      },
      mutations: [
        'items.create',
        'items.update',
        'items.delete',
        'items.reserve',
        'billing.add_charge',
      ],
    },
  };
}
