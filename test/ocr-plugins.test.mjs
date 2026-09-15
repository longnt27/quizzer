import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPluginManifest } from '../plugin-sdk/manifest.mjs';
import { extractGoogleVisionText } from '../plugins/ocr/google-cloud-vision/plugin.mjs';
import { extractTextractText, signTextractRequest } from '../plugins/ocr/aws-textract/plugin.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginDirectory = name => join(root, 'plugins', 'ocr', name);

for (const name of ['tesseract', 'apple-vision', 'google-cloud-vision', 'aws-textract']) {
  test(`${name} has a valid OCR plugin manifest and verified files`, async () => {
    const manifest = await loadPluginManifest(pluginDirectory(name), { verifyFiles: true });
    assert.deepEqual(manifest.capabilities, ['ocr']);
    assert.ok(manifest.permissions.filesystem.includes('scoped-temp'));
    assert.ok(manifest.permissions.filesystem.includes('document-read'));
  });
}

test('local OCR plugins do not request network or secret access', async () => {
  for (const name of ['tesseract', 'apple-vision']) {
    const manifest = await loadPluginManifest(pluginDirectory(name), { verifyFiles: true });
    assert.deepEqual(manifest.permissions.network, []);
    assert.deepEqual(manifest.permissions.secrets, []);
  }
});

test('cloud OCR plugins disclose network and credential requirements', async () => {
  const google = await loadPluginManifest(pluginDirectory('google-cloud-vision'), { verifyFiles: true });
  const aws = await loadPluginManifest(pluginDirectory('aws-textract'), { verifyFiles: true });
  assert.deepEqual(google.permissions.network, ['https://vision.googleapis.com']);
  assert.deepEqual(google.permissions.secrets, ['GOOGLE_CLOUD_VISION_API_KEY']);
  assert.ok(aws.permissions.network.length > 0);
  assert.ok(aws.permissions.secrets.includes('AWS_ACCESS_KEY_ID'));
  assert.ok(aws.permissions.secrets.includes('AWS_SECRET_ACCESS_KEY'));
});

test('Google Vision response parser prefers full document text and surfaces provider errors', () => {
  assert.equal(extractGoogleVisionText({ responses: [{ fullTextAnnotation: { text: 'Hello\r\nworld\n' } }] }), 'Hello\nworld');
  assert.equal(extractGoogleVisionText({ responses: [{ textAnnotations: [{ description: 'fallback text' }] }] }), 'fallback text');
  assert.throws(() => extractGoogleVisionText({ responses: [{ error: { message: 'quota exceeded' } }] }), /quota exceeded/);
});

test('Textract response parser keeps reading-order line text only', () => {
  assert.equal(extractTextractText({ Blocks: [
    { BlockType: 'LINE', Text: 'First line' },
    { BlockType: 'WORD', Text: 'ignored' },
    { BlockType: 'LINE', Text: ' Second line ' },
  ] }), 'First line\nSecond line');
});

test('Textract signing is deterministic and includes temporary-session credentials', () => {
  const signed = signTextractRequest({
    body: '{"Document":{"Bytes":"YWJj"}}',
    region: 'ap-southeast-1',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secret',
    sessionToken: 'session-token',
    date: new Date('2020-01-02T03:04:05.000Z'),
  });
  assert.equal(signed.url, 'https://textract.ap-southeast-1.amazonaws.com/');
  assert.equal(signed.headers['X-Amz-Date'], '20200102T030405Z');
  assert.equal(signed.headers['X-Amz-Security-Token'], 'session-token');
  assert.match(signed.headers.Authorization, /Credential=AKIDEXAMPLE\/20200102\/ap-southeast-1\/textract\/aws4_request/);
  assert.match(signed.headers.Authorization, /SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target/);
});
