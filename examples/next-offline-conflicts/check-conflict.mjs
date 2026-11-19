import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';

const web = 'http://127.0.0.1:4173';

async function connect(page, origin, token, item) {
  await page.getByLabel('ReactiveCore API URL').fill(origin);
  await page.getByLabel('Item ID').fill(item);
  await page.getByLabel('Development token').fill(token);
  await page.getByRole('button', { name: 'Open item' }).click();
}

async function edit(page, title) {
  await page.getByLabel('New title').fill(title);
  await page.getByRole('button', { name: 'Queue edit' }).click();
}

async function expectTitle(page, title) {
  const titleNode = page.getByTestId('server-title').filter({ hasText: title });
  await titleNode.waitFor();
  assert.equal(await titleNode.textContent(), title);
}

function operation(page, state, title) {
  return page
    .locator(`article[data-state="${state}"]`)
    .filter({ hasText: title });
}

export async function checkBrowserConflict({ origin, client, tokens, signal }) {
  const { data } = await client.mutate(
    'items.create',
    { title: 'Initial title' },
    randomUUID(),
    signal,
  );
  const executablePath = process.env.RC_TEST_CHROMIUM;
  const browser = await chromium.launch(
    executablePath ? { executablePath } : {},
  );
  try {
    const [alice, bob] = await Promise.all([
      browser.newContext(),
      browser.newContext(),
    ]);
    const [first, second] = await Promise.all([alice.newPage(), bob.newPage()]);
    for (const page of [first, second]) page.setDefaultTimeout(12000);
    await Promise.all([first, second].map((page) => page.goto(web)));
    await first.getByText('Offline reload ready.', { exact: true }).waitFor();
    await Promise.all([
      connect(first, origin, tokens[0], data.id),
      connect(second, origin, tokens[1], data.id),
    ]);
    await Promise.all([
      expectTitle(first, 'Initial title'),
      expectTitle(second, 'Initial title'),
    ]);

    await alice.setOffline(true);
    await edit(first, 'Offline draft');
    await operation(first, 'pending', 'Offline draft').waitFor();
    await first.reload();
    await first.getByText('Offline shell loaded.', { exact: true }).waitFor();
    await connect(first, origin, tokens[0], data.id);
    await operation(first, 'pending', 'Offline draft').waitFor();

    await edit(second, 'Other user edit');
    await expectTitle(second, 'Other user edit');
    await bob.close();
    await alice.setOffline(false);
    const conflict = operation(first, 'conflict', 'Offline draft');
    await conflict.waitFor();
    await expectTitle(first, 'Other user edit');

    // Reload a second time while offline to verify the conflict itself is durable.
    await alice.setOffline(true);
    await first.reload();
    await connect(first, origin, tokens[0], data.id);
    await conflict.waitFor();
    await expectTitle(first, 'Other user edit');
    const retained = await client.query('items.get', { id: data.id }, signal);
    assert.equal(retained.data.title, 'Other user edit');
    assert.equal(retained.data.version, 2);

    await alice.setOffline(false);
    await conflict.getByLabel('Resolve title').fill('Merged edit');
    await conflict
      .getByRole('button', { name: 'Submit against latest version' })
      .click();
    await operation(first, 'confirmed', 'Merged edit').waitFor();
    await expectTitle(first, 'Merged edit');
    const updated = await client.query('items.get', { id: data.id }, signal);
    assert.equal(updated.data.title, 'Merged edit');
    assert.equal(updated.data.version, 3);

    await alice.setOffline(true);
    await edit(first, 'Discard this draft');
    await operation(first, 'pending', 'Discard this draft').waitFor();
    const newer = await client.mutate(
      'items.update',
      {
        id: data.id,
        title: 'Keep the server version',
        expectedVersion: 3,
      },
      randomUUID(),
      signal,
    );
    await alice.setOffline(false);
    const abandoned = operation(first, 'conflict', 'Discard this draft');
    await abandoned.getByRole('button', { name: 'Discard draft' }).click();
    await operation(first, 'cancelled', 'Discard this draft').waitFor();
    assert.deepEqual(
      (await client.query('items.get', { id: data.id }, signal)).data,
      newer.data,
    );

    await client.mutate(
      'items.delete',
      { id: data.id, expectedVersion: 4 },
      randomUUID(),
      signal,
    );
    await first.getByText('Item unavailable.', { exact: true }).waitFor();

    console.log(
      'Browser verified offline reload, retained conflict, and resolution through SSE.',
    );
  } finally {
    await browser.close();
  }
}
