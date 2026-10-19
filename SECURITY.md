# Security policy

## Reporting a vulnerability

This repository and its issues are public. Do not put vulnerability details,
credentials, private keys, personal data or sensitive deployment information in
public issues, pull requests or discussions.

Report vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/timlaing/opencode-devcontainers/security/advisories/new).
This route is available to first-time reporters and sends the report privately to
repository maintainers. Do not use a public issue as a substitute.

No response-time guarantee or older-release support commitment is offered.
Security fixes target the current development branch and the latest releases;
upgrade when a fix is published.

## Plugin boundaries

The plugin creates git clones and worktrees under `~/.local/share/opencode`,
starts devcontainers, allocates ports from a configurable range, and copies
gitignored files (such as `.env`) from your main repository into each workspace.
Treat those directories as sensitive as the original repository, and review what
your `.gitignore` marks as secret before enabling automatic copying. Commands
prefixed with `HOST:` execute on the host rather than inside the container; the
plugin does not sandbox the host from such commands.

Dependency audits and updates complement review; passing audits are not a claim
that the code has no vulnerabilities.
