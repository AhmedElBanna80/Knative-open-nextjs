import { Command } from 'commander';
import { loadConfig } from './loader';
import path from 'path';
import { spawn } from 'child_process';
import fs from 'fs';

const program = new Command();

program
    .name('kn-next')
    .description('Knative Open Next.js CLI')
    .version('0.0.1');

program
    .command('deploy')
    .description('Deploy the application based on cn-next.config.ts')
    .option('-c, --config <path>', 'Path to config file', 'cn-next.config.ts')
    .option('--dry-run', 'Simulate deployment')
    .action(async (options) => {
        try {
            const config = await loadConfig(options.config);
            console.log(`🚀 Starting Deployment for: ${config.name} [Mode: ${config.distribution_mode}]`);
            if (options.dryRun) console.log('🔍 DRY RUN ENABLED');

            const rootDir = process.cwd();

            // Locate Binaries
            const offloaderBin = path.join(rootDir, 'packages/static-offloader/static-offloader');
            const builderBin = path.join(rootDir, 'packages/monolith-builder/monolith-builder');

            // 1. Static Asset Offloading
            if (fs.existsSync(offloaderBin)) {
                console.log('\n📦 Offloading Static Assets...');
                const offloaderArgs = ['--root', rootDir];
                if (options.dryRun) offloaderArgs.push('--dry-run');

                const offloader = spawn(offloaderBin, offloaderArgs, {
                    stdio: ['pipe', 'inherit', 'inherit']
                });

                offloader.stdin.write(JSON.stringify(config.infrastructure));
                offloader.stdin.end();

                await new Promise((resolve, reject) => {
                    offloader.on('close', (code) => {
                        if (code === 0) resolve(true);
                        else reject(new Error(`Offloader exited with code ${code}`));
                    });
                });
            } else {
                console.warn(`⚠️ Static Offloader binary not found at ${offloaderBin}. Skipping.`);
            }

            // 2. Build Monolith (Granular)
            if (fs.existsSync(builderBin)) {
                console.log('\n🏗️  Building Application...');
                const builderArgs = [
                    '-src', rootDir,
                    '-out', path.join(rootDir, 'dist-isolated'),
                    '-entrypoint', 'apps/file-manager/page.js' // TODO: dynamic entrypoint from config?
                ];

                const builder = spawn(builderBin, builderArgs, {
                    stdio: 'inherit'
                });

                await new Promise((resolve, reject) => {
                    builder.on('close', (code) => {
                        if (code === 0) resolve(true);
                        else reject(new Error(`Builder exited with code ${code}`));
                    });
                });
            } else {
                console.warn(`⚠️ Monolith Builder binary not found at ${builderBin}. Skipping.`);
                return; // Cannot deploy without build
            }

            // 3. Docker Build & Push
            const appName = config.name; // e.g. "file-manager"
            const imageTag = `${config.infrastructure.docker_registry}/${appName}:latest`; // simplified tag

            if (fs.existsSync(path.join(rootDir, 'dist-isolated', 'Dockerfile'))) {
                console.log(`\n🐳 Building Docker Image: ${imageTag}...`);

                const buildArgs = ['build', '-t', imageTag, '.'];
                if (options.dryRun) {
                    console.log(`[Dry Run] docker ${buildArgs.join(' ')}`);
                } else {
                    const dockerBuild = spawn('docker', buildArgs, { cwd: path.join(rootDir, 'dist-isolated'), stdio: 'inherit' });
                    await new Promise((resolve, reject) => {
                        dockerBuild.on('close', (code) => {
                            if (code === 0) resolve(true);
                            else reject(new Error(`Docker build exited with code ${code}`));
                        });
                    });
                }

                console.log(`\n🚀 Pushing Image to Registry...`);
                const pushArgs = ['push', imageTag];
                if (options.dryRun) {
                    console.log(`[Dry Run] docker ${pushArgs.join(' ')}`);
                } else {
                    const dockerPush = spawn('docker', pushArgs, { stdio: 'inherit' });
                    await new Promise((resolve, reject) => {
                        dockerPush.on('close', (code) => {
                            if (code === 0) resolve(true);
                            else reject(new Error(`Docker push exited with code ${code}`));
                        });
                    });
                }
            } else {
                if (!options.dryRun) console.warn('⚠️ No Dockerfile found in dist-isolated. Skipping Docker steps.');
                else console.log('[Dry Run] Skipping Docker build (Dockerfile not expected)');
            }

            // 4. Knative Deployment (KSVC)
            console.log(`\n🔥 Deploying Knative Service...`);
            const ksvcYaml = `
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: ${appName}
  namespace: default
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/min-scale: "0"
    spec:
      containers:
        - image: ${imageTag}
          env:
            - name: DATABASE_URL
              value: "${config.infrastructure.database_service.connection_string}"
            - name: ASSET_PREFIX
              value: "${config.infrastructure.s3_service.public_url}"
`;

            if (options.dryRun) {
                console.log(`[Dry Run] Generated KSVC:\n${ksvcYaml}`);
                console.log(`[Dry Run] kubectl apply -f -`);
            } else {
                const kubectl = spawn('kubectl', ['apply', '-f', '-'], { stdio: ['pipe', 'inherit', 'inherit'] });
                kubectl.stdin.write(ksvcYaml);
                kubectl.stdin.end();
                await new Promise((resolve, reject) => {
                    kubectl.on('close', (code) => {
                        if (code === 0) resolve(true);
                        else reject(new Error(`Kubectl apply exited with code ${code}`));
                    });
                });
            }

            console.log('\n✅ Deployment Complete!');

        } catch (error) {
            console.error('❌ Deployment Failed:', error);
            process.exit(1);
        }
    });

program.parse(process.argv);
