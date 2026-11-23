import { describe, expect, it } from 'vitest';
import { pageMessage } from './message.ts';

describe('pageMessage', () => {
  it("links the issue's page in the UI", () => {
    const message = pageMessage({
      severity: 'high',
      class: 'database',
      title: 'Error: connect ECONNREFUSED',
      issueId: '3f2b9c1e-8a4d-4f6b-9c2e-1d7a5b8e4f01',
      dashboardUrl: 'https://page.example.com/',
    });
    expect(message).toBe(
      'high database: Error: connect ECONNREFUSED ' +
        'https://page.example.com/incidents/3f2b9c1e-8a4d-4f6b-9c2e-1d7a5b8e4f01',
    );
  });
});
