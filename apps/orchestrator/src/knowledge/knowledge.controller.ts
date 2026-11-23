import {
  BadRequestException,
  ConflictException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import {
  idSchema,
  kgBranchNameSchema,
  kgCommitSchema,
  kgKeySchema,
  kgSearchSchema,
  kgWriteEdgeSchema,
  kgWriteNodeSchema,
  MAIN_BRANCH,
  type KgWriteEdge,
  type KgWriteNode,
} from '@page/contracts';
import { z } from 'zod';
import { SkipApiToken } from '../auth/api-token.guard.ts';
import { authorizationHeader, bearerAuthorized } from '../auth/bearer.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/database.ts';
import { RateLimitGuard } from '../rate-limit.guard.ts';
import { GitHubAppService } from '../github/github-app.service.ts';
import { CONFIG, DB } from '../tokens.ts';
import {
  KgConflictError,
  KgNotFoundError,
  KgRefusedError,
  KnowledgeService,
  runBranch,
} from './knowledge.service.ts';
import { seedMain } from './seed.ts';

async function asHttp<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof KgNotFoundError) throw new NotFoundException(error.message);
    if (error instanceof KgRefusedError) throw new BadRequestException(error.message);
    if (error instanceof KgConflictError) throw new ConflictException(error.message);
    throw error;
  }
}

const branchQuery = kgBranchNameSchema.default(MAIN_BRANCH);
const searchBody = kgSearchSchema;

/** The knowledge graph for the dashboard: read and search any branch. */
@Controller('kg')
@UseGuards(new RateLimitGuard(120, 60_000))
export class KnowledgeController {
  constructor(
    private readonly knowledge: KnowledgeService,
    private readonly github: GitHubAppService,
  ) {}

  /** Reads the demo repo's main branch into the graph's main, stamped with its head commit. */
  @Post('seed')
  @HttpCode(200)
  @UseGuards(new RateLimitGuard(2, 60_000))
  async seed() {
    const api = await this.github.api();
    if (!api) throw new NotFoundException('GitHub is not set up on this orchestrator');
    return seedMain(api, this.knowledge, 'seed:main');
  }

  @Get('branches')
  branches() {
    return this.knowledge.branches();
  }

  @Get('graph')
  graph(@Query('branch', { schema: branchQuery }) branch: string) {
    return this.knowledge.graph(branch);
  }

  @Get('node')
  node(
    @Query('branch', { schema: branchQuery }) branch: string,
    @Query('key', { schema: kgKeySchema }) key: string,
  ) {
    return asHttp(this.knowledge.node(branch, key));
  }

  @Post('search')
  @HttpCode(200)
  search(@Body({ schema: searchBody }) body: z.infer<typeof searchBody>) {
    return asHttp(this.knowledge.search(body.branch, body.query));
  }
}

/** A node daemon's shared secret, which the knowledge tools send instead of the API token. */
@Injectable()
export class NodeSecretGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: Config) {}

  canActivate(context: ExecutionContext): boolean {
    if (!bearerAuthorized(authorizationHeader(context), this.config.nodeSharedSecret)) {
      throw new UnauthorizedException();
    }
    return true;
  }
}

/**
 * The agents' knowledge tools, called by the node daemon for a run in progress. Each run
 * reads its own branch over main and writes only to its own branch, and only while it is
 * the issue's current fix. Writes come from here and nowhere else: no agent touches the
 * database.
 */
@Controller('kg/runs/:runId')
@SkipApiToken()
@UseGuards(NodeSecretGuard, new RateLimitGuard(600, 60_000))
export class RunKnowledgeController {
  constructor(
    private readonly knowledge: KnowledgeService,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Post('search')
  @HttpCode(200)
  async search(
    @Param('runId', { schema: idSchema }) runId: string,
    @Body({ schema: z.strictObject({ query: kgSearchSchema.shape.query }) })
    body: { query: string },
  ) {
    await this.current(runId);
    return asHttp(this.knowledge.search(runBranch(runId), body.query));
  }

  @Get('node')
  async node(
    @Param('runId', { schema: idSchema }) runId: string,
    @Query('key', { schema: kgKeySchema }) key: string,
  ) {
    await this.current(runId);
    return asHttp(this.knowledge.node(runBranch(runId), key));
  }

  @Post('nodes')
  async writeNode(
    @Param('runId', { schema: idSchema }) runId: string,
    @Body({ schema: kgWriteNodeSchema }) body: KgWriteNode,
  ) {
    const author = await this.current(runId);
    return asHttp(this.knowledge.writeNode(runBranch(runId), body, { runId, author }));
  }

  @Post('edges')
  async writeEdge(
    @Param('runId', { schema: idSchema }) runId: string,
    @Body({ schema: kgWriteEdgeSchema }) body: KgWriteEdge,
  ) {
    const author = await this.current(runId);
    return asHttp(this.knowledge.writeEdge(runBranch(runId), body, { runId, author }));
  }

  /** Called after GitHub accepted a push of the run's branch, with the commit it made. */
  @Post('commits')
  @HttpCode(200)
  async commit(
    @Param('runId', { schema: idSchema }) runId: string,
    @Body({ schema: kgCommitSchema }) body: { sha: string },
  ) {
    await this.issueOf(runId);
    return { stamped: await this.knowledge.stampCommit(runBranch(runId), body.sha) };
  }

  /** The run's author name, when it is an issue's current fix in progress. */
  private async current(runId: string): Promise<string> {
    const issue = await this.issueOf(runId);
    if (issue.status !== 'fixing') {
      throw new ForbiddenException(`run ${runId} is not in progress`);
    }
    return `agent:tier${issue.current_tier ?? '?'}`;
  }

  private async issueOf(runId: string) {
    const issue = await this.db
      .selectFrom('issues')
      .select(['id', 'status', 'current_tier'])
      .where('current_run_id', '=', runId)
      .executeTakeFirst();
    if (!issue) throw new ForbiddenException(`run ${runId} is no issue's current fix`);
    return issue;
  }
}
