"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_path_1 = __importDefault(require("node:path"));
const commander_1 = require("commander");
const fs_extra_1 = __importDefault(require("fs-extra"));
const generator_1 = require("./generator");
const packager_1 = require("./packager");
const splitter_1 = require("./splitter");
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
        const projectDir = node_path_1.default.resolve(options.dir);
        const nextDir = node_path_1.default.resolve(projectDir, '.next');
        const outputDir = node_path_1.default.resolve(options.output);
        const validator = new validator_1.Validator(projectDir);
        await validator.validate();
        const splitter = new splitter_1.Splitter(nextDir);
        const groups = await splitter.analyze();
        // Load config
        const configPath = node_path_1.default.join(projectDir, 'knative-next.config.json');
        let envConfig = {};
        if (await fs_extra_1.default.pathExists(configPath)) {
            const config = await fs_extra_1.default.readJSON(configPath);
            envConfig = config.env || {};
        }
        // Package each group
        const packager = new packager_1.Packager(projectDir, outputDir, options.image);
        const groupImages = {};
        for (const group of groups) {
            const imageName = await packager.package(group);
            groupImages[group.name] = imageName;
        }
        const generator = new generator_1.Generator(outputDir, options.image, options.namespace, envConfig, options.dir);
        await generator.generate(groups, groupImages);
    }
    catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
});
program.parse();
