import { readdir, readFile } from 'node:fs/promises';

const roots = ['src', 'public'];
const forbidden = [/console\.log\(/g, /password\s*:/gi, /api[_-]?key\s*[:=]\s*['\"]/gi];
let failures = 0;
for (const root of roots) {
  const files = await readdir(root, { recursive: true });
  for (const file of files) {
    if (!/\.(m?js|css|html)$/.test(file)) continue;
    const path = `${root}/${file}`;
    const content = await readFile(path, 'utf8');
    for (const pattern of forbidden) {
      if (pattern.test(content)) {
        failures++;
        console.error(`Lint warning: ${path} matches ${pattern}`);
      }
      pattern.lastIndex = 0;
    }
  }
}
process.exitCode = failures ? 1 : 0;
