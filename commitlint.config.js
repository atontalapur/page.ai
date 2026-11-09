export default {
  extends: ['@commitlint/config-conventional'],
  // Dependabot's single-update group titles ("bump x from a to b in the <group> group
  // across 1 directory") run past the 100-character header limit.
  ignores: [(message) => /^(ci|chore)\(deps(-dev)?\): bump /.test(message)],
};
