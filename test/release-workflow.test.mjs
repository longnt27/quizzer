import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowPath = new URL('../.github/workflows/release.yml', import.meta.url);

const ordered = (source, first, second) => {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  assert.notEqual(firstIndex, -1, `missing release step: ${first}`);
  assert.notEqual(secondIndex, -1, `missing release step: ${second}`);
  assert.ok(firstIndex < secondIndex, `${first} must run before ${second}`);
};

test('release validates packages and gates optional native signing explicitly', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  ordered(workflow, 'Install Linux packaging tools', 'Cache verified AppImage runtime');
  ordered(workflow, 'Cache verified AppImage runtime', 'Build desktop distributables');
  ordered(workflow, 'Build desktop distributables', 'Verify Apple signatures and notarization');
  ordered(workflow, 'Build desktop distributables', 'Notarize macOS distributables');
  ordered(workflow, 'Notarize macOS distributables', 'Verify Apple signatures and notarization');
  ordered(workflow, 'Build desktop distributables', 'Verify Windows signatures');
  ordered(workflow, 'Build desktop distributables', 'Verify Linux packages and AppImage');
  ordered(workflow, 'Verify Apple signatures and notarization', 'Normalize release artifacts');
  ordered(workflow, 'Verify Windows signatures', 'Normalize release artifacts');
  ordered(workflow, 'Verify Linux packages and AppImage', 'Normalize release artifacts');
  assert.match(workflow, /sudo apt-get install --yes fakeroot rpm squashfs-tools/);
  assert.match(workflow, /node scripts\/prepare-appimage-runtime\.mjs --arch "\$\{\{\s*matrix\.architecture\s*\}\}"/);
  assert.match(workflow, /APPIMAGE_PATH="\$\(require_single_artifact '\*\.appimage'\)"/);
  assert.match(workflow, /AI_MAGIC="\$\(dd if="\$APPIMAGE_PATH" bs=1 skip=8 count=3 2>\/dev\/null\)"/);
  assert.match(workflow, /codesign --verify --strict --verbose=2 out\/cli\/quizzer/);
  assert.match(workflow, /spctl --assess --type execute --verbose=4/);
  assert.match(workflow, /TeamIdentifier=\$APPLE_TEAM_ID/);
  assert.match(workflow, /MACOS_INSTALLER_CERTIFICATE: \$\{\{ secrets\.MACOS_INSTALLER_CERTIFICATE \}\}/);
  assert.match(workflow, /APPLE_INSTALLER_IDENTITY=\$APPLE_INSTALLER_IDENTITY_SECRET/);
  assert.match(workflow, /notarytool submit "\$DMG_PATH"/);
  assert.match(workflow, /notarytool submit "\$PKG_PATH"/);
  assert.match(workflow, /stapler validate "\$DMG_PATH"/);
  assert.match(workflow, /stapler validate "\$PKG_PATH"/);
  assert.match(workflow, /pkgutil --check-signature "\$PKG_PATH"/);
  assert.match(workflow, /grep -F "\$APPLE_INSTALLER_IDENTITY"/);
  assert.match(workflow, /Expected exactly one \$\{extension\} artifact/);
  assert.match(workflow, /Get-AuthenticodeSignature -FilePath \$Target/);
  assert.match(workflow, /EXPECTED_WINDOWS_CERTIFICATE_SHA256\.ToUpperInvariant\(\)/);
  assert.match(workflow, /matrix\.platform == 'macos' && vars\.QUIZZER_MACOS_SIGNING_ENABLED == 'true'/);
  assert.match(workflow, /matrix\.platform == 'windows' && vars\.QUIZZER_WINDOWS_SIGNING_ENABLED == 'true'/);
});

test('release publishes separate application and landing SBOMs', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.match(workflow, /name: Generate CycloneDX SBOM/);
  assert.match(workflow, /name: Generate landing CycloneDX SBOM\n\s+working-directory: landing\n\s+run: npm sbom --sbom-format cyclonedx > landing-sbom\.cdx\.json/);
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
  assert.doesNotMatch(workflow, /release:package-manifests|quizzer\.rb|Somethings1\.Quizzer/);
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

test('release signing and publication use the protected release environment', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const desktopJob = workflow.slice(workflow.indexOf('\n  desktop:'), workflow.indexOf('\n  publish:'));
  const publishJob = workflow.slice(workflow.indexOf('\n  publish:'));

  assert.match(desktopJob, /\n    environment: release\n/);
  assert.match(publishJob, /\n    environment: release\n/);
});

test('release compiles Windows x64 native addons with the supported Visual Studio toolchain', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.match(workflow, /runner: windows-2022\n\s+platform: windows\n\s+architecture: x64/);
  assert.doesNotMatch(workflow, /runner: windows-2025/);
});
