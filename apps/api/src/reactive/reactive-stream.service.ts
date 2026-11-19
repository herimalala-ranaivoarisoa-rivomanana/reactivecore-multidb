import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import type { QueryPrincipal } from './contracts/query-context.js';
import { SubscriptionManagerService } from './subscriptions/subscription-manager.service.js';

@Injectable()
export class ReactiveStreamService {
  constructor(private readonly subscriptions: SubscriptionManagerService) {}

  /** Streams complete snapshots and releases the subscription when the connection closes. */
  async open(
    response: Response,
    principal: QueryPrincipal,
    name: string,
    args: unknown,
    expiresAt?: number,
  ): Promise<void> {
    response.status(200);
    const connection = new AbortController();
    if (response.destroyed) return;
    let blocked = false;
    let pending: string | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    function close() {
      connection.abort();
      clearInterval(heartbeat);
      clearTimeout(expiration);
      pending = undefined;
      response.off('drain', drain);
    }

    function write(frame: string) {
      if (connection.signal.aborted || response.destroyed) return;
      if (blocked) {
        pending = frame;
        return;
      }
      blocked = !response.write(frame);
    }

    function drain() {
      blocked = false;
      const frame = pending;
      pending = undefined;
      if (frame) write(frame);
    }

    const expiration =
      expiresAt === undefined
        ? undefined
        : setTimeout(
            () => {
              close();
              response.end();
            },
            Math.max(0, expiresAt - Date.now()),
          );
    expiration?.unref();

    response.once('close', close);
    response.on('drain', drain);
    let lastSequence: bigint | undefined;
    try {
      await this.subscriptions.subscribe(
        principal,
        name,
        args,
        ({ snapshotSeq, data }) => {
          if (connection.signal.aborted || response.destroyed) return;
          const sequence = BigInt(snapshotSeq);
          if (lastSequence !== undefined && sequence < lastSequence) {
            close();
            response.end();
            return;
          }
          lastSequence = sequence;
          if (!response.headersSent) {
            response.set({
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache, no-transform',
              'X-Accel-Buffering': 'no',
            });
            heartbeat = setInterval(() => {
              if (!blocked) write(': heartbeat\n\n');
            }, 15000);
            heartbeat.unref();
          }
          write(
            `id: ${snapshotSeq}\nevent: snapshot\ndata: ${JSON.stringify({ seq: snapshotSeq, data })}\n\n`,
          );
        },
        connection.signal,
      );
    } catch (error) {
      if (connection.signal.aborted) return;
      close();
      throw error;
    }
  }
}
