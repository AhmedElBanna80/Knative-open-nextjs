import { Command } from 'commander';
import path from 'path';
import fs from 'fs-extra';
import { Splitter } from './splitter';
import { Generator } from './generator';
import { Validator } from './validator';
import { Packager } from './packager';

const program = new Command();

program
    .name('knative-next-compiler')
    .description('Compiles Next.js application for Knative deployment')
    .version('0.1.0')
    .requiredOption('-i, --image <image>', 'Docker image name for the runtime')
    .option('-d, --dir <dir>', 'Path to Next.js project root', '.')
    .option('-o, --output <output>', 'Output directory for YAMLs', './knative-manifests')
    .option('-n, --namespace <namespace>', 'Kubernetes namespace', 'default')
    .action(async (options) => {
        try {
            const projectDir = path.resolve(options.dir);
            const nextDir = path.resolve(projectDir, '.next');
            const outputDir = path.resolve(options.output);

            console.log(`Validating Next.js project at ${projectDir}...`);
            const validator = new Validator(projectDir);
            await validator.validate();

            console.log(`Analyzing Next.js build at ${nextDir}...`);
            const splitter = new Splitter(nextDir);
            const groups = await splitter.analyze();

            console.log(`Found ${groups.length} route groups.`);
            groups.forEach(g => console.log(` - ${g.name}: ${g.paths.join(', ')}`));

            // Load config
            const configPath = path.join(projectDir, 'knative-next.config.json');
            let envConfig = {};
            if (await fs.pathExists(configPath)) {
                console.log(`Loading config from ${configPath}...`);
                const config = await fs.readJSON(configPath);
                envConfig = config.env || {};
            }

            console.log(`Generating Knative manifests in ${outputDir}...`);

            // Package each group
            const packager = new Packager(projectDir, outputDir, options.image);
            const groupImages: Record<string, string> = {};

            for (const group of groups) {
                const imageName = await packager.package(group);
                groupImages[group.name] = imageName;
            }

            const generator = new Generator(outputDir, options.image, options.namespace, envConfig, options.dir);
            await generator.generate(groups, groupImages);

            console.log('Done!');
        } catch (error) {
            console.error('Error:', error);
            process.exit(1);
        }
    });

program.parse();
