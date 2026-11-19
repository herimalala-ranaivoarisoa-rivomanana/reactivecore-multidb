'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createIndexedDbStore,
  OfflineQueue,
  ReactiveCoreClient,
  ReactiveCoreError,
} from '@reactivecore/client';
import { identityScope, verifyIdentity } from './session';

export function Editor({ session }) {
  const { id, origin, scope, token } = session;
  const cacheKey = `rc-item:${scope}:${id}`;
  const [snapshot, setSnapshot] = useState(() =>
    JSON.parse(localStorage.getItem(cacheKey) ?? 'null'),
  );
  const [operations, setOperations] = useState([]);
  const [title, setTitle] = useState('');
  const [draftVersion, setDraftVersion] = useState(null);
  const [error, setError] = useState('');
  const [resolving, setResolving] = useState(false);
  const controls = useRef(null);
  const store = useMemo(
    () => createIndexedDbStore('reactivecore-offline-edits'),
    [],
  );
  const queue = useMemo(() => new OfflineQueue(store, scope), [store, scope]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const client = new ReactiveCoreClient(origin, () => token);
    let syncing = false;
    let refreshId = 0;

    async function refresh() {
      const request = ++refreshId;
      const records = await queue.list();
      if (!signal.aborted && request === refreshId)
        setOperations(records.filter((record) => record.args.id === id));
    }

    const showError = (err) => {
      if (!signal.aborted)
        setError(err instanceof Error ? err.message : 'Operation failed.');
    };

    async function sync() {
      if (syncing || signal.aborted || !navigator.onLine) return;
      syncing = true;
      try {
        const queued = await queue.list();
        if (
          !queued.some(({ state }) =>
            ['pending', 'sending', 'retry'].includes(state),
          )
        )
          return;
        const verified = await verifyIdentity(
          origin,
          token,
          AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        );
        if (identityScope(origin, verified) !== scope)
          throw new Error('The active session changed.');
        await queue.sync(
          async (operation) => {
            try {
              const result = await client.mutate(
                'items.update',
                operation.args,
                operation.key,
                signal,
              );
              return { state: 'confirmed', commitSeq: result.commitSeq };
            } catch (err) {
              if (err instanceof ReactiveCoreError) {
                if (err.status === 409) return { state: 'conflict' };
                if ([400, 403, 404].includes(err.status))
                  return { state: 'rejected', message: err.message };
              }
              return { state: 'retry' };
            }
          },
          () => navigator.onLine && !signal.aborted,
          () => {
            void refresh().catch(showError);
          },
        );
      } catch (err) {
        showError(err);
      } finally {
        syncing = false;
        await refresh().catch(showError);
      }
    }

    async function subscribe() {
      try {
        for await (const next of client.subscribe(
          'items.get',
          { id },
          signal,
        )) {
          if (signal.aborted) return;
          localStorage.setItem(cacheKey, JSON.stringify(next));
          setSnapshot(next);
        }
      } catch (err) {
        showError(err);
      }
    }

    controls.current = { refresh, sync };
    window.addEventListener('online', sync);
    const timer = window.setInterval(sync, 2000);
    void refresh().catch(showError);
    void subscribe();
    void sync();
    return () => {
      controller.abort();
      controls.current = null;
      window.removeEventListener('online', sync);
      window.clearInterval(timer);
    };
  }, [cacheKey, id, origin, queue, scope, token]);

  async function enqueue(draft, version) {
    await queue.enqueue({ id, title: draft.trim(), expectedVersion: version });
    await controls.current?.refresh();
    void controls.current?.sync();
  }

  async function save(event) {
    event.preventDefault();
    if (!snapshot?.data || !title.trim() || draftVersion === null) return;
    try {
      await enqueue(title, draftVersion);
      setTitle('');
      setDraftVersion(null);
    } catch (err) {
      setError(err.message);
    }
  }

  async function resolve(record, draft) {
    if (resolving) return;
    setResolving(true);
    try {
      if (draft !== undefined) {
        if (!availableVersion(record) || !draft.trim()) return;
        await enqueue(draft, snapshot.data.version);
      }
      await store.update(record.key, (current) =>
        current.scope === scope && current.state === 'conflict'
          ? { ...current, state: 'cancelled' }
          : undefined,
      );
      await controls.current?.refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setResolving(false);
    }
  }

  function availableVersion(record) {
    return (
      snapshot?.data && snapshot.data.version > record.args.expectedVersion
    );
  }

  return (
    <>
      <section aria-label="Server snapshot">
        <h2>Latest server version</h2>
        {snapshot?.data ? (
          <>
            <p data-testid="server-title">{snapshot.data.title}</p>
            <p data-testid="server-version">Version {snapshot.data.version}</p>
            <form onSubmit={save}>
              <label htmlFor="draft">New title</label>
              <input
                id="draft"
                value={title}
                onChange={(event) => {
                  if (draftVersion === null)
                    setDraftVersion(snapshot.data.version);
                  setTitle(event.target.value);
                }}
                maxLength={120}
                required
              />
              <button>Queue edit</button>
            </form>
          </>
        ) : (
          <p>
            {snapshot ? 'Item unavailable.' : 'Waiting for the first snapshot.'}
          </p>
        )}
      </section>
      <section aria-label="Local operations">
        <h2>Local operations</h2>
        {operations.map((record) => (
          <article key={record.key} data-state={record.state}>
            <h3>{record.args.title}</h3>
            <p>
              {record.state} · Based on version {record.args.expectedVersion}
            </p>
            {record.state === 'conflict' && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void resolve(
                    record,
                    String(new FormData(event.currentTarget).get('resolution')),
                  );
                }}
              >
                <label htmlFor={record.key}>Resolve title</label>
                <input
                  id={record.key}
                  name="resolution"
                  defaultValue={record.args.title}
                  maxLength={120}
                  required
                />
                <button disabled={resolving || !availableVersion(record)}>
                  Submit against latest version
                </button>
                <button
                  type="button"
                  disabled={resolving}
                  onClick={() => void resolve(record)}
                >
                  Discard draft
                </button>
              </form>
            )}
          </article>
        ))}
      </section>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
