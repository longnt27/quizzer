# Contributing to Quizzer

Thanks for helping improve Quizzer. Before opening a pull request:

1. Discuss large product, data-model, plugin-protocol, or security changes in an issue.
2. Create a focused branch from `develop` and keep unrelated changes out of the pull request. Fix branches use `fix/issue-<number>-<short-description>` and target `develop`.
3. Run `npm ci --legacy-peer-deps`, `npm run lint`, `npm test`, and `npm run build`.
4. Add tests for behavior changes and describe migration, privacy, accessibility, and recovery effects.
5. Never commit documents, API keys, tokens, `.quizzer-data`, `.quizzer-tools`, or signing material.

Contributions are accepted under the Apache License 2.0. By submitting a contribution, you certify that you have the right to do so under that license.

`develop` is the integration and default branch. `main` contains release commits only; maintainers promote a tested version through a release pull request from `develop` to `main` and squash-merge it as one release commit. Do not target feature or fix pull requests at `main`.

Please report security issues through the private process in [SECURITY.md](SECURITY.md), not a public issue.
