# Kinsho – The Gold General

<!-- TODO: add the hero image at docs/kinsho-hero.png -->
![Kinsho, the gold general (金将), guarding the king](docs/kinsho-hero.png)

Kinsho is an automated pull request reviewer, named for the gold general (金将) in shogi, which guards the king. Here, the king is the merge.

It reads a PR and posts one comment with a verdict: `BLOCKED`, `NEEDS_EVIDENCE` or `PASS`. Findings cite `file:line` with a suggested fix. It only ever writes its comment and its labels. It never approves, merges or pushes, and it is not meant to be a required check.

## Quick start

Add `.github/workflows/opencode-review.yml` to your repo:

```yaml
name: opencode-review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  review:
    uses: LABCAT/kinsho/.github/workflows/review.yml@v0.1.0
    with:
      test_command: npm test
      check_command: npm run lint
      model: ${{ vars.KINSHO_MODEL }}
      effort: ${{ vars.KINSHO_EFFORT }}
    secrets:
      OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
      KINSHO_APP_ID: ${{ secrets.KINSHO_APP_ID }}
      KINSHO_APP_PRIVATE_KEY: ${{ secrets.KINSHO_APP_PRIVATE_KEY }}
```

Comment `/oc` on a PR to re-run the review (needs write access). Draft PRs and PRs from forks are skipped.

## Model and effort

Switch them with repository variables, no PR needed:

```bash
gh variable set KINSHO_MODEL --body opencode-go/gpt-6-luna
gh variable set KINSHO_EFFORT --body high
```

Both are optional. Unset (or empty), the review runs `opencode-go/gpt-6-luna` at `high`. GitHub resolves `vars` from the calling repo, so each project sets its own. A model or effort the backend doesn't offer fails the run with a message and posts nothing, so it can never count as a `PASS` or set `pr-ready`. The run log and the review comment state the model and effort used.

If you name the file something else, add it to `protected_paths`, so a PR can't weaken its own reviewer.

## Inputs

All optional.

| Input | Default | Purpose |
|-------|---------|---------|
| `model` | `opencode-go/gpt-6-luna` | Model the review runs on; pass `vars.KINSHO_MODEL` |
| `effort` | `high` | Reasoning effort (the model's variant); pass `vars.KINSHO_EFFORT` |
| `test_command` | none | Test command named in the checklist; Kinsho never runs it |
| `check_command` | none | Lint/check/build command named in the checklist; Kinsho never runs it |
| `project_context` | none | One sentence describing your repo |
| `review_rules` | none | Your checklist items, numbered from `2.` |
| `protected_paths` | none | Extra path regexes, one per line; a PR touching one is `BLOCKED` for human review |
| `routing_marker` | none | HTML comment added to fix-requesting reviews of routed PRs; empty turns routing off |
| `route_branch_prefix` | none | Route PRs from branches with this prefix |
| `route_body_marker` | none | Route PRs whose body contains this text |

## Secrets

All required. The run fails and names any that are unset.

| Secret | Purpose |
|--------|---------|
| `OPENCODE_API_KEY` | API key for the review model |
| `KINSHO_APP_ID` | ID of the GitHub App the review posts as |
| `KINSHO_APP_PRIVATE_KEY` | Private key of that app |

The app needs read access to contents and write access to issues and pull requests, and must be installed on your repo.

## Labels

Kinsho creates these if they're missing.

| Label | Meaning |
|-------|---------|
| `pr-ready` | `PASS` on the current head; removed when the head changes |
| `review:blocked` | Verdict `BLOCKED` |
| `review:needs-evidence` | Verdict `NEEDS_EVIDENCE` |
| `review:automation-failed` | The model backend failed; not a verdict |

A PR that changes the reviewer's own files, or anything in `protected_paths`, gets `BLOCKED` without a model run: a person has to review it.

## Versioning

Releases are semver tags. There is no moving major tag, so pin an exact version and let Dependabot open the bumps:

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

A bump PR edits the caller workflow. With the file named `.github/workflows/opencode-review.yml`, Kinsho blocks it for human review without a model run. GitHub doesn't give Dependabot PRs your Actions secrets, so unless you also add the three secrets as Dependabot secrets, a bump PR's review fails on the missing-secrets error. A person reviews and merges the bump either way.

## Development

The logic is plain Node with no dependencies:

```bash
node --test ".github/scripts/*.test.mjs"
```
