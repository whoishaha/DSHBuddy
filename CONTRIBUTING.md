# Contributing to DSHBuddy

Thanks for helping improve DSHBuddy.

## Development

Requirements: Node.js 18 or newer and npm.

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Keep generated output out of commits. The `lib/` directory is built by CI and is intentionally ignored. Runtime data also stays outside the repository under `~/.petdex/` unless `DSHBUDDY_DATA_DIR` is set.

## Pull requests

1. Keep each pull request focused on one problem.
2. Explain the user-visible behavior and how it was tested.
3. Add or update tests when behavior or persisted data changes.
4. Never commit API keys, local runtime data, installed pets, or user conversations.

By contributing, you agree that your contribution is licensed under the repository's MIT License.
