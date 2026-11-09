import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
const entries = {
  api: 'deploy/aws/dispatch.js',
  prediction: 'backend/lambdas/risk-prediction/handler.js',
  report: 'backend/lambdas/report-card-worker/handler.js',
  link: 'deploy/aws/link-google.js',
};
mkdirSync('deploy/aws/.build', { recursive: true });
for (const [name, entry] of Object.entries(entries)) await build({
  entryPoints: [entry], outfile: `deploy/aws/.build/${name}.mjs`, bundle: true, platform: 'node',
  target: 'node22', format: 'esm', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
