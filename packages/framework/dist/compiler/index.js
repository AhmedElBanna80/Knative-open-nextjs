"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const path_1 = __importDefault(require("path"));
const fs_extra_1 = __importDefault(require("fs-extra"));
const splitter_1 = require("./splitter");
const generator_1 = require("./generator");
const validator_1 = require("./validator");
const program = new commander_1.Command();
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
        const projectDir = path_1.default.resolve(options.dir);
        const nextDir = path_1.default.resolve(projectDir, '.next');
        const outputDir = path_1.default.resolve(options.output);
        console.log(`Validating Next.js project at ${projectDir}...`);
        const validator = new validator_1.Validator(projectDir);
        await validator.validate();
        console.log(`Analyzing Next.js build at ${nextDir}...`);
        const splitter = new splitter_1.Splitter(nextDir);
        const groups = await splitter.analyze();
        console.log(`Found ${groups.length} route groups.`);
        groups.forEach(g => console.log(` - ${g.name}: ${g.paths.join(', ')}`));
        // Load config
        const configPath = path_1.default.join(projectDir, 'knative-next.config.json');
        let envConfig = {};
        if (await fs_extra_1.default.pathExists(configPath)) {
            console.log(`Loading config from ${configPath}...`);
            const config = await fs_extra_1.default.readJSON(configPath);
            envConfig = config.env || {};
        }
        console.log(`Generating Knative manifests in ${outputDir}...`);
        const generator = new generator_1.Generator(outputDir, options.image, options.namespace, envConfig, options.dir);
        await generator.generate(groups);
        console.log('Done!');
    }
    catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
});
program.parse();
