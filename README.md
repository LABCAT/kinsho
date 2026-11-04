# Kinsho – The Gold General

<!-- TODO: add the hero image at docs/kinsho-hero.png -->
![Kinsho, the gold general (金将), guarding the king](docs/kinsho-hero.png)

Kinsho is an automated pull request reviewer, named for the gold general (金将) in shogi, which guards the king. Here, the king is the merge.

It reads a PR and posts one comment with a verdict: `BLOCKED`, `NEEDS_EVIDENCE` or `PASS`. Findings cite `file:line` with a suggested fix, and the commands or URLs they rest on. It only ever writes its comment and its labels. It never approves, merges or pushes, and it is not meant to be a required check.

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
| `run_commands` | `true` | Let the reviewer run `test_command` and `check_command` in a sandbox; `false` skips them |
| `test_command` | none | Test command, named in the checklist and run when `run_commands` is on. Include any install it needs |
| `check_command` | none | Lint/check/build command, same rules as `test_command` |
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

The app needs write access to issues and pull requests, and read access to contents, actions and checks, and must be installed on your repo. The model step gets a separate token with read access only; the comment and labels are written by later steps with the write token.

## Tools

The reviewer has no general shell. Beyond reading files it can:

- Make read-only GitHub calls: `gh api` GET requests to `repos/...`, `gh pr view|diff|checks` and `gh run view` (including `--log-failed`). Every argument is checked; `-X` other than GET, `-f`, `-F`, `--field`, `--raw-field`, `--input` and everything else are refused.
- Fetch official documentation: docs.github.com, developers.cloudflare.com, neon.tech/docs, orm.drizzle.team, svelte.dev and opencode.ai/docs. OpenCode's own permission list can't restrict `webfetch` by domain, so Kinsho's guard plugin enforces this list. A fetch follows redirects, so an allowed page that redirects elsewhere is not caught.
- Run your `test_command` and `check_command` on the PR head. They run as a separate user with an empty environment, so they can't read the API key or the GitHub token. The sandbox starts from a clean checkout with nothing installed, so put the install in the command, for example `pnpm install --frozen-lockfile && pnpm test`. Set `run_commands: false` if they are slow. The sandbox needs a GitHub-hosted Linux runner with `sudo`.

Two locks apply to every bash call: the agent file's permission list, and the guard plugin, which accepts only the two Kinsho scripts with plain or single-quoted arguments. A planted instruction can't widen either list, and a comment containing the API key or a GitHub token is not posted. It can still try to sway the verdict text, as with any model review.

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
