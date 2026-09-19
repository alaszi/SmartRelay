import { loadEnvOrExit } from '@smartrelay/shared';

const env = loadEnvOrExit();

process.stdout.write(`worker: configuration OK (${env.NODE_ENV})\n`);
