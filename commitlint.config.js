const DEPENDABOT = new RegExp(
  String.raw`^(ci|chore)\(deps(-dev)?\): bump ` +
    String.raw`(the \S+ group( in \S+| across \d+ director(y|ies))? with \d+ updates?` +
    String.raw`|\S+ from \S+ to \S+( in \S+)?( in the \S+ group)?( across \d+ director(y|ies))?)$`,
);

export default {
  extends: ['@commitlint/config-conventional'],
  // Dependabot's single-update group titles ("bump x from a to b in the <group> group
  // across 1 directory") run past the 100-character header limit. Only its exact title
  // shapes are exempt, so a person's title that starts the same way is still linted.
  ignores: [(message) => DEPENDABOT.test(message.split('\n')[0])],
};
