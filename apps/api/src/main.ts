import { loadEnvOrExit } from '@smartrelay/shared';

const env = loadEnvOrExit();

process.stdout.write(`api: configuration OK (${env.NODE_ENV})\n`);
