import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  // Workspace packages ship as TypeScript source, so they must be bundled in.
  noExternal: [/^@smartrelay\//],
  // @node-rs/argon2: esbuild would try to statically resolve every platform's prebuilt .node
  // binary (only the current platform's is actually installed) and fail. pg: uses a dynamic
  // require() of Node built-ins that bundled ESM output cannot resolve. Both are left as real
  // imports, which Node resolves normally at runtime (both are direct dependencies here so
  // they're always installed alongside the built app).
  external: ['@node-rs/argon2', 'pg'],
});
