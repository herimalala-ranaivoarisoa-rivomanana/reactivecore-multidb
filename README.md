# ReactiveCore MultiDB

**A self-hosted reactive backend with offline mutations, PostgreSQL support, and a MySQL preview.**

This repository continues development from [ReactiveCore v0.1.0](https://github.com/herimalala-ranaivoarisoa-rivomanana/reactivecore/releases/tag/v0.1.0). PostgreSQL 16 is the established storage engine. MySQL 8.4 is available as a preview for applications using the structured tenant data interface. Both run the same item example and HTTP/SSE client.

You supply the schema, queries, mutations, and access policies. ReactiveCore isolates data by tenant and delivers query updates over HTTP/SSE. The TypeScript SDK reconnects subscriptions and provides a persistent offline mutation queue.

This guide creates a ReactiveCore backend and a separate Vue or Next.js frontend for a live item list. You can replace either example with your own application.

**Release status.** Run ReactiveCore MultiDB from source. The upstream alpha is available from the original ReactiveCore repository.

[Local setup](#1-install-the-prerequisites) · [MySQL preview](#run-the-same-project-on-mysql-84) · [Vue and Next.js](#8-create-and-run-a-frontend) · [Offline writes](#add-offline-writes-to-a-frontend) · [Next.js conflict example](#run-the-nextjs-offline-conflict-example) · [Deployment](#9-configure-a-production-deployment) · [Tests](#verify-the-engine)

### Storage adapter progress

The mutation engine uses an internal [mutation storage contract](apps/api/src/mutation/mutation-store.ts). Its [PostgreSQL implementation](apps/api/src/mutation/postgres-mutation-store.ts) reserves the idempotency key and commits the handler's business write, receipt, change log, and outbox in one transaction. Retries are limited to errors the adapter identifies as rolled back. The PostgreSQL integration suite checks that replays return the same result and that subscribers and the outbox worker see the committed change.

The query engine runs tenant reads through a [snapshot contract](apps/api/src/reactive/contracts/query-snapshot-store.ts), and subscriptions catch up through a [durable change-feed contract](apps/api/src/reactive/contracts/change-feed.ts). The worker claims, retries, and acknowledges deliveries through an [outbox storage contract](apps/api/src/outbox/outbox-store.ts). Both adapters implement these contracts. The item example uses the [tenant data interface](apps/api/src/database/tenant-data.ts) for reads, inserts, updates, and deletes. The MySQL preview covers this interface and its InnoDB migrations.

## 1. Install the prerequisites

Install Node.js 24 or later, npm, Docker with the Compose plugin, and curl. Run the commands below in a Bash shell from the ReactiveCore repository root, including when opening additional terminals.

```sh
git clone https://github.com/herimalala-ranaivoarisoa-rivomanana/reactivecore-multidb.git
cd reactivecore-multidb
npm ci
npm run build
```

## 2. Create a project and add two functions

```sh
npm run project -- init ../my-project
cp scripts/test-fixtures/project/application.mjs ../my-project/application.mjs
cp scripts/test-fixtures/project/migrations/*.sql ../my-project/migrations/
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';

const path = '../my-project/project.json';
const { name } = JSON.parse(readFileSync(path, 'utf8'));
const { queries, mutations } = JSON.parse(
  readFileSync('scripts/test-fixtures/project/project.json', 'utf8'),
);
writeFileSync(path, JSON.stringify({ name, queries, mutations }, null, 2) + '\n');
JS
npm run project -- codegen ../my-project
```

This command creates the backend project. Step 8 creates the frontend separately. The CLI requires a new directory and takes the project name from its lowercase directory slug. The generated files belong to your project.

| File | What to change for your application |
| --- | --- |
| `project.json` | Describe each public function's argument and result types. Code generation supports scalars, objects, homogeneous arrays, and nullable results written as `[shape, "null"]`. |
| `application.mjs` | Export a factory that registers NestJS providers with `ReactiveQuery` and `ReactiveMutation` and declares which functions can be called over HTTP. |
| `migrations/*.sql` | Define your tables, indexes, row-level security policies, and runtime grants. Add a numbered migration for each later schema change. |
| `client.ts` | Import the generated `createClient` in a TypeScript app. Rerun `codegen` after changing the manifest. |

Read the [example application](scripts/test-fixtures/project/application.mjs) and its [migration](scripts/test-fixtures/project/migrations/001_items.sql). The `items.list` query filters by the authenticated tenant and registers a table dependency. The `items.create` mutation validates the title, inserts a row, and calls `ctx.recordChange` in the same transaction. The change journal lets the engine refresh subscriptions that depend on the affected table. The database policy also enforces the tenant boundary.

### Access tenant data from application functions

Use `ctx.data.get({ table, id, columns })` to read one row by ID. It returns `null` if the row is missing or belongs to another tenant. The `items.get` handler registers a dependency on that exact item, so editing or deleting it refreshes the detail subscription. A deletion delivers a snapshot with `data: null`.

```ts
const first = await client.query('items.get', { id });
console.log(first.data?.title);

for await (const snapshot of client.subscribe('items.get', { id }, signal)) {
  console.log(snapshot.data?.title ?? 'Item unavailable');
}
```

Here `client` is the generated client, `id` is the ID returned by `items.create`, and `signal` is the abort signal for the detail view. Regenerate `client.ts` after updating the project manifest.

The item example uses `ctx.data.list({ table, columns, orderBy, limit })` in queries and the following methods in mutations. Each method operates inside the current tenant's transaction.

| Method | Behavior |
| --- | --- |
| `ctx.data.insert(table, values)` | Inserts application values and supplies `tenant_id`. |
| `ctx.data.update(table, id, values)` | Updates the tenant's row by ID. Returns `false` if the row is absent. |
| `ctx.data.delete(table, id)` | Deletes the tenant's row by ID. Returns `false` if the row is absent. |
| `ctx.data.updateVersioned(table, id, expectedVersion, values)` | Checks the version under a row lock, applies the update, and increments the version in the same transaction. |
| `ctx.data.deleteVersioned(table, id, expectedVersion)` | Checks the version under a row lock before deleting. |

Use a `tenant_id` column and a stable `id` that uniquely identifies a row within that tenant. Define the constraint, policies, and restricted grants in your migrations. Updates cannot change `id` or `tenant_id`. The item handlers return HTTP 404 when the requested row is outside the caller's tenant or is missing.

For an existing copy of the PostgreSQL item example, add the [write grants migration](scripts/test-fixtures/project/migrations/002_item_writes.sql) and the [version migration](scripts/test-fixtures/project/migrations/003_item_versions.sql), then run provisioning again before using the new mutations. On MySQL, apply the [version migration](scripts/test-fixtures/project/migrations/mysql/002_item_versions.sql) and the grants in the [MySQL walkthrough](#run-the-same-project-on-mysql-84). Update the application factory and manifest, regenerate the client, and restart the API.

The read interface automatically filters by the authenticated tenant. The write interface supplies `tenant_id` and rejects values that try to set it. The example still registers its query dependency with `ctx.dependencies.add` and records the mutation with `ctx.recordChange`. Those calls tell the reactive engine what to refresh after a commit.

Use the structured interface for the operations it supports. Existing PostgreSQL handlers can continue to execute SQL through `ctx.client`. Application code that uses PostgreSQL-specific SQL needs an equivalent implementation before it can run on another engine.

## 3. Start PostgreSQL and Redis

Create a local environment file outside the engine repository. The example uses an isolated Compose project with its own volumes and ports.

```sh
cat > ../my-project/.env.compose <<'ENV'
POSTGRES_DB=postgres
POSTGRES_USER=reactivecore
POSTGRES_PASSWORD=local_admin_password
POSTGRES_PORT=56432
REDIS_PASSWORD=local_redis_password
REDIS_PORT=57379
ENV

docker compose -p reactivecore-guide --env-file ../my-project/.env.compose up -d --wait
docker compose -p reactivecore-guide --env-file ../my-project/.env.compose ps
```

Both services should report healthy. The Compose file binds PostgreSQL and Redis to loopback. Use these sample passwords only on a local machine.

## 4. Provision the database and register a tenant

The commands below let the CLI create the database. To prepare the database and roles first, use the [managed PostgreSQL walkthrough](OPERATIONS.md#use-a-managed-postgresql-database) in place of this step.

```sh
export RC_PROVISION_ADMIN_URL=postgresql://reactivecore:local_admin_password@127.0.0.1:56432/postgres
export RC_PROVISION_APP_PASSWORD=local_app_password
export RC_PROVISION_WORKER_PASSWORD=local_worker_password

npm run project -- provision ../my-project
TENANT_ID=$(node -p 'crypto.randomUUID()')
USER_ID=$(node -p 'crypto.randomUUID()')
npm run project -- tenant ../my-project "$TENANT_ID"
printf 'TENANT_ID=%s\nUSER_ID=%s\n' "$TENANT_ID" "$USER_ID" > ../my-project/.env.identity

unset RC_PROVISION_ADMIN_URL RC_PROVISION_APP_PASSWORD RC_PROVISION_WORKER_PASSWORD
```

Provisioning creates `reactivecore_my_project`, applies core and project migrations, and enables the application and worker logins. Rerun `provision` to apply new migrations. Applied files are checked against recorded hashes. Keep their contents intact and add a new numbered file for schema changes. On a reused cluster, use the existing role passwords because provisioning preserves them.

## 5. Run the API and worker in separate terminals

Terminal A starts the API with a local JWT signing secret.

```sh
export NODE_ENV=development
export DATABASE_URL=postgresql://reactivecore_app:local_app_password@127.0.0.1:56432/reactivecore_my_project
export REDIS_URL=redis://:local_redis_password@127.0.0.1:57379
export RC_JWT_ISSUER=urn:reactivecore:local
export RC_JWT_DEV_SECRET=local-development-signing-secret-only
export RC_HOST=127.0.0.1 PORT=4000
export RC_CORS_ORIGINS=http://localhost:5173,http://localhost:3000
npm run project -- serve ../my-project
```

Terminal B starts the worker that publishes invalidations from the transactional outbox.

```sh
export DATABASE_URL=postgresql://reactivecore_worker:local_worker_password@127.0.0.1:56432/reactivecore_my_project
export REDIS_URL=redis://:local_redis_password@127.0.0.1:57379
npm run project -- worker ../my-project
```

In a third terminal, check that the API process is alive and can read the PostgreSQL commit clock. The last endpoint reports the individual dependency statuses.

```sh
curl -fsS http://127.0.0.1:4000/api/health/live
curl -fsS http://127.0.0.1:4000/api/health/ready
curl -fsS http://127.0.0.1:4000/api/health
```

## 6. Sign a local development token and query the API

Create a short-lived JWT using the same secret, issuer, and audience as the API. The CLI defaults the audience to `reactivecore:<project-name>`.

```sh
node --env-file=../my-project/.env.identity --input-type=module > ../my-project/.env.token <<'JS'
import { SignJWT } from 'jose';

const token = await new SignJWT({
  tenant_id: process.env.TENANT_ID,
  scope: 'query mutation subscribe',
})
  .setProtectedHeader({ alg: 'HS256' })
  .setSubject(process.env.USER_ID)
  .setIssuer('urn:reactivecore:local')
  .setAudience('reactivecore:my-project')
  .setIssuedAt()
  .setExpirationTime('15m')
  .sign(new TextEncoder().encode('local-development-signing-secret-only'));

console.log('TOKEN=' + token);
JS

source ../my-project/.env.token
curl -fsS http://127.0.0.1:4000/api/v1/session \
  -H "Authorization: Bearer $TOKEN"
curl -fsS http://127.0.0.1:4000/api/v1/query \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"items.list","args":{}}'
```

The session response identifies the tenant, user, and granted scopes. The first query returns `{"data":[],"seq":"0"}` on a fresh database. Sequence values are decimal strings.

## 7. Watch a live update and replay a mutation

In a fourth terminal, open the SSE stream and leave it running.

```sh
source ../my-project/.env.token
curl -fsSN http://127.0.0.1:4000/api/v1/subscribe \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"items.list","args":{}}'
```

You should receive the initial snapshot. Back in the third terminal, make the same mutation twice with one idempotency key.

```sh
KEY=$(node -p 'crypto.randomUUID()')
for attempt in 1 2; do
  curl -fsS http://127.0.0.1:4000/api/v1/mutation \
    -H "Authorization: Bearer $TOKEN" \
    -H "Idempotency-Key: $KEY" \
    -H 'Content-Type: application/json' \
    -d '{"name":"items.create","args":{"title":"First live item"}}'
  printf '\n'
done
```

The first response has `replayed: false`. The second has `replayed: true` with the same item ID and commit sequence. The subscriber receives a snapshot containing one item. Use a fresh key for each new action, and keep the original key and arguments when retrying an action whose outcome is unknown. Stop the stream with Ctrl+C.

## 8. Create and run a frontend

Choose either Vue with Vite or Next.js. Both examples connect to the same backend. If the API is already running, restart it after changing the allowed origins in step 5.

### Option A: Vue with Vite

Keep the API and worker running. In a new terminal at the ReactiveCore repository root, scaffold a Vue and TypeScript app next to the backend and install the SDK from a local tarball.

```sh
(cd .. && npm create vite@latest my-project-web -- --template vue-ts --no-interactive)
npm pack -w @reactivecore/client --pack-destination ../my-project-web
cp ../my-project/client.ts ../my-project-web/src/reactivecore-client.ts

cd ../my-project-web
npm install
npm install ./reactivecore-client-0.1.0.tgz
```

Use the filename printed by `npm pack` if your SDK version differs. After changing the backend's function contracts, rerun `codegen` from the ReactiveCore repository and copy the new file into `src/reactivecore-client.ts`.

From `my-project-web`, replace the starter component with the following:

```sh
cat > src/App.vue <<'VUE'
<script setup lang="ts">
import { onUnmounted, ref } from 'vue';
import { createClient } from './reactivecore-client';

const token = ref('');
const items = ref<{ id: string; title: string }[]>([]);
const status = ref('Enter a development token to connect.');
let active: AbortController | undefined;

async function connect() {
  active?.abort();
  const subscription = new AbortController();
  active = subscription;
  const accessToken = token.value.trim();
  token.value = '';
  items.value = [];
  status.value = 'Waiting for the first snapshot…';
  const client = createClient('http://127.0.0.1:4000', () => accessToken);

  try {
    for await (const snapshot of client.subscribe('items.list', {}, subscription.signal)) {
      if (subscription.signal.aborted) return;
      items.value = snapshot.data;
      status.value = 'Receiving snapshots.';
    }
  } catch (error) {
    if (!subscription.signal.aborted) {
      status.value = error instanceof Error ? error.message : 'Subscription failed.';
    }
  }
}

onUnmounted(() => active?.abort());
</script>

<template>
  <main>
    <h1>Live items</h1>
    <form @submit.prevent="connect">
      <label for="token">Development token</label>
      <input id="token" v-model="token" type="password" autocomplete="off" required />
      <button type="submit">Connect</button>
    </form>
    <p role="status">{{ status }}</p>
    <ul>
      <li v-for="item in items" :key="item.id">{{ item.title }}</li>
    </ul>
  </main>
</template>
VUE

npm run dev -- --port 5173 --strictPort
```

1. Open `http://localhost:5173`. Use this exact origin because the API's CORS setting in step 5 allows it.
2. Paste the token generated in step 6 and click **Connect**. The first snapshot shows the current server list.
3. Run the mutation from step 7 again with a fresh idempotency key and a new title. The new item should appear in Vue without a page refresh.
4. If the token expires, rerun step 6 and connect with the new token. The example holds the token in memory. In your application, pass a token provider from your authentication layer so the SDK can obtain a current token on reconnect.

### Option B: Next.js with the App Router

From the ReactiveCore repository root, scaffold a separate Next.js app, package the SDK, and copy the generated client.

```sh
(cd .. && npx --yes create-next-app@latest my-project-next --ts --app --src-dir --no-tailwind --use-npm --yes --skip-install)
npm pack -w @reactivecore/client --pack-destination ../my-project-next
cp ../my-project/client.ts ../my-project-next/src/reactivecore-client.ts

cd ../my-project-next
npm install ./reactivecore-client-0.1.0.tgz
```

From `my-project-next`, replace the starter layout and home page. The layout uses system fonts, and the Client Component opens the subscription in the browser.

```sh
cat > src/app/layout.tsx <<'TSX'
import type { ReactNode } from 'react';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
TSX

cat > src/app/page.tsx <<'TSX'
'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createClient } from '../reactivecore-client';

export default function Home() {
  const [token, setToken] = useState('');
  const [items, setItems] = useState<{ id: string; title: string }[]>([]);
  const [status, setStatus] = useState('Enter a development token to connect.');
  const active = useRef<AbortController | null>(null);

  useEffect(() => () => active.current?.abort(), []);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const accessToken = token.trim();
    if (!accessToken) return;

    active.current?.abort();
    const subscription = new AbortController();
    active.current = subscription;
    setToken('');
    setItems([]);
    setStatus('Waiting for the first snapshot…');

    const client = createClient('http://127.0.0.1:4000', () => accessToken);
    try {
      for await (const snapshot of client.subscribe('items.list', {}, subscription.signal)) {
        if (subscription.signal.aborted) return;
        setItems(snapshot.data);
        setStatus('Receiving snapshots.');
      }
    } catch (error) {
      if (!subscription.signal.aborted) {
        setStatus(error instanceof Error ? error.message : 'Subscription failed.');
      }
    }
  }

  return (
    <main>
      <h1>Live items</h1>
      <form onSubmit={connect}>
        <label htmlFor="token">Development token</label>
        <input id="token" value={token} onChange={(event) => setToken(event.target.value)}
          type="password" autoComplete="off" required />
        <button type="submit">Connect</button>
      </form>
      <p role="status">{status}</p>
      <ul>{items.map((item) => <li key={item.id}>{item.title}</li>)}</ul>
    </main>
  );
}
TSX

npm run dev -- --port 3000
```

1. Open `http://localhost:3000` and paste the token from step 6. Click **Connect** to receive the current list.
2. Run the mutation from step 7 with a fresh idempotency key and a new title. The new item should appear without a page reload.
3. When the token expires, generate a new one and reconnect. Use your authentication layer's token provider for production.

Both examples display live data. To add offline writes, wire a **Create** button and an operation list to the queue below. In Next.js, initialize IndexedDB from browser code, for example in an effect inside a Client Component.

### Add offline writes to a frontend

The queue works in browser code written with Vue, Next.js, Svelte, or plain TypeScript. The SDK persists operations and retries them. Your frontend decides which local state to show, when to sync, and whether people can reopen the app and read cached data offline.

#### 1. Open the queue for the signed-in user

On sign-in, call `GET /api/v1/session` with the active access token and check the response. The server returns the verified issuer, audience, tenant ID, and user ID. Use these values with the API origin to isolate the browser queue. Set up a new queue when the account or tenant changes.

```ts
type SessionIdentity = {
  issuer: string;
  audience: string;
  tenantId: string;
  userId: string;
};

export async function readSession(origin: string, token: string): Promise<SessionIdentity> {
  const response = await fetch(new URL('/api/v1/session', origin), {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Session check failed (HTTP ${response.status})`);
  return response.json();
}
```

To reopen the queue after a reload without network access, your app needs to recover the last verified identity through its local sign-in flow. Use it to scope local reads. Confirm the identity with the server before enabling sends again. A queue scoped to another account can remain on the device and must only resume under that account.

#### 2. Connect the queue to your interface

Save the following browser example as `src/offline-items.ts` next to the generated client from step 8. It uses the `items.create` function from step 2. Use `render` to replace your framework's list of local operations. Supply a token provider bound to the verified account so a queued mutation cannot use a different account's token during a session switch.

```ts
import {
  OfflineQueue,
  ReactiveCoreError,
  createIndexedDbStore,
  type OfflineOperation,
} from '@reactivecore/client';
import { createClient } from './reactivecore-client';

type ItemInput = { title: string };

export function openItemQueue(
  origin: string,
  session: { issuer: string; audience: string; tenantId: string; userId: string },
  getAccessToken: () => Promise<string>,
  isSameSessionActive: () => boolean,
  render: (operations: OfflineOperation<ItemInput>[]) => void,
) {
  const lifetime = new AbortController();
  const client = createClient(origin, getAccessToken);
  const scope = JSON.stringify([
    new URL(origin).origin, session.issuer, session.audience,
    session.tenantId, session.userId,
  ]);
  const queue = new OfflineQueue(createIndexedDbStore<ItemInput>('rc-operations'), scope);

  async function refresh() {
    const operations = await queue.list();
    if (!lifetime.signal.aborted) render(operations);
  }

  async function sync() {
    await queue.sync(
      async (operation) => {
        try {
          const result = await client.mutate(
            'items.create', operation.args, operation.key, lifetime.signal,
          );
          return { state: 'confirmed', commitSeq: result.commitSeq };
        } catch (error) {
          if (error instanceof ReactiveCoreError) {
            if (error.status === 409) return { state: 'conflict', message: error.message };
            if (error.status === 400 || error.status === 403 || error.status === 404) {
              return { state: 'rejected', message: error.message };
            }
          }
          return { state: 'retry' };
        }
      },
      () => !lifetime.signal.aborted && navigator.onLine && isSameSessionActive(),
      () => { void refresh().catch(console.error); },
    );
    await refresh();
  }

  function requestSync() {
    void sync().catch(console.error);
  }

  window.addEventListener('online', requestSync);
  const timer = window.setInterval(requestSync, 5_000);
  requestSync();

  return {
    async create(title: string) {
      const operation = await queue.enqueue({ title });
      await refresh();
      requestSync();
      return operation.key;
    },
    async cancel(key: string) {
      const cancelled = await queue.cancel(key);
      await refresh();
      return cancelled;
    },
    dispose() {
      lifetime.abort();
      window.removeEventListener('online', requestSync);
      window.clearInterval(timer);
    },
  };
}
```

Wire the form's **Create** button to `create(title)`. The queue writes the operation before the frontend displays it. Use `operation.args.title` for the label, `operation.state` for the status, and `operation.key` for the **Cancel** button. Show that button for `pending` operations. If `cancel(key)` returns `false`, use the refreshed state because a send may already have started. Call `dispose()` when signing out, switching accounts, or unmounting the code that owns the queue.

The `online` event starts a sync pass and the timer lets delayed retries resume. Browser network status only indicates whether the device appears connected. A timeout or interrupted request can leave the server outcome unknown. The queue reuses the original arguments and idempotency key on retry so a previously committed write can be replayed safely.

#### 3. Reconcile the local operation with server data

Keep the latest `items.list` snapshot alongside the operation list. The starter example assigns item IDs on the server, so you can show local operations in a separate activity list. When a confirmed operation's `commitSeq` is at or below the latest snapshot's `seq`, the snapshot has caught up to that commit. Compare sequence strings with `BigInt`, for example `BigInt(snapshot.seq) >= BigInt(operation.commitSeq)` when a commit sequence is present. An item can be outside the current query's filters or limit even after catch-up.

For a single optimistic list like the tasks demo, extend both your mutation and its client manifest to accept a client-generated UUID. Validate it on the server, use it as the inserted row ID, and handle collisions. Generate it with `crypto.randomUUID()` when enqueuing, keep it in the persisted arguments, and merge the provisional row with the SSE row using that UUID. Keep the operation's idempotency key separate. It identifies the write attempt across retries, while the UUID identifies the row.

PostgreSQL applies the mutation transactionally when it reaches the server. For writes such as inventory transfers, you can show a pending operation separately and keep the last confirmed balance on screen until a new snapshot arrives.

#### 4. Verify in a browser

1. Open the frontend online and confirm that the subscription has delivered its first snapshot.
2. In browser developer tools, select **Network → Offline**. Create two items. Both should show `pending`. Cancel one and check that its status becomes `cancelled`.
3. Restore the connection. The other item should become `confirmed` and appear once in the live list. The cancelled item should stay absent from the server list.
4. To repeat the test across a page reload, serve the app shell offline, for example with a service worker, and restore the appropriate local queue. Cache query snapshots separately if the screen should also show the last confirmed data offline. Test a switch to another account and check that it cannot send the first account's pending operations.

On a TypeScript mobile or desktop frontend, reuse the queue with a platform-specific `OfflineStore`, such as a SQLite implementation. Implement its update operation as one atomic read, transition, and write. A frontend in another language can implement the same lifecycle against the HTTP and SSE endpoints.

### Resolve an offline edit conflict

The item example reads `version` in list and detail snapshots. A new item starts at version 1. The example's `items.update` and `items.delete` require `expectedVersion`. Existing applications can opt in by adding a positive integer `version` column and using the versioned methods. These methods return `applied`, `not-found`, or `conflict`. The example maps the last two results to HTTP 404 and HTTP 409.

Suppose two users read item version 7. Alice's update commits first and advances it to version 8. Bob queues an update while offline with `expectedVersion: 7`. When Bob reconnects, the server returns 409 and leaves Alice's edit intact. The same check applies if Bob queued a deletion. An exact replay of Alice's successful mutation returns her original receipt, even if the item has changed again.

```ts
const { data: current } = await client.query('items.get', { id });
if (current) {
  await client.mutate(
    'items.update',
    { id, title: 'Renamed item', expectedVersion: current.version },
    crypto.randomUUID(),
  );
}
```

For offline edits, store the version the user saw together with the draft fields in IndexedDB. Deliver those original arguments with the queue's idempotency key. On `409`, mark the operation as a conflict and show both the draft and the latest snapshot in Vue or Next.js. If the user confirms a new edit, queue it with the current version and a fresh key. If the current snapshot is `null`, show that the item is unavailable. The queue's retries for uncertain delivery continue to use the original key and arguments.

### Run the Next.js offline conflict example

The [example](examples/next-offline-conflicts) combines the IndexedDB queue, version-checked item mutations, SSE, and a service worker for reloading the app shell offline. It connects to the same backend on PostgreSQL or MySQL.

1. Start the API and worker using the PostgreSQL setup or the [MySQL walkthrough](#run-the-same-project-on-mysql-84). Add `http://127.0.0.1:4173` to `RC_CORS_ORIGINS` before starting the API. Use the item schema and handlers from this repository so reads include a version.
2. From the repository root, build and serve the static Next.js example.

   ```sh
   npm run build
   npm ci --prefix examples/next-offline-conflicts
   npm run build --prefix examples/next-offline-conflicts
   npm run start --prefix examples/next-offline-conflicts
   ```

3. Create an item using the mutation in step 7. Copy the item ID from its response. Generate two development tokens with distinct `sub` values and the same `tenant_id` using step 6. Keep the first token, replace `USER_ID` in `.env.identity` with a new UUID, then rerun step 6 for the second token. Open `http://127.0.0.1:4173` in two browser profiles and connect both to the same item using the corresponding tokens. Wait for **Offline reload ready** and the first server snapshot in the first profile.
4. Put the first profile offline and queue an edit. Reload while still offline, then enter the same API URL, item ID, and previously verified token. The queued draft should still appear. In the second profile, edit the item while online.
5. Reconnect the first profile. The queued edit should show `conflict` next to the latest server title and version. Click **Discard draft** to keep the server version, or edit the draft and select **Submit against latest version**. Resubmission creates a new queue operation with a new key. If the item is unavailable, the example disables resubmission.

The example keeps the token in memory. A token fingerprint lets the browser find its previously verified identity after an offline reload. Local snapshots and queue records are scoped by identity, and the example revalidates the session before sending queued operations. Use separate browser profiles to test two users. Serve the example over HTTPS if deploying it outside loopback so the browser can use its service worker and Web Crypto.

To run the Chromium scenario locally, start the example as above, then run these commands from the repository root. The MySQL command expects a disposable MySQL 8.4 server with administrative credentials. The workflow runs the same scenario on both engines.

```sh
(cd examples/next-offline-conflicts && npx playwright install chromium)
node scripts/test-infra.mjs
RC_BROWSER_CONFLICT_TEST=1 node --env-file=.env.reactivecore-test scripts/test-project.mjs
RC_BROWSER_CONFLICT_TEST=1 RC_MYSQL_TEST_URL=mysql://root:local_mysql_admin@127.0.0.1:53306 \
  node --env-file=.env.reactivecore-test scripts/test-mysql-project.mjs
```

## Run the same project on MySQL 8.4

Follow README steps 1–3 to build the workspace, create `../my-project` with the item functions, and start Redis. PostgreSQL may remain idle during this walkthrough. Replace the PostgreSQL provisioning and runtime commands in steps 4–5 with the commands below. The API and worker must use the same engine and the same project database.

### Prepare the schema and accounts

Run an isolated MySQL container on loopback. The example credentials are for local testing.

```sh
docker run -d --name reactivecore-guide-mysql \
  -p 127.0.0.1:53306:3306 \
  -e MYSQL_ROOT_PASSWORD=local_mysql_admin -e MYSQL_ROOT_HOST=% mysql:8.4
until docker exec reactivecore-guide-mysql mysqladmin ping -h 127.0.0.1 --silent; do sleep 2; done

docker exec -i reactivecore-guide-mysql mysql -uroot -plocal_mysql_admin <<'SQL'
CREATE DATABASE reactivecore_my_project CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE USER 'reactivecore_app'@'%' IDENTIFIED BY 'local_app_password';
CREATE USER 'reactivecore_worker'@'%' IDENTIFIED BY 'local_worker_password';
SQL
```

Keep MySQL project migrations in `migrations/mysql/` and declare the application tables permitted through `ctx.data`. All registered tables must use InnoDB and include `tenant_id`. The same `application.mjs` and generated frontend client work on both engines.

```sh
mkdir -p ../my-project/migrations/mysql
cp scripts/test-fixtures/project/migrations/mysql/*.sql ../my-project/migrations/mysql/
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const file = '../my-project/project.json';
const project = JSON.parse(readFileSync(file, 'utf8'));
project.mysql = { tables: ['items'] };
writeFileSync(file, JSON.stringify(project, null, 2) + '\n');
JS

export RC_PROVISION_ADMIN_URL=mysql://root:local_mysql_admin@127.0.0.1:53306/reactivecore_my_project
npm run project -- provision ../my-project
TENANT_ID=$(node -p 'crypto.randomUUID()')
USER_ID=$(node -p 'crypto.randomUUID()')
npm run project -- tenant ../my-project "$TENANT_ID"
(umask 077 && printf 'TENANT_ID=%s\nUSER_ID=%s\n' "$TENANT_ID" "$USER_ID" > ../my-project/.env.identity)
unset RC_PROVISION_ADMIN_URL
```

Grant the runtime roles only the operations used by the engine and the example:

```sh
docker exec -i reactivecore-guide-mysql mysql -uroot -plocal_mysql_admin <<'SQL'
GRANT SELECT, UPDATE ON reactivecore_my_project.rc_commit_clock TO 'reactivecore_app'@'%';
GRANT SELECT, INSERT, UPDATE ON reactivecore_my_project.rc_receipts TO 'reactivecore_app'@'%';
GRANT SELECT, INSERT ON reactivecore_my_project.rc_changes TO 'reactivecore_app'@'%';
GRANT INSERT ON reactivecore_my_project.rc_outbox TO 'reactivecore_app'@'%';
GRANT SELECT, INSERT, UPDATE (title, version), DELETE ON reactivecore_my_project.items TO 'reactivecore_app'@'%';
GRANT SELECT, UPDATE (lease_token, available_at, attempts, published_at)
    ON reactivecore_my_project.rc_outbox TO 'reactivecore_worker'@'%';
SQL
```

### Start the runtime and verify both engines

Use the API and worker commands from step 5 in separate terminals. In each terminal, replace the `DATABASE_URL` line with the corresponding MySQL connection string.

| Process | Local MySQL `DATABASE_URL` |
| --- | --- |
| API | `mysql://reactivecore_app:local_app_password@127.0.0.1:53306/reactivecore_my_project` |
| Worker | `mysql://reactivecore_worker:local_worker_password@127.0.0.1:53306/reactivecore_my_project` |

Repeat steps 6–8. The first query returns an empty list, the mutation creates one item even when replayed with the same key, and Vue or Next.js receives the update without a page reload. Health reports the active engine under `services.mysql`. Stop the runtime processes, then run `docker stop reactivecore-guide-mysql` to stop the local database.

**Preview scope.** MySQL enforces tenant scoping for the supported `ctx.data` operations. The MySQL handler context rejects raw `ctx.client` access. Database logins are shared infrastructure credentials and must remain private to the backend. PostgreSQL projects can continue using native SQL and database-level row security. MySQL DDL commits implicitly. Apply trusted, restartable migrations and check the database state after a failed migration before retrying. For a remote MySQL server, use the certificate's DNS hostname, append `?ssl=verify-full` to each URL, and configure the CA with `NODE_EXTRA_CA_CERTS` if required. Remote MySQL offerings have yet to be validated.

The generated client also exposes version-checked `items.update` and `items.delete`. See [Resolve an offline edit conflict](#resolve-an-offline-edit-conflict).

The MySQL CI test uses a disposable database and the same application fixture as PostgreSQL. It checks repeatable provisioning, isolation between tenants, rollback when the outbox write fails, concurrent idempotent replay, SSE delivery and reconnection, tenant-scoped updates and deletes, detail subscriptions, and worker acknowledgement.

## 9. Configure a production deployment

See the [operations guide](OPERATIONS.md) for release artifacts, container deployment, database backup and recovery, and upgrades. ReactiveCore is distributed under the [MIT License](LICENSE).

1. Run provisioning as an administrative job. Give the API the `reactivecore_app` database URL and the worker the `reactivecore_worker` URL. Store the credentials and Redis URL in your deployment's secret manager.
2. Configure an identity provider to sign RS256 access tokens. Set `RC_JWT_ISSUER`, `RC_JWT_AUDIENCE`, and `RC_JWKS_URL` on the API. Use an HTTPS JWKS URL. Include `iat` and `exp` and give tokens a lifetime of at most one hour. The issuer must supply a UUID in `sub`, the authorized tenant UUID in `tenant_id`, and a space-separated `scope` with the allowed operations. Use the application function policies for permissions within a tenant.
3. Serve the API over HTTPS. Allow the frontend origins in `RC_CORS_ORIGINS` and configure the reverse proxy to stream SSE without response buffering. Set `RC_HOST` and `PORT` for your deployment. If you override `RC_INVALIDATION_CHANNEL`, give the API and worker the same value.
4. Monitor `/api/health/live` and `/api/health/ready`. Monitor Redis separately through `/api/health`. The durable change log lets the subscription engine catch up when Redis is unavailable. Deploy trusted project modules with the API and use separate deployments and credentials for applications operated by independent teams.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Compose cannot bind a port | Pick free ports in `.env.compose` and update every URL that uses them. |
| PostgreSQL rejects a password | Confirm the role and password for that cluster. Existing volumes preserve initialized credentials. |
| `401` | Regenerate an expired token and compare its issuer, audience, and signature with the API configuration. |
| `403` | Check the JWT scopes and the function's access policy. |
| Query works but SSE updates are delayed | Check the worker and Redis, verify that query dependencies and mutation changes use the same table, and check proxy buffering. |
| Browser reports a CORS error | Add the exact frontend origin to `RC_CORS_ORIGINS` and restart the API. |

To stop the local environment, stop the API, worker, and SSE client with Ctrl+C, then run the following. The named volumes retain your data.

```sh
docker compose -p reactivecore-guide --env-file ../my-project/.env.compose down
```

## Verify the engine

```sh
npm run build
npm test
node --test packages/client/test/offline.test.mjs
node scripts/test-infra.mjs
node --env-file=.env.reactivecore-test scripts/test-project.mjs
```

The integration test creates a temporary project and verifies generated types, migrations, idempotency, live updates, worker acknowledgement, and restoration from a PostgreSQL backup.
