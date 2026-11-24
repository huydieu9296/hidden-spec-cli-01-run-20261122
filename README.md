# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![make.fun rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/huydieu9296/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![make.fun reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/huydieu9296/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` is a small, dependency-free patch CLI (Node 22, standard library only).
It reads a patch from a file or stdin and applies it to a directory tree,
atomically: a failed edit changes nothing, and the edits after it still run.

Supported patch formats (auto-detected, or forced with `--format=`):

- **unified diffs** — `diff --git` sections with `@@` hunks, including creates,
  deletes, renames and moves (`R <old> -> <new>` in the summary)
- **SEARCH/REPLACE blocks** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`
- **V4A patches** — `*** Begin Patch` with Add / Delete / Update File sections
  and `@@` anchors
- **JSON edits** — `create`, `str_replace` and `insert` objects, as one array
  or one object per line

Matching is tiered: exact lines first, then ignoring trailing whitespace,
then ignoring leading and trailing whitespace. `--strict` allows only exact
matches, and `--check` reports what would change without writing anything.

## Usage

```sh
node main.ts patch.diff          # apply a patch file
node main.ts - < patch.diff      # apply a patch from stdin
node main.ts --check patch.diff  # dry run
node main.ts --format=v4a fix.txt
```

Exit code is `0` when every edit applies, `1` when any edit fails, and `2`
for usage or parse errors. On success it prints one line per changed file
(`M`, `A`, `D` or `R old -> new`) and `ok: N file(s)`.

## Practice

`check.ts` runs the public practice set from the competition kit:

```sh
node check.ts ../hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json
# 100 of 100 passed: practice score 1000
```

## License

MIT
