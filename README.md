# auto-changelog-action

A composite GitHub Action that uses the [OpenAI API](https://platform.openai.com/docs/api-reference/chat) to automatically generate [Keep a Changelog](https://keepachangelog.com) entries when a pull request is opened or updated.

The action handles the full lifecycle:
1. **Bot-loop detection** — skips if the last commit was from the bot or manually touched a `CHANGELOG.md`
2. Detects which configured packages have source-file changes in the PR
3. If no source changes are found, clears stale `[Unreleased]` entries (e.g. after a code revert)
4. Fetches any linked issues (via closing keywords like `closes #123`) for richer AI context
5. Calls the OpenAI API with a filtered per-package diff
6. Writes the generated entries into each package's `[Unreleased]` section
7. Commits and pushes the updated changelogs back to the PR branch
8. Posts a PR comment with a preview of what was written (or cleared)

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **OpenAI API key (`ai-api-key`)** | An [OpenAI API key](https://platform.openai.com/api-keys), stored as a repository secret (e.g. `OPENAI_API_KEY`). Used only to call the OpenAI API — it does **not** need any GitHub permissions. |
| **GitHub token for checkout/push** | A separate token (a repo-scoped PAT, or the default `${{ secrets.GITHUB_TOKEN }}`) with `contents: write`, used by the checkout step so the action can push the changelog commit back to the PR branch. Use a real PAT instead of `GITHUB_TOKEN` if you need the pushed commit to trigger downstream workflows (e.g. required status checks) — commits pushed with the default `GITHUB_TOKEN` don't trigger other workflow runs. |
| **`## [Unreleased]` section** | Each package's `CHANGELOG.md` must already contain this header. |

---

## Usage

Add this workflow to your repository at `.github/workflows/changelog.yml`:

```yaml
name: Auto-Generate Changelog

on:
  pull_request:
    types: [opened, synchronize]
    branches:
      - main

permissions:
  contents: write
  pull-requests: write
  issues: read

jobs:
  changelog:
    # Skip forks — they cannot access repository secrets
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest

    steps:
      - name: Checkout PR branch
        uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.ref }}
          fetch-depth: 0
          # Use a PAT so the pushed commit triggers downstream workflows (e.g. required checks).
          # The default secrets.GITHUB_TOKEN also works, but pushed commits won't trigger other workflow runs.
          token: ${{ secrets.REPO_PAT }}

      - name: Generate changelog
        uses: vensas/auto-changelog-action@v1
        with:
          ai-api-key: ${{ secrets.OPENAI_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          pr-number: ${{ github.event.pull_request.number }}
          pr-title: ${{ github.event.pull_request.title }}
          pr-body: ${{ github.event.pull_request.body }}
          base-ref: ${{ github.event.pull_request.base.ref }}
          branch-ref: ${{ github.event.pull_request.head.ref }}
          project-context: 'Brief description of your project goes here.'
          packages: |
            [
              {
                "name": "frontend",
                "path": "src/frontend",
                "changelogFile": "CHANGELOG.md",
                "description": "React TypeScript frontend",
                "patterns": ["^src/frontend/"]
              },
              {
                "name": "api",
                "path": "src/api",
                "changelogFile": "CHANGELOG.md",
                "description": "Node.js REST API",
                "patterns": ["^src/api/"]
              }
            ]
```

The action commits, pushes, and posts the PR comment automatically. The checkout step is the only prerequisite the calling workflow needs to provide.

> **Note — omitting `branch-ref`:** if you leave out `branch-ref`, the action still generates and writes the changelog files but does not commit or push. This is useful when you want to handle the commit yourself or use a separate release step.

---

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `ai-api-key` | Yes | — | OpenAI API key |
| `github-token` | No | — | Token for fetching linked issue details and posting PR comments. If omitted, no comment is posted. |
| `pr-number` | Yes | — | Pull request number |
| `pr-title` | Yes | — | Pull request title |
| `pr-body` | No | `''` | Pull request body (used to detect closing-keyword issue references) |
| `base-ref` | Yes | — | Base branch name (e.g. `main`) |
| `packages` | Yes | — | JSON array of package configurations (see below) |
| `project-context` | No | `''` | Short project description added to the AI prompt |
| `model` | No | `gpt-5.6-terra` | OpenAI model identifier |
| `ai-api-url` | No | `https://api.openai.com/v1/chat/completions` | OpenAI-compatible chat completions endpoint URL |
| `max-diff-chars` | No | `8000` | Maximum characters from the per-package diff sent to the AI |
| `dry-run` | No | `false` | When `true`, generates entries and posts a preview comment without modifying any files |
| `branch-ref` | No | `''` | Branch to commit and push changelog changes back to. If empty, files are written but not committed. |
| `commit-message` | No | `chore: update changelogs with AI-generated entries` | Commit message for generated changelog entries |

---

## Outputs

| Output | Description |
|---|---|
| `has-changes` | `"true"` if any `CHANGELOG.md` files were modified on disk |
| `updates` | Comma-separated summary, e.g. `"frontend: minor, api: patch"` |
| `generated-entry` | Raw markdown of the generated `[Unreleased]` section(s), set even in dry-run mode |
| `skipped` | `"true"` if the action was skipped due to bot-loop detection |
| `committed` | `"true"` if a changelog commit was successfully pushed |
| `cleared` | `"true"` if `[Unreleased]` sections were cleared because no source changes were found |
| `error-message` | Error message if generation failed (empty on success) |

---

## Packages configuration

The `packages` input accepts a JSON array. Each entry:

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Short identifier (used in logs and the `updates` output) |
| `path` | `string` | Relative path to the package root (where `changelogFile` lives) |
| `changelogFile` | `string` | Changelog filename, usually `CHANGELOG.md` |
| `description` | `string` | One-line description passed to the AI for context |
| `patterns` | `string[]` | Regex patterns matching file paths that belong to this package |

### Example — monorepo with three packages

```json
[
  {
    "name": "frontend",
    "path": "src/frontend",
    "changelogFile": "CHANGELOG.md",
    "description": "React 19 + TypeScript frontend with Material-UI",
    "patterns": ["^src/frontend/"]
  },
  {
    "name": "backend",
    "path": "src/backend",
    "changelogFile": "CHANGELOG.md",
    "description": "ASP.NET Core 9 backend API with EF Core",
    "patterns": ["^src/backend/"]
  },
  {
    "name": "app",
    "path": "src/app",
    "changelogFile": "CHANGELOG.md",
    "description": ".NET MAUI 9 cross-platform mobile app",
    "patterns": ["^src/app/"]
  }
]
```

### Example — single-package repo

```json
[
  {
    "name": "main",
    "path": ".",
    "changelogFile": "CHANGELOG.md",
    "description": "Node.js CLI tool",
    "patterns": ["^src/", "^lib/"]
  }
]
```

---

## CHANGELOG.md format

Each changelog file must contain an `## [Unreleased]` header. The action **replaces** the entire `[Unreleased]` section on every run. A minimal starting file:

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [1.0.0] - 2025-01-01
### Added
- Initial release
```

A `<!-- Version: minor -->` comment is inserted automatically by the action to record the intended version bump for use by the [auto-version-bump](https://github.com/vensas/auto-version-bump-action) action.

---

## How loop prevention works

Bot-loop detection is built into the action as its first step. It checks two conditions before doing anything else:

1. **Last commit author** — if it is `github-actions[bot]`, the changelog was just updated by the action; skip entirely.
2. **Last commit files** — if any `CHANGELOG.md` was touched, the developer is manually editing entries; skip to avoid overwriting their changes.

When skipped, the `skipped` output is set to `"true"` and all subsequent steps (Node.js setup, generation, commit, comments) are bypassed.
