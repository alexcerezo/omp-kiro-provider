# Contributing

## Setup

```bash
bun install
bun test
```

Requires Bun ≥ 1.3.14.

## Pull requests

- Keep changes scoped; add or update tests next to the code (`src/*.test.ts`).
- Do not commit secrets, Kiro tokens, or `~/.aws/sso` dumps.
- CI runs `bun test` on every push and pull request.

## Releases

1. Bump `version` in `package.json` and add a [CHANGELOG.md](CHANGELOG.md) entry.
2. Merge to `main`.
3. Create a GitHub Release whose tag is `v` plus that version (for example `v2.0.11`).
4. [`.github/workflows/publish.yml`](.github/workflows/publish.yml) runs tests and `npm publish --provenance`.
