export function identityScope(origin, identity) {
  return JSON.stringify([
    origin,
    identity.issuer,
    identity.audience,
    identity.tenantId,
    identity.userId,
  ]);
}

export async function verifyIdentity(origin, token, signal) {
  const response = await fetch(new URL('/api/v1/session', origin), {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
    signal,
  });
  if (!response.ok)
    throw new Error(`Session check failed (HTTP ${response.status}).`);
  return response.json();
}

export async function openIdentity(origin, token) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  );
  const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const key = `rc-identity:${origin}:${fingerprint}`;
  if (navigator.onLine) {
    const identity = await verifyIdentity(
      origin,
      token,
      AbortSignal.timeout(5000),
    );
    localStorage.setItem(key, JSON.stringify(identity));
    return identity;
  }
  const stored = localStorage.getItem(key);
  if (!stored)
    throw new Error(
      'Connect online once with this token before opening the queue offline.',
    );
  return JSON.parse(stored);
}

export async function warmShell() {
  await navigator.serviceWorker.register('/sw.js');
  const registration = await navigator.serviceWorker.ready;
  const assets = [
    '/',
    ...Array.from(
      document.querySelectorAll('script[src], link[rel="stylesheet"]'),
      (element) => element.src ?? element.href,
    ),
    ...performance.getEntriesByType('resource').map(({ name }) => name),
  ];
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      resolve(false);
    }, 5000);
    channel.port1.onmessage = ({ data }) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(data === true);
    };
    registration.active.postMessage({ type: 'warm-shell', assets }, [
      channel.port2,
    ]);
  });
}
