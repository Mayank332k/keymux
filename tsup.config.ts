import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
    'proxy/index': 'src/proxy/index.ts'
  },
  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
  platform: 'node',
  target: 'node18',
  outDir: 'dist',
  banner: {
    js: '// keymux v1.0.0 — Smart API Key Multiplexer for LLM Providers'
  }
});