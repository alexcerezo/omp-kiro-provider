# Changelog

## 2.0.11

- Publish only runtime sources (no tests, no lockfile) and declare `files` / `type: module`.
- Add CI, Dependabot, a security policy, and npm provenance in `publishConfig`.
- Document network, filesystem, and environment access.

## 2.0.10

- README, keywords, and package description for npm / GitHub discovery.

## 2.0.9

- Rename the custom API id to `kiro-provider-api` to avoid colliding with omp built-ins.

## 2.0.8

- Honor stream options omp passes into model commands.

## 2.0.7

- Identify as Kiro IDE so the version gate accepts requests.

## 2.0.6

- Resolve the advertised Kiro version from public metadata.

## 2.0.5

- Bump the advertised Kiro CLI version (400 unsupported-version).

## 2.0.4

- API-equivalent cost in `omp stats` for Claude models.

## 2.0.3

- Estimate token usage from Kiro's context-usage percentage.

## 2.0.2

- Keep IdC `authMethod` and region; stop desktop refresh from rewriting `eu-central-1` to `us-east-1`.
