import { ServiceUnavailableException } from '@nestjs/common';

/** Limits active PostgreSQL mutation transactions without taking connections while queued. */
export class PostgresMutationAdmission {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly concurrency: number,
    private readonly queueCapacity = 64,
  ) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 0)
      throw new Error(
        'RC_PG_MUTATION_CONCURRENCY must be a nonnegative integer',
      );
  }

  async run<T>(transaction: () => Promise<T>): Promise<T> {
    if (this.concurrency === 0) return transaction();

    if (this.active < this.concurrency) {
      this.active++;
    } else {
      if (this.waiting.length >= this.queueCapacity)
        throw new ServiceUnavailableException(
          'PostgreSQL mutation queue is full',
        );
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }

    try {
      return await transaction();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
