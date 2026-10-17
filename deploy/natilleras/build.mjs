// Empaqueta cada Lambda en dist/<nombre>/index.js (CommonJS, Node 22) y genera dist/<nombre>.zip.
// El AWS SDK v3 viene en el runtime de Lambda, así que se deja fuera del bundle.
// Con --test empaqueta test/*.test.ts en dist-test/ (node --test los corre con un DynamoDB falso).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';

export const lambdas = [
  'get-me',
  'verify-wallet',
  'save-account',
  'list-accounts',
  'create-natillera',
  'get-invitation',
  'join-natillera',
  'get-my-natillera',
];
const common = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['@aws-sdk/*'], logLevel: 'warning' };

if (process.argv.includes('--test')) {
  rmSync('dist-test', { recursive: true, force: true });
  for (const file of readdirSync('test').filter((f) => f.endsWith('.test.ts'))) {
    await build({ ...common, entryPoints: [`test/${file}`], outfile: `dist-test/${file.replace(/\.ts$/, '.cjs')}` });
  }
} else {
  rmSync('dist', { recursive: true, force: true });
  for (const name of lambdas) {
    await build({ ...common, entryPoints: [`src/${name}.ts`], outfile: `dist/${name}/index.js` });
    if (process.platform === 'win32') {
      execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path dist/${name}/index.js -DestinationPath dist/${name}.zip -Force`]);
    } else {
      execFileSync('zip', ['-j', `dist/${name}.zip`, `dist/${name}/index.js`]);
    }
    console.log(`dist/${name}.zip  (handler: index.handler)`);
  }
}
