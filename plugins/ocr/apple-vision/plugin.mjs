import { spawn } from 'node:child_process';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scopedPath = (context, relativePath) => {
  const root = resolve(String(context?.temporaryDirectory ?? ''));
  const target = resolve(root, String(relativePath ?? ''));
  if (!root || target !== root && !target.startsWith(`${root}${sep}`)) throw new Error('Image path escapes the plugin temporary directory');
  return target;
};

const visionScript = String.raw`
ObjC.import('Foundation');
ObjC.import('Vision');
function run(argv) {
  var url = $.NSURL.fileURLWithPath(argv[0]);
  var request = $.VNRecognizeTextRequest.alloc.init;
  request.recognitionLevel = $.VNRequestTextRecognitionLevelAccurate;
  request.usesLanguageCorrection = true;
  try { request.automaticallyDetectsLanguage = true; } catch (_) {}
  var handler = $.VNImageRequestHandler.alloc.initWithURL_options(url, $({}));
  var error = Ref();
  if (!handler.performRequests_error($([request]), error)) {
    throw new Error(ObjC.unwrap(error[0].localizedDescription));
  }
  var results = ObjC.unwrap(request.results) || [];
  var lines = [];
  for (var i = 0; i < results.length; i++) {
    var observation = results[i];
    var candidates = ObjC.unwrap(observation.topCandidates(1)) || [];
    if (!candidates.length) continue;
    lines.push({ text: ObjC.unwrap(candidates[0].string), y: observation.boundingBox.origin.y, x: observation.boundingBox.origin.x });
  }
  lines.sort(function(a, b) { return Math.abs(a.y - b.y) > 0.01 ? b.y - a.y : a.x - b.x; });
  return lines.map(function(line) { return line.text; }).join('\n');
}`;

const runVision = imagePath => new Promise((resolvePromise, reject) => {
  const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', visionScript, '--', imagePath], {
    shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout = `${stdout}${chunk}`.slice(-1_000_000); });
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-64_000); });
  child.once('error', reject);
  child.once('close', code => code === 0 ? resolvePromise(stdout.replace(/\r\n?/g, '\n').trim())
    : reject(new Error(stderr.trim() || `Apple Vision bridge exited with code ${code}`)));
});

export const handleRequest = async request => {
  if (process.platform !== 'darwin') throw new Error('Apple Vision OCR is available only on macOS');
  if (request.method === 'plugin.health') return { engine: 'apple-vision', available: true };
  if (request.method !== 'document.ocr') throw new Error(`Unsupported method: ${request.method}`);
  return { text: await runVision(scopedPath(request.context, request.params?.image?.path)) };
};

const respond = (request, result, error) => process.stdout.write(`${JSON.stringify(error
  ? { jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32000, message: error.message } }
  : { jsonrpc: '2.0', id: request.id, result })}\n`);
const main = () => {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    process.stdin.pause();
    let request;
    try { request = JSON.parse(buffer.slice(0, newline)); }
    catch (error) { respond(undefined, undefined, error); return; }
    void handleRequest(request).then(result => respond(request, result)).catch(error => respond(request, undefined, error));
  });
};
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
