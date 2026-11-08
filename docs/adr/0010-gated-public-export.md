# 0010: The public repository is a gated export

## Status

Accepted; implemented by the export process.

## Context

Planning records and operator material share a development repository with code intended for contributors. Publishing the whole tree would publish both.

## Decision

Generate the public repository from the private planning repository with `public/export.sh`. `public/allow.txt` selects paths from origin branches; `public/deny.txt` removes excluded paths. The gate checks forbidden content, email addresses and secrets before committing. Author changes in the private repository and review the exported result.

## Consequences

An added file stays private until its path is allowed. Deny rules and content checks still apply to allowed paths. A dry run uses a fresh output repository; a branch review uses `EXPORT_MAIN_REF`. Publishing is a separate step: the script prints a push command and never pushes. These ADRs are allowed; planning remains excluded.
