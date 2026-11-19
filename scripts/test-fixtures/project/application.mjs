import { randomUUID } from 'node:crypto';

export default function createApplication({
  Module,
  ReactiveQuery,
  ReactiveMutation,
  BadRequestException,
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

  function validateUpdate(args) {
    if (!args || typeof args !== 'object' || Object.keys(args).length !== 2)
      throw new BadRequestException('Expected an item ID and title');
    return {
      id: validateItemId(args.id),
      ...validateCreate({ title: args.title }),
    };
  }

  function validateDelete(args) {
    if (!args || typeof args !== 'object' || Object.keys(args).length !== 1)
      throw new BadRequestException('Expected an item ID');
    return { id: validateItemId(args.id) };
  }

  function validateGet(_principal, args) {
    validateDelete(args);
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
      return ctx.data.get({ table: 'items', id, columns: ['id', 'title'] });
    }

    async list(ctx) {
      ctx.dependencies.add({
        kind: 'table',
        tenantId: ctx.principal.tenantId,
        table: 'items',
      });
      return ctx.data.list({
        table: 'items',
        columns: ['id', 'title'],
        orderBy: [
          { column: 'created_at', direction: 'desc' },
          { column: 'id', direction: 'asc' },
        ],
        limit: 100,
      });
    }

    async create(ctx, { title }) {
      const id = randomUUID();
      await ctx.data.insert('items', { id, title });
      ctx.recordChange({
        table: 'items',
        documentId: id,
        operation: 'insert',
        before: null,
        after: { title },
      });
      return { id, title };
    }

    async update(ctx, { id, title }) {
      if (!(await ctx.data.update('items', id, { title })))
        throw new NotFoundException('Item not found');
      ctx.recordChange({
        table: 'items',
        documentId: id,
        operation: 'update',
        after: { title },
      });
      return { id, title };
    }

    async delete(ctx, { id }) {
      if (!(await ctx.data.delete('items', id)))
        throw new NotFoundException('Item not found');
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
      queries: { 'items.list': validateList, 'items.get': validateGet },
      mutations: ['items.create', 'items.update', 'items.delete'],
    },
  };
}
