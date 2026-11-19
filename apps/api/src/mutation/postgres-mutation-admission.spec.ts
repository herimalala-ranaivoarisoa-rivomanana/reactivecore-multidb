import { PostgresMutationAdmission } from './postgres-mutation-admission.js';

it('bounds admitted mutations and releases a slot after failure', async () => {
  const admission = new PostgresMutationAdmission(1, 1);
  const first = Promise.withResolvers<void>();
  const running = admission.run(() => first.promise);
  const next = vi.fn(async () => 'next');
  const queued = admission.run(next);
  await expect(admission.run(vi.fn())).rejects.toMatchObject({ status: 503 });
  expect(next).not.toHaveBeenCalled();

  const failed = expect(running).rejects.toThrow('write failed');
  first.reject(new Error('write failed'));
  await failed;
  await expect(queued).resolves.toBe('next');
  expect(next).toHaveBeenCalledTimes(1);
});

it('keeps concurrent execution when the limit is disabled', async () => {
  const admission = new PostgresMutationAdmission(0);
  const first = Promise.withResolvers<void>();
  const running = admission.run(() => first.promise);
  await expect(admission.run(async () => 'second')).resolves.toBe('second');
  first.resolve();
  await running;
});
