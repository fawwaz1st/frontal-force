// Runtime harness runner — transpiles the real modules, then executes them.
//
// The self-check suite (scripts/self-check.ts) asserts WIRING by reading source
// text, which cannot prove a formula produces the right number. This runner
// compiles the actual modules with the project's own TypeScript and drives
// them, so a sign error, a wrong operator, or a clamp in the wrong place is
// caught by execution rather than by pattern matching.
//
// Usage: npm run check:runtime
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
// The emit target must live INSIDE the project: the harness imports 'three',
// and Node resolves a bare specifier by walking up from the importing file. A
// temp directory has no node_modules above it, so the run would fail on the
// first import no matter how correct the game code is.
const outDir = join(root, '.runtime-build');

const config = {
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'bundler',
    lib: ['ES2022', 'DOM', 'DOM.Iterable'],
    types: [],
    strict: false,
    skipLibCheck: true,
    noEmit: false,
    outDir,
    rootDir: root,
    isolatedModules: true,
    useDefineForClassFields: true,
    resolveJsonModule: true,
    esModuleInterop: true,
    allowImportingTsExtensions: false,
    noUnusedLocals: false,
    noUnusedParameters: false,
    noImplicitReturns: false,
    exactOptionalPropertyTypes: false,
    noUncheckedIndexedAccess: false,
    verbatimModuleSyntax: false,
  },
  include: [join(root, 'src'), join(root, 'scripts/runtime-check.ts')],
};
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const configPath = join(outDir, 'tsconfig.json');
writeFileSync(configPath, JSON.stringify(config), 'utf8');

// Type errors are expected here: the harness is plain Node code (no @types/node
// in this project) and main.ts imports CSS. Only the EMITTED JS matters.
try {
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', configPath], {
    stdio: 'pipe',
  });
} catch {
  /* emit-on-error is on, so the JS exists even when the type pass complains */
}

/** Rewrite extensionless relative imports so Node's ESM loader can resolve them. */
const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const p = join(dir, name);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
});
for (const file of [...walk(join(outDir, 'src')), join(outDir, 'scripts/runtime-check.js')]) {
  const before = readFileSync(file, 'utf8');
  const after = before.replace(/from '(\.{1,2}\/[^']*?)'/g, (_m, spec) => {
    const clean = spec.replace(/\.ts$/, '');
    return `from '${clean.endsWith('.js') ? clean : `${clean}.js`}'`;
  });
  if (after !== before) writeFileSync(file, after, 'utf8');
}

try {
  execFileSync(process.execPath, [join(outDir, 'scripts/runtime-check.js')], { stdio: 'inherit' });
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
