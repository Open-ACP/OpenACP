import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    index: 'src/index.ts',
  },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  splitting: true,
  sourcemap: true,
  dts: true,
  clean: true,
  outDir: 'dist-publish/dist',
  external: [
    'grammy',
    'zod',
    'nanoid',
    '@agentclientprotocol/sdk',
    '@inquirer/prompts',
    'pino',
    'pino-pretty',
    'pino-roll',
  ],
})
