import fs from 'fs';
import path from 'path';
import { loadApiTestSuite } from './core/integration/api/config-loader.js';
import { runApiTestSuite, writeApiRunArtifacts } from './core/integration/api/runner.js';

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const configPath = getArg('--config') || 'testkit.api.json';
  const suite = loadApiTestSuite(process.cwd(), configPath);

  if (!suite) {
    console.error(`❌ Không tìm thấy API test suite: ${path.resolve(configPath)}`);
    console.error('   Tạo testkit.api.json hoặc truyền --config <file>.');
    process.exitCode = 2;
    return;
  }

  console.log(`\n🧪 API Integration Test — ${suite.tests.length} test case(s)`);
  console.log(`   Base URL: ${suite.baseUrl}`);

  const result = await runApiTestSuite(suite);
  const runDirectory = path.join(
    process.cwd(),
    'artifacts',
    'runs',
    `api_${Date.now()}`,
  );
  const artifacts = writeApiRunArtifacts(result, runDirectory);

  for (const test of result.tests) {
    console.log(`   ${test.ok ? '✔' : '✖'} ${test.id} — ${test.name} (${test.durationMs}ms)`);
    if (!test.ok) {
      if (test.error) console.log(`      Error: ${test.error}`);
      for (const assertion of test.assertions.filter(item => !item.ok)) {
        console.log(`      ${assertion.message}`);
      }
    }
  }

  console.log(`\n   Total: ${result.totalTests} | Pass: ${result.passedTests} | Fail: ${result.failedTests}`);
  console.log(`   JSON: ${artifacts.jsonPath}`);
  console.log(`   Report: ${artifacts.markdownPath}`);
  process.exitCode = result.ok ? 0 : 1;
}

main().catch(error => {
  console.error(`❌ API Test Runner thất bại: ${error?.message || error}`);
  process.exitCode = 1;
});
