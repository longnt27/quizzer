import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowPath = new URL('../.github/workflows/release.yml', import.meta.url);
const mainBridgePath = new URL('../.github/workflows/release-from-main.yml', import.meta.url);
const ciPath = new URL('../.github/workflows/ci.yml', import.meta.url);

const ordered = (source, first, second) => {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  assert.notEqual(firstIndex, -1, `missing release step: ${first}`);
  assert.notEqual(secondIndex, -1, `missing release step: ${second}`);
  assert.ok(firstIndex < secondIndex, `${first} must run before ${second}`);
};

test('release builds daemon-only targets and gates optional native signing explicitly', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  ordered(workflow, 'Build standalone CLI', 'Notarize standalone CLI');
  ordered(workflow, 'Notarize standalone CLI', 'Normalize release artifacts');
  assert.match(workflow, /node-version: 26/);
  assert.match(workflow, /collect-release-artifacts\.mjs --cli-only/);
  assert.match(workflow, /name: runtime-\$\{\{ matrix\.platform \}\}-\$\{\{ matrix\.architecture \}\}/);
  assert.doesNotMatch(workflow, /Build desktop distributables/);
  assert.doesNotMatch(workflow, /Electron fuses/);
  assert.doesNotMatch(workflow, /AppImage runtime/);
  assert.doesNotMatch(workflow, /MACOS_INSTALLER_CERTIFICATE/);
  assert.doesNotMatch(workflow, /APPLE_INSTALLER_IDENTITY/);
  assert.match(workflow, /MACOS_CERTIFICATE: \$\{\{ secrets\.MACOS_CERTIFICATE \}\}/);
  assert.match(workflow, /WINDOWS_CERTIFICATE: \$\{\{ secrets\.WINDOWS_CERTIFICATE \}\}/);
  assert.match(workflow, /matrix\.platform == 'macos' && vars\.QUIZZER_MACOS_SIGNING_ENABLED == 'true'/);
  assert.match(workflow, /matrix\.platform == 'windows' && vars\.QUIZZER_WINDOWS_SIGNING_ENABLED == 'true'/);
  assert.match(workflow, /npm run test:e2e:production/);
});

test('release publishes separate application and landing SBOMs', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const verifyJob = workflow.slice(workflow.indexOf('\n  verify:'), workflow.indexOf('\n  landing:'));
  const landingJob = workflow.slice(workflow.indexOf('\n  landing:'), workflow.indexOf('\n  runtime:'));

  assert.match(workflow, /name: Generate CycloneDX SBOM/);
  assert.doesNotMatch(verifyJob, /Generate landing CycloneDX SBOM/);
  assert.match(landingJob, /name: Generate landing CycloneDX SBOM\n\s+run: npm sbom --sbom-format cyclonedx > landing-sbom\.cdx\.json/);
  assert.match(workflow, /name: landing-metadata\n\s+path: landing\/landing-sbom\.cdx\.json/);
  assert.match(workflow, /landing-metadata\/landing-sbom\.cdx\.json/);
  assert.match(workflow, /release-bundle\/landing-sbom\.cdx\.json/);
  assert.match(workflow, /gh release create[^\n]+release-bundle\/landing-sbom\.cdx\.json/);
});

test('release publishes only direct shell installer entrypoints and their verified payloads', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  ordered(workflow, 'Sign release manifest', 'Prepare verifying installers');
  ordered(workflow, 'Prepare verifying installers', 'Attest release artifacts and manifest');
  assert.match(workflow, /release-bundle\/install\.sh/);
  assert.match(workflow, /release-bundle\/install\.ps1/);
  assert.match(workflow, /gh release create[^\n]+release-bundle\/install\.sh release-bundle\/install\.ps1/);
  assert.doesNotMatch(workflow, /release:package-manifests|quizzer\.rb/);
  assert.match(workflow, /npm run release:trust/);
  assert.match(workflow, /QUIZZER_RELEASE_PUBLIC_KEY: \$\{\{ vars\.QUIZZER_RELEASE_PUBLIC_KEY \}\}/);
});

test('release rejects malformed tags and channel/version mismatches before building', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.match(workflow, /Release tag must be a canonical v-prefixed semantic version/);
  assert.match(workflow, /test "v\$\{PACKAGE_VERSION\}" = "\$RELEASE_TAG"/);
  assert.match(workflow, /if \[\[ "\$PACKAGE_VERSION" == \*-\* \]\]; then EXPECTED_CHANNEL=beta; fi/);
  assert.match(workflow, /if \[ "\$RELEASE_CHANNEL" != "\$EXPECTED_CHANNEL" \]/);
  ordered(workflow, 'Verify tag and package version', 'npm audit --omit=dev --audit-level=high');
});

test('release requires and publishes curated user-facing notes', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.match(workflow, /name: Verify curated release notes/);
  assert.match(workflow, /RELEASE_NOTES_PATH="release-notes\/\$\{RELEASE_TAG\}\.md"/);
  assert.match(workflow, /Curated, user-facing release notes are required/);
  assert.match(workflow, /--notes-file "\$RELEASE_NOTES_PATH"/);
  assert.doesNotMatch(workflow, /--generate-notes/);
});

test('release signing and publication use the protected release environment', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const runtimeJob = workflow.slice(workflow.indexOf('\n  runtime:'), workflow.indexOf('\n  publish:'));
  const publishJob = workflow.slice(workflow.indexOf('\n  publish:'));

  assert.match(runtimeJob, /\n    environment: release\n/);
  assert.match(publishJob, /\n    environment: release\n/);
});

test('release compiles Windows x64 native addons with the supported Visual Studio toolchain', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.match(workflow, /runner: windows-2022\n\s+platform: windows\n\s+architecture: x64/);
  assert.doesNotMatch(workflow, /runner: windows-2025/);
});

test('CI validates integration and release branch pushes', async () => {
  const workflow = await readFile(ciPath, 'utf8');
  assert.match(workflow, /push:\n\s+branches: \[develop, main\]/);
});

test('main pushes validate, tag, and explicitly dispatch a publishing release', async () => {
  const workflow = await readFile(mainBridgePath, 'utf8');

  assert.match(workflow, /push:\n\s+branches: \[main\]/);
  assert.match(workflow, /actions: write\n\s+contents: write/);
  assert.match(workflow, /scripts\/validate-release-transition\.mjs/);
  assert.match(workflow, /--previous-ref "\$BEFORE_SHA"/);
  assert.match(workflow, /--expected-sha "\$PUSHED_SHA"/);
  ordered(workflow, 'Validate release version transition', 'Create immutable release tag');
  ordered(workflow, 'Create immutable release tag', 'Dispatch signed release pipeline');
  assert.match(workflow, /git rev-list -n 1 "\$RELEASE_TAG"/);
  assert.match(workflow, /refusing to move it to \$PUSHED_SHA/);
  assert.match(workflow, /gh release view "\$RELEASE_TAG"/);
  assert.match(workflow, /workflow_runs\[\].+head_sha == \$sha.+status == "queued"/);
  assert.match(workflow, /gh workflow run release\.yml/);
  assert.match(workflow, /--ref "\$RELEASE_TAG"/);
  assert.match(workflow, /--field channel="\$RELEASE_CHANNEL"/);
  assert.match(workflow, /--field publish=true/);
});
