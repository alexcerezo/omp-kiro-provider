# omp-kiro-provider

[![npm version](https://img.shields.io/npm/v/omp-kiro-provider.svg)](https://www.npmjs.com/package/omp-kiro-provider)
[![npm downloads](https://img.shields.io/npm/dm/omp-kiro-provider.svg)](https://www.npmjs.com/package/omp-kiro-provider)
[![license](https://img.shields.io/npm/l/omp-kiro-provider.svg)](LICENSE)

Unofficial [Kiro](https://kiro.dev) provider plugin for [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi). Use your Kiro / Amazon Q subscription from omp: OAuth login, live model discovery, streaming with thinking and tools, and usage in `omp stats`.

> Not affiliated with Amazon, AWS, or Kiro. You need a Kiro account; check [Kiro pricing](https://kiro.dev) for what your plan covers.

## Install

```bash
omp plugin install omp-kiro-provider
```

Then restart omp (or start a new session) and log in:

```text
/login kiro
```

If Kiro IDE or `kiro-cli` is already signed in on this machine, the plugin reuses those credentials and skips the browser flow.

## Login methods

`/login kiro` tries, in order:

1. **Kiro IDE** token (`~/.aws/sso/cache/kiro-auth-token.json`)
2. **kiro-cli** local credentials
3. Interactive device-code login:
   - Enterprise / **IAM Identity Center**
   - AWS **Builder ID**
   - **GitHub**
   - **Google**

Enterprise IdC tokens are routed to Amazon Q (`q.<region>.amazonaws.com`). Builder ID / social tokens go to Kiro runtime (`runtime.<region>.kiro.dev`). The plugin keeps your SSO region (including `eu-central-1`) instead of rewriting it to `us-east-1`.

## Use a model

```text
/model kiro/auto
```

The catalog is fetched live from Kiro (`ListAvailableModels`), so the list matches your account and region. Typical ids look like:

```text
kiro/auto
kiro/claude-sonnet-4.6
kiro/claude-opus-4.8
kiro/claude-haiku-4.5
```

Thinking / reasoning effort is enabled when Kiro advertises it for that model. Images are accepted when the model lists `IMAGE` as an input type.

## What this plugin does

- Registers the `kiro` provider with omp (`streamSimple`, OAuth, dynamic models).
- Discovers models per credential instead of shipping a hardcoded allowlist.
- Streams Kiro's binary event protocol: text, thinking, tool calls, stop reasons.
- Reports usage to `omp stats`: estimated tokens when Kiro only sends a context-usage percentage, API-equivalent cost for Claude models from omp's catalog, and Kiro credit limits via `GetUsageLimits`.
- Identifies as the current stable **Kiro IDE** User-Agent (read from Kiro's public metadata, cached 6 hours) so requests are not rejected with “This version of Kiro is no longer supported”. Override with `KIRO_IDE_VERSION` if needed.

## Requirements

- [omp](https://github.com/can1357/oh-my-pi) with Bun ≥ 1.3.14
- A Kiro account (Builder ID, IAM Identity Center, GitHub, or Google)

Peer packages (normally provided by omp):

- `@oh-my-pi/pi-ai`
- `@oh-my-pi/pi-catalog`
- `@oh-my-pi/pi-coding-agent`
- `@oh-my-pi/pi-utils`

## Update

```bash
omp plugin update omp-kiro-provider
```

## Environment

| Variable | Effect |
| --- | --- |
| `KIRO_IDE_VERSION` | Force the Kiro IDE version in the User-Agent |
| `KIRO_CLI_VERSION` | Same as `KIRO_IDE_VERSION` (legacy alias) |

## Development

```bash
bun test
bun run check:types
```

Publishing to npm is automated: a GitHub Release whose tag matches `package.json` (for example `v2.0.10`) runs [`.github/workflows/publish.yml`](.github/workflows/publish.yml) with npm trusted publishing (OIDC). No npm token is stored in the repo.

## License

[MIT](LICENSE)
