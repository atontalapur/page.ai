import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  issueEventSchema,
  issueStatusSchema,
  newIssueSchema,
  type Issue,
  type IssueEvent,
  type IssueEventRecord,
  type IssueRun,
  type IssueStatus,
  type NewIssue,
} from '@page/contracts';
import { z } from 'zod';
import type { Caller } from '../auth/api-tokens.ts';
import { actorOf, CallerOf } from '../auth/caller.ts';
import { RunsService } from '../runs/runs.service.ts';
import { IssueNotFoundError, IssuesService } from './issues.service.ts';
import { TransitionError } from './transitions.ts';

const issueId = z.uuid();

/**
 * Run outcomes. They reach an issue only from the node's run_finished jobs (RunsService),
 * which also write the runs and escalations rows and pass the escalation note on.
 */
const RUN_EVENTS: ReadonlySet<IssueEvent['type']> = new Set([
  'patch_ready',
  'ops_fixed',
  'escalate',
  'fail',
]);

async function asHttp<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    if (err instanceof IssueNotFoundError) throw new NotFoundException(err.message);
    if (err instanceof TransitionError) throw new ConflictException(err.message);
    throw err;
  }
}

@Controller('issues')
export class IssuesController {
  constructor(
    private readonly issues: IssuesService,
    private readonly runs: RunsService,
  ) {}

  /** Opens an issue, or counts a repeat of the open one with the same fingerprint. */
  @Post()
  report(
    @Body({ schema: newIssueSchema }) body: NewIssue,
  ): Promise<{ issue: Issue; created: boolean }> {
    return this.issues.report(body);
  }

  @Get()
  list(
    @Query('status', { schema: issueStatusSchema.optional() }) status?: IssueStatus,
  ): Promise<Issue[]> {
    return this.issues.list(status);
  }

  @Get(':id')
  get(@Param('id', { schema: issueId }) id: string): Promise<Issue> {
    return asHttp(this.issues.get(id));
  }

  @Get(':id/events')
  events(@Param('id', { schema: issueId }) id: string): Promise<IssueEventRecord[]> {
    return asHttp(this.issues.events(id));
  }

  /** Every run, oldest first, with its steps, messages and diff. The run in progress is last. */
  @Get(':id/runs')
  runsOf(@Param('id', { schema: issueId }) id: string): Promise<IssueRun[]> {
    return asHttp(this.runs.forIssue(id));
  }

  /**
   * Applies one event, recorded under who sent it: the person a personal token names, or the
   * shared token. 400 for a run outcome, which only the run_finished queue applies. 409 when
   * the issue's status doesn't allow the event.
   */
  @Post(':id/events')
  @HttpCode(200)
  apply(
    @Param('id', { schema: issueId }) id: string,
    @Body({ schema: issueEventSchema }) event: IssueEvent,
    @CallerOf() caller: Caller | undefined,
  ): Promise<Issue> {
    if (RUN_EVENTS.has(event.type)) {
      throw new BadRequestException(
        `${event.type} comes from the node daemon's run_finished job, not this route`,
      );
    }
    const actor = caller === undefined ? undefined : actorOf(caller);
    return asHttp(this.issues.apply(id, event, actor === undefined ? {} : { actor }));
  }
}
