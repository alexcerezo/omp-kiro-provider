# omp-kiro-provider

Kiro AI provider plugin for [omp](https://github.com/can1357/oh-my-pi): OAuth login, dynamic model discovery and streaming inference.

Install: `omp plugin install omp-kiro-provider` (or add the npm package to your omp config).

Source note: this repository was created from the tarball published on npm (0.1.9). Earlier git history was not available.

## Releases

Publishing to npm is automated: creating a GitHub Release whose tag matches the version in package.json (e.g. `v0.1.10`) runs .github/workflows/publish.yml. It uses npm trusted publishing (OIDC), so no token is stored in the repo.
