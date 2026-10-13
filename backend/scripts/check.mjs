// Quick safety checks, run by `npm run check` and by the GitHub Actions workflow:
//   1. every source file parses (a syntax error would only show up when the server starts)
//   2. config.example.json is a valid config, so the example you copy to GitHub is never broken
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../src/githubConfig.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = ['src', 'scripts']
  .flatMap((dir) => readdirSync(new URL(`../${dir}/`, import.meta.url)).map((f) => `${dir}/${f}`))
  .filter((f) => /\.m?js$/.test(f));

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
  if (result.status === 0) {
    console.log(`ok    ${file}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${file}\n${result.stderr}`);
  }
}

try {
  const config = parseConfig(JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8')));
  console.log(`ok    config.example.json (${config.searchKeys.length} search keys)`);
} catch (err) {
  failed += 1;
  console.error(`FAIL  config.example.json: ${err.message}`);
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll checks passed');
