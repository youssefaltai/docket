# Docket

See [SPEC.md](SPEC.md) and [README.md](README.md).

## Git

- Never work on `main`. Branch off it: `feature/<name>` or `bugfix/<name>`.
- When done, merge into `main` and delete the branch.
- Deploy only from `main`, after the merge. Back up the DB first (`./backup.sh`).
