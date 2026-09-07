import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { load } from 'js-yaml';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
const apiPrefix = '/api/v1';
const operation = (method, path) => `${method.toUpperCase()} ${path}`;

const dynamicRoutes = {
  objectMatch: [['GET', '/objects/{sha256}'], ['HEAD', '/objects/{sha256}'], ['PUT', '/objects/{sha256}']],
  backupMatch: [['GET', '/backups/{backupId}']],
  pluginActionMatch: [['POST', '/plugins/{pluginId}/{action}']],
  pluginMatch: [['DELETE', '/plugins/{pluginId}']],
  indexJobActionMatch: [['POST', '/index/jobs/{jobId}/resume'], ['POST', '/index/jobs/{jobId}/cancel']],
  indexJobMatch: [['GET', '/index/jobs/{jobId}']],
  reextractDocumentMatch: [['POST', '/documents/{documentId}/reextract']],
  documentMatch: [['GET', '/documents/{documentId}'], ['DELETE', '/documents/{documentId}']],
  accountingMatch: [['GET', '/jobs/{jobId}/accounting']],
  ceilingMatch: [['POST', '/jobs/{jobId}/accounting/ceiling']],
  recoveryMatch: [['POST', '/jobs/{jobId}/accounting/recovery']],
  jobLeaseMatch: [['POST', '/jobs/{jobId}/lease']],
  jobCompleteMatch: [['POST', '/jobs/{jobId}/complete']],
  jobMatch: [['PATCH', '/jobs/{jobId}']],
  jobActionMatch: [['POST', '/jobs/{jobId}/resume'], ['POST', '/jobs/{jobId}/cancel']],
};

const documentedOperations = document => {
  const ids = new Set();
  const result = new Set();
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    assert.match(path, /^\//, `OpenAPI path must be relative to the /api/v1 server: ${path}`);
    for (const [method, descriptor] of Object.entries(pathItem ?? {})) {
      if (!HTTP_METHODS.has(method)) continue;
      assert.equal(typeof descriptor?.operationId, 'string', `${method.toUpperCase()} ${path} needs an operationId`);
      assert.ok(!ids.has(descriptor.operationId), `Duplicate operationId: ${descriptor.operationId}`);
      ids.add(descriptor.operationId);
      assert.ok(descriptor.responses && Object.keys(descriptor.responses).length > 0, `${method.toUpperCase()} ${path} needs responses`);
      result.add(operation(method, path));
    }
  }
  return result;
};

const implementedOperations = source => {
  const result = new Set();
  const exactRoute = /if \(request\.method === '([A-Z]+)' && url\.pathname === '(\/api\/v1\/[^']+)'\)/g;
  for (const match of source.matchAll(exactRoute)) {
    if (match[2] !== '/api/v1/openapi.yaml') result.add(operation(match[1], match[2].slice(apiPrefix.length)));
  }

  // This route has an optional legacy query form in the same condition, so it
  // intentionally does not match the simple exact-route expression above.
  assert.match(source, /request\.method === 'GET'.+url\.pathname === '\/api\/v1\/plugins\/registry'/);
  result.add(operation('GET', '/plugins/registry'));

  const declaredDynamicRoutes = new Set(
    [...source.matchAll(/const (\w+) = \/\^\\\/api\\\/v1\\\//g)].map(match => match[1]),
  );
  assert.deepEqual(declaredDynamicRoutes, new Set(Object.keys(dynamicRoutes)),
    'Every dynamic /api/v1 matcher must be represented in the OpenAPI drift map');
  for (const [matcher, routes] of Object.entries(dynamicRoutes)) {
    assert.match(source, new RegExp(`(?:if \\(${matcher} &&|if \\(${matcher}\\[)`), `${matcher} is no longer dispatched`);
    for (const [method, path] of routes) result.add(operation(method, path));
  }
  return result;
};

test('OpenAPI v1 document is valid YAML with unique, response-bearing operations', async () => {
  const document = load(await readFile(new URL('../openapi/quizzer-v1.yaml', import.meta.url), 'utf8'));
  assert.equal(document.openapi, '3.1.0');
  assert.equal(document.info?.version, '1.0.0');
  assert.equal(document.servers?.[0]?.url, 'http://127.0.0.1:8787/api/v1');
  assert.deepEqual(document.security, [{ bearerToken: [] }]);
  assert.equal(document.components?.securitySchemes?.bearerToken?.scheme, 'bearer');
  assert.ok(documentedOperations(document).size > 30);
});

test('OpenAPI operations stay in sync with every versioned service route', async () => {
  const [yaml, source] = await Promise.all([
    readFile(new URL('../openapi/quizzer-v1.yaml', import.meta.url), 'utf8'),
    readFile(new URL('../server.mjs', import.meta.url), 'utf8'),
  ]);
  const documented = documentedOperations(load(yaml));
  const implemented = implementedOperations(source);
  assert.deepEqual([...documented].sort(), [...implemented].sort());
});
