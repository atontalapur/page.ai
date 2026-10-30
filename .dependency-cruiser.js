// Import boundaries between workspaces. Each `to` pattern matches both the resolved
// path (apps/x/...) and the bare package name (@page/x), so a rule holds even before
// the target package declares `exports`.
const apps = '^(apps/|@page/(orchestrator|node|ui|demo-app)(/|$))';
const zod = '((^|/)node_modules/zod/|^zod(/|$))';
const tests = '\\.test\\.tsx?$';

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: 'packages-not-to-apps',
      comment: 'Packages are shared building blocks and must never import an app.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: apps },
    },
    {
      name: 'contracts-only-zod',
      comment: 'Contracts are pure schemas: zod and their own files only.',
      severity: 'error',
      from: { path: '^packages/contracts/src/', pathNot: tests },
      to: { pathNot: `^packages/contracts/src/|${zod}` },
    },
    {
      name: 'agent-io-via-toolkit',
      comment:
        'The agent reaches the outside world only through toolkit and model-client ' +
        '(contracts and zod are allowed for shared types).',
      severity: 'error',
      from: { path: '^packages/agent/src/', pathNot: tests },
      to: {
        pathNot:
          '^(packages/(agent|toolkit|model-client|contracts)/|@page/(toolkit|model-client|contracts)(/|$))' +
          `|${zod}`,
      },
    },
    {
      name: 'apps-not-to-other-apps',
      comment: 'Apps talk over HTTP/queues; share types via contracts.',
      severity: 'error',
      from: { path: '^apps/([^/]+)/' },
      to: { path: apps, pathNot: '^(apps/$1/|@page/$1(/|$))' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Count `import type` too, so types also cross boundaries only via contracts.
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'types', 'node', 'default'],
    },
  },
};
