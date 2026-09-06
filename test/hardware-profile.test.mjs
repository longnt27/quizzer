import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { detectHardwareCapabilities, recommendHardwareProfile } from '../server/hardware-profile.mjs';

test('recommends Lite for constrained or unknown hardware', () => {
  assert.equal(recommendHardwareProfile({ cpuCores: 4, memoryGB: 8, freeDiskGB: 100 }), 'lite');
  assert.equal(recommendHardwareProfile({ cpuCores: 16, memoryGB: 64, freeDiskGB: 0 }), 'lite');
});

test('recommends Balanced without overcommitting to large local models', () => {
  assert.equal(recommendHardwareProfile({ cpuCores: 8, memoryGB: 16, freeDiskGB: 20 }), 'balanced');
  assert.equal(recommendHardwareProfile({ cpuCores: 16, memoryGB: 24, freeDiskGB: 100 }), 'balanced');
});

test('recommends Max only when CPU, memory, and disk thresholds pass', () => {
  assert.equal(recommendHardwareProfile({ cpuCores: 12, memoryGB: 32, freeDiskGB: 50 }), 'max');
});

test('returns a complete capability snapshot for onboarding', () => {
  const result = detectHardwareCapabilities(process.cwd());
  assert.ok(result.cpuCores >= 1);
  assert.ok(result.memoryGB > 0);
  assert.ok(result.freeDiskGB >= 0);
  assert.ok(['lite', 'balanced', 'max'].includes(result.recommendedProfile));
  assert.ok(result.reasons.length >= 2);
});

test('falls back to Lite when free disk space cannot be inspected', () => {
  const missing = join(tmpdir(), `quizzer-missing-hardware-path-${process.pid}-${Date.now()}`);
  const result = detectHardwareCapabilities(missing);
  assert.equal(result.freeDiskGB, 0);
  assert.equal(result.recommendedProfile, 'lite');
  assert.match(result.reasons[0], /Lite keeps/);
});
