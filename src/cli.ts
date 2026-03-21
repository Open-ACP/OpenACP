#!/usr/bin/env node

import { setDefaultAutoSelectFamily } from "node:net";
setDefaultAutoSelectFamily(false);

import {
  printHelp,
  cmdVersion,
  cmdInstall,
  cmdUninstall,
  cmdPlugins,
  cmdApi,
  cmdStart,
  cmdStop,
  cmdStatus,
  cmdLogs,
  cmdConfig,
  cmdReset,
  cmdUpdate,
  cmdDefault,
  cmdAdopt,
  cmdIntegrate,
} from './cli/commands.js'

const args = process.argv.slice(2);
const command = args[0];

const commands: Record<string, () => Promise<void>> = {
  '--help': async () => printHelp(),
  '-h': async () => printHelp(),
  '--version': () => cmdVersion(),
  '-v': () => cmdVersion(),
  'install': () => cmdInstall(args),
  'uninstall': () => cmdUninstall(args),
  'plugins': () => cmdPlugins(),
  'api': () => cmdApi(args),
  'start': () => cmdStart(),
  'stop': () => cmdStop(),
  'status': () => cmdStatus(),
  'logs': () => cmdLogs(),
  'config': () => cmdConfig(),
  'reset': () => cmdReset(),
  'update': () => cmdUpdate(),
  'adopt': () => cmdAdopt(args),
  'integrate': () => cmdIntegrate(args),
  '--daemon-child': async () => {
    const { startServer } = await import('./main.js')
    await startServer()
  },
}

async function main() {
  const handler = command ? commands[command] : undefined
  if (handler) {
    await handler()
  } else {
    await cmdDefault(command)
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
