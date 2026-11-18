# Security policy

## Reporting a vulnerability

Please report security issues privately via [GitHub Security Advisories](https://github.com/alexcerezo/omp-kiro-provider/security/advisories/new). Do not open a public issue for credential leaks or exploitable bugs.

I aim to acknowledge reports within a few days.

## What this package does (and does not)

This plugin is a network client for Kiro / Amazon Q. It has **no install scripts**, **no production dependencies**, and is published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements).

### Network

Only used at runtime after you log in or stream, never at `npm install`:

- `https://oidc.<region>.amazonaws.com` — IAM Identity Center device-code login and refresh
- `https://prod.us-east-1.auth.desktop.kiro.dev` — Builder ID / GitHub / Google login and desktop refresh
- `https://q.<region>.amazonaws.com` — Amazon Q inference, model list, and usage (IdC tokens)
- `https://runtime.<region>.kiro.dev` — Kiro inference (desktop tokens)
- `https://management.<region>.kiro.dev` — model catalog (desktop tokens)
- `https://prod.download.desktop.kiro.dev` — public Kiro IDE version metadata (User-Agent)

`<region>` is `us-east-1` or `eu-central-1` (and SSO probe regions during IdC login).

### Filesystem (read, plus one cache write)

- **Read** `~/.aws/sso/cache/kiro-auth-token.json` (and the companion client file) to reuse a Kiro IDE session
- **Read** the kiro-cli SQLite DB (`~/.config/kiro-cli/data.sqlite3` on Linux; platform equivalents on macOS/Windows)
- **Write** `~/.config/kiro-provider/auth-meta.json` with the last API region / profile ARN (not tokens)

### Environment

- `KIRO_IDE_VERSION` / `KIRO_CLI_VERSION` — optional User-Agent override
- `LOCALAPPDATA` — Windows path to the kiro-cli DB
- `HOME` / homedir — locate the files above

The package does not spawn a shell, does not use `eval`, and does not send telemetry beyond the Kiro/AWS APIs required to log in and run models.
