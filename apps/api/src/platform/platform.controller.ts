import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  NotFoundException,
  Post,
  Res,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { IsDefined, IsString, Matches } from 'class-validator';
import type { Response } from 'express';
import { MutationEngineService } from '../mutation/mutation-engine.service.js';
import { QueryExecutorService } from '../reactive/engine/query-executor.service.js';
import { ReactiveStreamService } from '../reactive/reactive-stream.service.js';
import { PROJECT, type Operation, type Project } from './project.js';
import {
  ProjectAuthGuard,
  Session,
  type ProjectSession,
} from './project-auth.guard.js';

function streamLimit(name: string, fallback: number): number {
  const configured = process.env[name];
  if (configured === undefined) return fallback;
  const value = Number(configured);
  if (!/^\d+$/.test(configured) || !Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

class Invocation {
  @IsString()
  @Matches(/^[a-z][a-z0-9_.-]{1,127}$/)
  name!: string;

  @IsDefined()
  args!: unknown;
}

@Controller('v1')
@UseGuards(ProjectAuthGuard)
@UsePipes(
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  }),
)
export class PlatformController {
  private readonly streamsByPrincipal = new Map<string, number>();
  private readonly maxStreams = streamLimit('RC_SSE_MAX_STREAMS', 500);
  private readonly maxStreamsPerUser = streamLimit(
    'RC_SSE_MAX_STREAMS_PER_USER',
    8,
  );
  private activeStreams = 0;

  constructor(
    @Inject(PROJECT) private readonly project: Project,
    private readonly queries: QueryExecutorService,
    private readonly mutations: MutationEngineService,
    private readonly stream: ReactiveStreamService,
  ) {}

  private authorize(
    session: ProjectSession,
    operation: Operation,
    body: Invocation,
  ): void {
    if (!session.scopes.includes(operation))
      throw new ForbiddenException('Operation not authorized');
    if (operation === 'mutation') {
      if (!this.project.functions.mutations.includes(body.name))
        throw new NotFoundException('Function not exposed');
    } else {
      const functions = this.project.functions.queries;
      if (!Object.hasOwn(functions, body.name))
        throw new NotFoundException('Function not exposed');
      functions[body.name](session.principal, body.args);
    }
  }

  @Get('session')
  @Header('Cache-Control', 'no-store')
  identity(@Session() session: ProjectSession) {
    return {
      issuer: this.project.issuer,
      audience: this.project.audience,
      tenantId: session.principal.tenantId,
      userId: session.principal.userId,
      scopes: session.scopes,
    };
  }

  @Post('query')
  @HttpCode(200)
  async query(@Session() session: ProjectSession, @Body() body: Invocation) {
    this.authorize(session, 'query', body);
    const { data, snapshotSeq } = await this.queries.execute(
      session.principal,
      body.name,
      body.args,
    );
    return { data, seq: snapshotSeq };
  }

  @Post('mutation')
  @HttpCode(200)
  mutation(
    @Session() session: ProjectSession,
    @Body() body: Invocation,
    @Headers('idempotency-key') key?: string,
  ) {
    this.authorize(session, 'mutation', body);
    return this.mutations.execute({
      ...body,
      principal: session.principal,
      idempotencyKey: key ?? '',
    });
  }

  @Post('subscribe')
  async subscribe(
    @Session() session: ProjectSession,
    @Body() body: Invocation,
    @Res() response: Response,
  ) {
    this.authorize(session, 'subscribe', body);
    const key = JSON.stringify([
      session.principal.tenantId,
      session.principal.userId,
    ]);
    const count = this.streamsByPrincipal.get(key) ?? 0;
    if (
      this.activeStreams >= this.maxStreams ||
      count >= this.maxStreamsPerUser
    ) {
      throw new HttpException('Too many subscriptions', 429);
    }
    if (response.destroyed) return;
    this.activeStreams++;
    this.streamsByPrincipal.set(key, count + 1);

    let released = false;
    const releaseSlot = () => {
      if (released) return;
      released = true;
      response.off('close', releaseSlot);
      this.activeStreams--;
      const current = this.streamsByPrincipal.get(key) ?? 0;
      if (current <= 1) this.streamsByPrincipal.delete(key);
      else this.streamsByPrincipal.set(key, current - 1);
    };
    response.once('close', releaseSlot);
    try {
      await this.stream.open(
        response,
        session.principal,
        body.name,
        body.args,
        session.expiresAt,
      );
    } catch (error) {
      releaseSlot();
      throw error;
    }
  }
}
