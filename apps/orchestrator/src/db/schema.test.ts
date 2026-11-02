import { BUG_CLASSES, ISSUE_STATUSES, SEVERITIES, type IssueStatus } from '@page/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { IssuesService } from '../issues/issues.service.ts';
import { isTerminal } from '../issues/transitions.ts';
import { createTestDeps } from './test-utils.ts';

// migrations/001_issues.sql copies these lists from @page/contracts into CHECK constraints and
// the issues_open_fingerprint predicate. These tests fail when the two drift apart.

const deps = await createTestDeps();
afterAll(() => deps.close());
const service = new IssuesService(deps.db, deps.fixJobs);

let n = 0;
const insert = (values: { status?: IssueStatus; class?: string; severity?: string }) =>
  deps.db
    .insertInto('issues')
    .values({ fingerprint: `schema-${++n}`, title: 'x', ...values } as never)
    .returning('fingerprint')
    .executeTakeFirstOrThrow();

describe('issues table matches @page/contracts', () => {
  it.each(ISSUE_STATUSES)('accepts status %s', async (status) => {
    await expect(insert({ status })).resolves.toBeDefined();
  });

  it.each(BUG_CLASSES)('accepts class %s', async (cls) => {
    await expect(insert({ class: cls })).resolves.toBeDefined();
  });

  it.each(SEVERITIES)('accepts severity %s', async (severity) => {
    await expect(insert({ severity })).resolves.toBeDefined();
  });

  it('rejects values outside the contracts', async () => {
    await expect(insert({ status: 'done' as IssueStatus })).rejects.toThrow();
    await expect(insert({ class: 'backend' })).rejects.toThrow();
    await expect(insert({ severity: 'urgent' })).rejects.toThrow();
  });

  it.each(ISSUE_STATUSES)('counts a repeat only while the issue is open (%s)', async (status) => {
    const { fingerprint } = await insert({ status });
    const again = await service.report({ fingerprint, title: 'x' });
    expect(again.created).toBe(isTerminal(status));
  });
});
