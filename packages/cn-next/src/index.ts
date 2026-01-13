import { Command } from 'commander';
import { validateConfig } from './config';
import fs from 'fs';
import path from 'path';

const program = new Command();

program
    .name('kn-next')
    .description('Knative Open Next.js CLI')
    .version('0.0.1');

program
    .command('deploy')
    .description('Deploy the application based on cn-next.config.ts')
    .option('-c, --config <path>', 'Path to config file', 'cn-next.config.ts')
    .action(async (options) => {
        console.log(`Reading configuration from ${options.config}...`);
        const configPath = path.resolve(process.cwd(), options.config);

        if (!fs.existsSync(configPath)) {
            console.error(`Error: Config file not found at ${configPath}`);
            process.exit(1);
        }

        try {
            // Dynamic import of the config file (assuming ts-node or bun runtime)
            // For compiled binary, we might need a different loader strategy
            const userConfigModule = await import(configPath);
            const userConfig = userConfigModule.default || userConfigModule;

            const config = validateConfig(userConfig);
            console.log('Configuration Validated:', JSON.stringify(config, null, 2));

            console.log(`Starting Deployment for: ${config.name} [Mode: ${config.distribution_mode}]`);

            // TODO: Invoke Builder (Phase 1 Task)

        } catch (error) {
            console.error('Configuration Error:', error);
            process.exit(1);
        }
    });

program.parse(process.argv);
