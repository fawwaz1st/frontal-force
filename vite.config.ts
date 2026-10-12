import { defineConfig } from 'vite';

// GitHub Pages serves project sites from /<repo>/, so the built asset URLs
// must carry that prefix. In CI the repo name comes from the Actions
// environment (renames keep working); locally it falls back to the known
// repository name.
//
// `vite preview` uses the same base as the build, so `npm run preview` serves
// the exact URLs GitHub Pages will serve (http://localhost:4173/frontal-force/).
// Only the dev server keeps the root base.
const repoName = process.env.GITHUB_REPOSITORY?.split('/')[1];
const REPO_BASE = `/${repoName ?? 'frontal-force'}/`;

export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? REPO_BASE : '/',
  server: { host: true },
  build: {
    target: 'es2022',
    // three is the only large dependency and it is loaded on every page view,
    // so splitting it out buys a long-lived cache entry instead of a chunk
    // that changes on every gameplay tweak. Vite 8 builds on rolldown, so the
    // grouping lives under rolldownOptions (manualChunks is not supported).
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: 'three', test: /[\\/]node_modules[\\/]three[\\/]/ }],
        },
      },
    },
  },
}));
