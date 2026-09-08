# Releasing Quizzer

Quizzer beta releases are built for six operating-system and architecture targets, assembled into one Ed25519-signed manifest, and published only after an explicit maintainer approval. Native Apple notarization and Windows publisher signing are optional until the project can justify their cost. `develop` is the integration branch; `main` contains release commits only.

## Required GitHub configuration

Create a GitHub Actions environment named `release`, restrict deployments to protected tags matching `v*`, and require an appropriate maintainer approval. The manifest-signing values below are required and fail closed when absent or inconsistent.

### Secrets

| Name | Purpose |
| --- | --- |
| `QUIZZER_RELEASE_PRIVATE_KEY` | Base64 PKCS#8 DER Ed25519 private key used to sign the canonical release manifest |

### Variables

| Name | Required value |
| --- | --- |
| `QUIZZER_RELEASE_PUBLIC_KEY_ID` | Stable identifier for the public half of the manifest-signing key |
| `QUIZZER_RELEASE_PUBLIC_KEY` | Base64-encoded raw Ed25519 public key embedded in the landing page |

The public release key and key ID embedded by the application and landing page must match the private signing key before the release candidate is tagged. `npm run release:trust` enforces that relationship. The public key is intentionally committed; never commit private keys, passwords, or temporary signing files.

### Optional native signing

Leave `QUIZZER_MACOS_SIGNING_ENABLED` and `QUIZZER_WINDOWS_SIGNING_ENABLED` unset for manifest-signed, native-unsigned beta builds. Users are warned during installation. To enable native platform trust later, set the applicable variable to `true` and configure its values:

| Name | Purpose |
| --- | --- |
| `MACOS_CERTIFICATE` | Base64 PKCS#12 Apple Developer ID Application certificate |
| `MACOS_CERTIFICATE_PASSWORD` | Password for the application certificate |
| `MACOS_INSTALLER_CERTIFICATE` | Base64 PKCS#12 Apple Developer ID Installer certificate |
| `MACOS_INSTALLER_CERTIFICATE_PASSWORD` | Password for the installer certificate |
| `APPLE_IDENTITY` | Exact Developer ID Application signing identity |
| `APPLE_INSTALLER_IDENTITY` | Exact Developer ID Installer signing identity |
| `APPLE_ID` | Apple account used by `notarytool` |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password used by `notarytool` |
| `APPLE_TEAM_ID` | Expected Apple developer team ID |
| `WINDOWS_CERTIFICATE` | Base64 PKCS#12 Authenticode certificate |
| `WINDOWS_CERTIFICATE_PASSWORD` | Password for the Windows certificate |
| `QUIZZER_WINDOWS_CERTIFICATE_SHA256` | Upper- or lowercase 64-character SHA-256 fingerprint of the Windows signing certificate |

New publicly trusted Windows keys are normally HSM-backed and non-exportable. When native Windows signing is adopted, replace the legacy PKCS#12 import with the selected CA or managed signing service's cloud/HSM integration.

## Prepare a beta

1. Start from a clean, up-to-date `develop` branch whose required checks pass. Issue branches merge into `develop`, never directly into `main`.
2. Set the intended prerelease version, such as `1.0.0-beta.1`, in both `package.json` and `package-lock.json`. The new version must be greater than the version on `main`.
3. Run the local release gates:

   ```sh
   npm ci
   npm audit --omit=dev --audit-level=high
   npm run license:check
   npm run lint
   npm run test:coverage
   npm run eval:rag
   npm run build
   npm run test:e2e
   npm run test:e2e:cost
   (cd landing && npm ci && npm run lint && npm run build && npm run test:e2e)
   ```

4. Complete clean-machine install, update, rollback, and recovery checks for the release candidate. Record the results outside the repository together with the artifact checksums.
5. Open a release pull request from `develop` to `main`, verify its required checks, and squash-merge it as one release commit. Never push a release commit or tag directly.

The `Release from main` workflow validates the exact pushed commit, confirms the package and lockfile versions match and increased, and creates the immutable `v<version>` tag. Because GitHub does not recursively start workflows for tags pushed by `GITHUB_TOKEN`, the bridge explicitly dispatches `release.yml` with the matching beta or stable channel and `publish=true`. It reuses an existing tag only when it points to the exact commit, skips an already published release or an active run, and leaves failed runs safe to retry. The dispatched workflow verifies source, tests the application and landing page, builds all six desktop and CLI targets, verifies Electron fuses, generates SBOMs and provenance, signs the release manifest, and publishes only after approval of the protected `release` environment. Native signing and notarization run only when their explicit enable variables are set.

## Publish

1. Inspect every job and download the `signed-release-<tag>` workflow artifact.
2. Verify that the bundle contains the expected desktop and CLI targets, `install.sh`, `install.ps1`, both SBOMs, the canonical manifest, and its detached signature.
3. Confirm that the main-branch bridge dispatched **Release** with the matching `beta` or `stable` channel and publishing enabled. After a failed run, rerun the bridge or manually dispatch **Release** for the existing tag.
4. Approve the `release` environment deployment only after the rebuilt candidate passes.
5. Confirm the GitHub Release is marked as a prerelease for beta versions and that both installer entrypoints resolve from the release page.
6. Install through the public command on at least one clean machine before announcing the release.

The publish job uses `gh release create --verify-tag`; it cannot create a release for an unpushed tag. Beta and stable channels must match the version syntax.

## Promote or roll back

Stable promotion requires all 1.0 gates in [README.md](README.md), including two successful update and rollback cycles. Do not retag a release or replace an asset in place: manifests bind versioned URLs, byte sizes, and hashes. Fix the issue through `develop`, increment the version, and promote a new release commit to `main`.

If a published release is unsafe, mark it unavailable in GitHub, communicate the affected version, and ship a higher signed version. Preserve artifacts and audit records needed for incident review. Users can invoke the in-app rollback only when Quizzer has retained and reverified a previously installed signed package.
