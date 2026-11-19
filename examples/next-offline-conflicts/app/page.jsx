'use client';

import { useEffect, useState } from 'react';
import { Editor } from './editor';
import { identityScope, openIdentity, warmShell } from './session';

export default function Home() {
  const [session, setSession] = useState(null);
  const [shell, setShell] = useState('Preparing offline reload.');
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) {
      setShell('Offline reload requires a service worker.');
      return;
    }
    let active = true;
    if (!navigator.onLine) {
      setShell('Offline shell loaded.');
      return;
    }
    warmShell()
      .then((ready) => {
        if (active)
          setShell(
            ready ? 'Offline reload ready.' : 'Offline reload unavailable.',
          );
      })
      .catch(() => {
        if (active) setShell('Offline reload unavailable.');
      });
    return () => {
      active = false;
    };
  }, []);

  async function connect(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setConnecting(true);
    setError('');
    try {
      const endpoint = new URL(String(form.get('endpoint')).trim());
      if (!['http:', 'https:'].includes(endpoint.protocol))
        throw new Error('Enter an HTTP or HTTPS API URL.');
      const origin = endpoint.origin;
      const token = String(form.get('token')).trim();
      const id = String(form.get('item')).trim().toLowerCase();
      const identity = await openIdentity(origin, token);
      setSession({ origin, token, id, scope: identityScope(origin, identity) });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed.');
    } finally {
      setConnecting(false);
    }
  }

  return (
    <main>
      <h1>Offline item edits</h1>
      <p role="status">{shell}</p>
      {session ? (
        <>
          <button onClick={() => setSession(null)}>Disconnect</button>
          <Editor session={session} />
        </>
      ) : (
        <form onSubmit={connect}>
          <label htmlFor="endpoint">ReactiveCore API URL</label>
          <input
            id="endpoint"
            name="endpoint"
            type="url"
            defaultValue="http://127.0.0.1:4000"
            required
          />
          <label htmlFor="item">Item ID</label>
          <input id="item" name="item" required />
          <label htmlFor="token">Development token</label>
          <input
            id="token"
            name="token"
            type="password"
            autoComplete="off"
            required
          />
          <button disabled={connecting}>Open item</button>
          {error && <p role="alert">{error}</p>}
        </form>
      )}
    </main>
  );
}
