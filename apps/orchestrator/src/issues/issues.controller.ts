import {
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
  type IssueStatus,
  type NewIssue,
} from '@page/contracts';
import { z } from 'zod';
import { IssueNotFoundError, IssuesService } from './issues.service.ts';
import { TransitionError } from './transitions.ts';

const issueId = z.uuid();

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
  constructor(private readonly issues: IssuesService) {}

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

  /** Applies one event. 409 when the issue's status doesn't allow it. */
  @Post(':id/events')
  @HttpCode(200)
  apply(
    @Param('id', { schema: issueId }) id: string,
    @Body({ schema: issueEventSchema }) event: IssueEvent,
  ): Promise<Issue> {
    return asHttp(this.issues.apply(id, event));
  }
}
