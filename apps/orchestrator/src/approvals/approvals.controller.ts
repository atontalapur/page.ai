import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Query,
} from '@nestjs/common';
import type { Approval } from '@page/contracts';
import { z } from 'zod';
import { IssueNotFoundError } from '../issues/issues.service.ts';
import { ApprovalsService } from './approvals.service.ts';
import type { ApprovalsService as Approvals } from './approvals.service.ts';

@Controller('approvals')
export class ApprovalsController {
  // A class-typed parameter makes oxc emit a metadata branch no test can reach, which fails
  // the strict coverage glob on approval code. The type-only alias emits `Object` instead.
  constructor(@Inject(ApprovalsService) private readonly approvals: Approvals) {}

  /**
   * An issue's approvals (`?issueId=`) or a run's (`?runId=`), oldest first, pending and
   * decided. A tab loads them when it opens an incident and after a reconnect, so it shows
   * the requests still waiting. 400 without exactly one of the two, 404 for an unknown issue.
   */
  @Get()
  async list(
    @Query('issueId', { schema: z.uuid().optional() }) issueId?: string,
    @Query('runId', { schema: z.uuid().optional() }) runId?: string,
  ): Promise<Approval[]> {
    if ((issueId === undefined) === (runId === undefined)) {
      throw new BadRequestException('give issueId or runId, one of them');
    }
    if (runId !== undefined) return this.approvals.forRun(runId);
    try {
      return await this.approvals.forIssue(issueId!);
    } catch (err) {
      if (err instanceof IssueNotFoundError) throw new NotFoundException(err.message);
      throw err;
    }
  }
}
