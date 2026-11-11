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
    uses: LABCAT/kinsho/.github/workflows/review.yml@v0.3.0
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

Both are optional. Unset (or empty), the review runs `opencode-go/gpt-6-luna` at `high` (with `llm_base_url` set there is no default model, so `KINSHO_MODEL` must be set). GitHub resolves `vars` from the calling repo, so each project sets its own. A model or effort the backend doesn't offer fails the run with a message and posts nothing, so it can never count as a `PASS` or set `pr-ready`. The run log and the review comment state the model and effort used.

If you name the file something else, add it to `protected_paths`, so a PR can't weaken its own reviewer.

## Inputs

All optional.

| Input | Default | Purpose |
|-------|---------|---------|
| `model` | `opencode-go/gpt-6-luna` | Model the review runs on; pass `vars.KINSHO_MODEL` |
| `effort` | `high` | Reasoning effort (the model's variant); pass `vars.KINSHO_EFFORT` |
| `llm_base_url` | none | OpenAI-compatible endpoint, for example `https://api.deeprelay.ai/v1`. When set, `model` is that endpoint's model id and `LLM_API_KEY` is used; see [Bring your own endpoint](#bring-your-own-endpoint) |
| `run_commands` | `true` | Let the reviewer run `test_command` and `check_command` in a sandbox; `false` skips them |
| `test_command` | none | Test command, named in the checklist and run when `run_commands` is on. Include any install it needs |
| `check_command` | none | Lint/check/build command, same rules as `test_command` |
| `project_context` | none | One sentence describing your repo |
| `review_rules` | none | Your checklist items, numbered from `2.` |
| `protected_paths` | none | Extra path regexes, one per line; a PR touching one is `BLOCKED` for human review |
| `evidence_checks` | none | Check-run names that count as runtime evidence, one per line; see [Evidence](#evidence) |
| `evidence_wait_minutes` | `20` | How long to wait for `evidence_checks` to finish before reviewing |
| `routing_marker` | none | HTML comment added to fix-requesting reviews of routed PRs; empty turns routing off |
| `route_branch_prefix` | none | Route PRs from branches with this prefix |
| `route_body_marker` | none | Route PRs whose body contains this text |

## Bring your own endpoint

By default Kinsho runs on an OpenCode Go plan. Without one, point it at any OpenAI-compatible endpoint with `llm_base_url`. Kinsho then configures opencode with a custom provider (`@ai-sdk/openai-compatible`), reads the key from the `LLM_API_KEY` secret, and runs the model named in `model` against it. `OPENCODE_API_KEY` is not needed, and unset `llm_base_url` behaves exactly as before.

With `llm_base_url` set, `model` is the id the endpoint serves, not `provider/model`. The `opencode-go` default does not apply, so `model` must be set. The endpoint is checked first: its `/models` list must contain the model and accept the key, otherwise the run fails with a message and posts nothing. An endpoint with no `/models` route is not pre-checked, and a wrong id then fails the run itself. Either way a bad model is never a `PASS`. The URL must be `https`, and it must not carry credentials.

Example with DeepRelay:

```yaml
jobs:
  review:
    uses: LABCAT/kinsho/.github/workflows/review.yml@v0.3.0
    with:
      llm_base_url: https://api.deeprelay.ai/v1
      model: ${{ vars.KINSHO_MODEL }}   # a model id from https://api.deeprelay.ai/v1/models
      effort: ${{ vars.KINSHO_EFFORT }}
    secrets:
      LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
      KINSHO_APP_ID: ${{ secrets.KINSHO_APP_ID }}
      KINSHO_APP_PRIVATE_KEY: ${{ secrets.KINSHO_APP_PRIVATE_KEY }}
```

Any other OpenAI-compatible service works the same way, whether a hosted provider, a gateway or a self-hosted server such as vLLM. Give its `/v1` base URL, the model id it lists, and a key:

```yaml
    with:
      llm_base_url: https://llm.example.com/v1
      model: my-review-model
      effort: high
    secrets:
      LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
      KINSHO_APP_ID: ${{ secrets.KINSHO_APP_ID }}
      KINSHO_APP_PRIVATE_KEY: ${{ secrets.KINSHO_APP_PRIVATE_KEY }}
```

`effort` is sent as the request's `reasoningEffort` and accepts `low`, `medium`, `high`, `xhigh` or `max`, so use a level your model understands. The key and URL are passed to opencode through the environment and never written to the config or the logs. The run log and the review comment state the model, the effort and the provider host (the host only).

## Secrets

`KINSHO_APP_ID` and `KINSHO_APP_PRIVATE_KEY` are always required. The model key depends on the backend. The run fails and names any required secret that is unset.

| Secret | Required | Purpose |
|--------|----------|---------|
| `OPENCODE_API_KEY` | when `llm_base_url` is unset | API key for the review model on OpenCode Go |
| `LLM_API_KEY` | when `llm_base_url` is set | API key for the OpenAI-compatible endpoint |
| `KINSHO_APP_ID` | always | ID of the GitHub App the review posts as |
| `KINSHO_APP_PRIVATE_KEY` | always | Private key of that app |

The app needs write access to issues and pull requests, and read access to contents, actions and checks, and must be installed on your repo. The model step gets a separate token with read access only; the comment and labels are written by later steps with the write token. Without checks access the review still runs, but CI evidence reads as unavailable (see [Evidence](#evidence)). To make the app, see below.

## Create your GitHub App

Kinsho posts its comment and labels as a GitHub App, so create one:

1. Go to **Settings → Developer settings → GitHub Apps → New GitHub App** (on your account or organization).
2. Give it a name such as `kinsho-<your-org>`, any homepage URL, and untick **Webhook → Active**. It needs no webhook.
3. Under **Repository permissions** set:
   - **Contents**: Read-only
   - **Issues**: Read and write
   - **Pull requests**: Read and write
   - Optionally **Actions** and **Checks**: Read-only, so CI evidence can be read (see [Evidence](#evidence)). **Metadata** read is added automatically.
4. Choose **Only on this account**, then **Create GitHub App**.
5. On the app page, note the **App ID**, then under **Private keys** click **Generate a private key** and keep the downloaded `.pem`.
6. Choose **Install App** and install it on the repository (or repositories) that run Kinsho.
7. In each repository, under **Settings → Secrets and variables → Actions**, add the secrets:

```bash
gh secret set KINSHO_APP_ID --body "<the App ID>"
gh secret set KINSHO_APP_PRIVATE_KEY < path/to/the-key.pem
```

Delete the local `.pem` afterwards. Never commit it or paste it into an issue or a log.

## Tools

The reviewer has no general shell. Beyond reading files it can:

- Make read-only GitHub calls: `gh api` GET requests to `repos/...`, `gh pr view|diff|checks` and `gh run view` (including `--log-failed`). Every argument is checked; `-X` other than GET, `-f`, `-F`, `--field`, `--raw-field`, `--input` and everything else are refused.
- Fetch official documentation: docs.github.com, developers.cloudflare.com, neon.tech/docs, orm.drizzle.team, svelte.dev and opencode.ai/docs. OpenCode's own permission list can't restrict `webfetch` by domain, so Kinsho's guard plugin enforces this list. A fetch follows redirects, so an allowed page that redirects elsewhere is not caught.
- Run your `test_command` and `check_command` on the PR head. They run as a separate user with an empty environment, so they can't read the API key or the GitHub token. The sandbox starts from a clean checkout with nothing installed, so put the install in the command, for example `pnpm install --frozen-lockfile && pnpm test`. Set `run_commands: false` if they are slow. The sandbox needs a GitHub-hosted Linux runner with `sudo`.

Two locks apply to every bash call: the agent file's permission list, and the guard plugin, which accepts only the two Kinsho scripts with plain or single-quoted arguments. A planted instruction can't widen either list, and a comment containing the API key or a GitHub token is not posted. It can still try to sway the verdict text, as with any model review.

## Evidence

What the PR author says is not evidence. "Verified", "works", "tested locally" or "`/admin` redirects to login" in the body, commits or comments never counts toward `PASS`. The only evidence is the check runs CI recorded on the PR's head SHA, which Kinsho reads before the review. A check counts only when it completed with `success`.

A runtime change (app code, config, auth/access control, dependencies, migrations, CI) needs a check that ran the app, such as a browser or e2e smoke test. Typecheck, lint, unit tests and a build don't. Without one the verdict is `NEEDS_EVIDENCE`, naming the missing check. Docs-only, test-only and comment-only changes are exempt.

Name your runtime checks to make this a hard rule instead of the model's judgement:

```yaml
    with:
      evidence_checks: |
        e2e / admin smoke
```

Use the check-run name as the PR's checks list shows it. Kinsho waits up to `evidence_wait_minutes` for them to finish, then, on a runtime change, turns any `PASS` into `NEEDS_EVIDENCE` unless each one is green on the head. It also does that when check runs can't be read, or when the PR edits `.github/workflows/` or `.github/actions/` (a PR can't vouch for itself with checks it redefines). Re-run with `/oc` once the checks pass.

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

A bump PR edits the caller workflow. With the file named `.github/workflows/opencode-review.yml`, Kinsho blocks it for human review without a model run. GitHub doesn't give Dependabot PRs your Actions secrets, so unless you also add the required secrets as Dependabot secrets, a bump PR's review fails on the missing-secrets error. A person reviews and merges the bump either way.

## Development

The logic is plain Node with no dependencies:

```bash
node --test ".github/scripts/*.test.mjs"
```
