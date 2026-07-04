// Bundles the action into a single self-contained ESM file with esbuild.
//
// The @actions/* toolkit is ESM-only (v3+), so the bundle is emitted as ESM.
// Some bundled transitive dependencies are CommonJS and call require()/__dirname
// at runtime; the banner shims those into the ESM output.

import { build } from 'esbuild';

const shim = [
  "import { createRequire as __createRequire } from 'node:module';",
  "import { fileURLToPath as __fileURLToPath } from 'node:url';",
  "import { dirname as __pathDirname } from 'node:path';",
  'const require = __createRequire(import.meta.url);',
  'const __filename = __fileURLToPath(import.meta.url);',
  'const __dirname = __pathDirname(__filename);',
].join('\n');

await build({
  entryPoints: ['src/index.js'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outfile: 'dist/index.js',
  banner: { js: shim },
  // Collect bundled dependencies' license notices into dist/index.js.LEGAL.txt.
  legalComments: 'external',
});

console.log('Built dist/index.js');
