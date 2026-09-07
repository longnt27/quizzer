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

test('release verifies packaged signatures before collecting artifacts', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  ordered(workflow, 'Install Linux packaging tools', 'Cache verified AppImage runtime');
  ordered(workflow, 'Cache verified AppImage runtime', 'Build signed desktop distributables');
  ordered(workflow, 'Build signed desktop distributables', 'Verify Apple signatures and notarization');
  ordered(workflow, 'Build signed desktop distributables', 'Notarize macOS distributables');
  ordered(workflow, 'Notarize macOS distributables', 'Verify Apple signatures and notarization');
  ordered(workflow, 'Build signed desktop distributables', 'Verify Windows signatures');
  ordered(workflow, 'Build signed desktop distributables', 'Verify Linux packages and AppImage');
  ordered(workflow, 'Verify Apple signatures and notarization', 'Normalize release artifacts');
  ordered(workflow, 'Verify Windows signatures', 'Normalize release artifacts');
  ordered(workflow, 'Verify Linux packages and AppImage', 'Normalize release artifacts');
  assert.match(workflow, /sudo apt-get install --yes fakeroot rpm squashfs-tools/);
  assert.match(workflow, /2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d/);
  assert.match(workflow, /00cbdfcf917cc6c0ff6d3347d59e0ca1f7f45a6df1a428a0d6d8a78664d87444/);
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
