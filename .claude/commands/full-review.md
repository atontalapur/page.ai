---
description: Run /code-review high, then /security-review, on the current branch
---

Run a full review of the current branch:

1. Invoke the `code-review` skill with args `high $ARGUMENTS`.
2. Invoke the `security-review` skill.
3. Report both sets of findings. Don't change any code until I pick which findings to act on.
