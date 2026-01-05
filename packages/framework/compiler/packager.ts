import { exec } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { nodeFileTrace } from '@vercel/nft';
import fs from 'fs-extra';
import { buildGroupImageName } from './image-name';
import type { RouteGroup } from './splitter';

const execAsync = promisify(exec);

export class Packager {
  private projectDir: string;
  private nextDir: string;
  private outputDir: string;
  private baseImageName: string;

  constructor(projectDir: string, outputDir: string, baseImageName: string) {
    this.projectDir = projectDir;
    this.nextDir = path.join(projectDir, '.next');
    this.outputDir = outputDir;
    this.baseImageName = baseImageName;
  }

  async package(group: RouteGroup): Promise<string> {
    const groupName = group.name;
    const buildDir = path.join(this.outputDir, 'builds', groupName);
    await fs.ensureDir(buildDir);

    // 1. Identify Entry Points
    const entryPoints: string[] = [];
    for (const pagePath of group.paths) {
      let pagesPath = pagePath;
      if (pagesPath === '/') pagesPath = '/index';
      let appPath = pagePath;
      if (appPath === '/') appPath = '';

      const candidates = [
        path.join(this.nextDir, 'server', 'pages', `${pagesPath}.js`),
        path.join(this.nextDir, 'server', 'pages', `${pagesPath}.html`),
        path.join(this.nextDir, 'server', 'app', appPath, 'page.js'),
      ];

      for (const c of candidates) {
        if (await fs.pathExists(c)) {
          entryPoints.push(c);
          break;
        }
      }
    }

    // Check for Standalone Mode
    const standaloneDir = path.join(this.nextDir, 'standalone');
    let useStandalone = false;
    let serverJsPath = 'server.js'; // default

    if (await fs.pathExists(standaloneDir)) {
      console.log(`Standalone build detected at ${standaloneDir}. Using it.`);
      useStandalone = true;

      // Copy standalone content
      await execAsync(`cp -R "${standaloneDir}/" "${buildDir}/"`);

      // Find server.js inside buildDir
      // It effectively creates the full path structure inside buildDir
      // We need to find where server.js is relative to buildDir
      // Heuristic: search for server.js in the mirrored path
      // apps/file-manager/.next/standalone/alpheya/pocs/Knative-open-nextjs/apps/file-manager/server.js
      // We can use 'find' inside buildDir to locate it? Or just assume one?
      // For this POC, let's find it.
      try {
        const { stdout } = await execAsync(`find . -name server.js`, { cwd: buildDir });
        const lines = stdout.trim().split('\n');
        // Use the first one that looks like a main server.js (not in node_modules)
        for (const line of lines) {
          if (!line.includes('node_modules')) {
            serverJsPath = line.replace(/^\.\//, ''); // remove ./
            break;
          }
        }
      } catch (e) {
        console.warn("Could not find server.js in standalone build", e);
      }

      // Determine the directory containing server.js to place assets correctly
      const serverJsDir = path.dirname(serverJsPath);
      const destDir = path.join(buildDir, serverJsDir);

      // Copy static assets for standalone
      const staticSrc = path.join(this.nextDir, 'static');
      // Place .next/static relative to server.js
      const staticDest = path.join(destDir, '.next', 'static');
      await fs.ensureDir(path.join(destDir, '.next'));
      try {
        await execAsync(`cp -R "${staticSrc}" "${staticDest}"`);
      } catch (e) {
        console.warn('Failed to copy .next/static', e);
      }

      const publicSrc = path.join(this.projectDir, 'public');
      if (await fs.pathExists(publicSrc)) {
        // Place public relative to server.js
        await execAsync(`cp -R "${publicSrc}" "${path.join(destDir, 'public')}"`);
      }

      // Explicitly copy instrumentation.js if it exists in .next/server
      const instrumentationSrc = path.join(this.nextDir, 'server', 'instrumentation.js');
      if (await fs.pathExists(instrumentationSrc)) {
        console.log(`Copying instrumentation.js from ${instrumentationSrc}`);
        const dest = path.join(buildDir, '.next', 'server', 'instrumentation.js');
        await fs.ensureDir(path.dirname(dest));
        await fs.copy(instrumentationSrc, dest);

        // Copy .next/server/chunks to ensure dependencies of instrumentation.js are present
        const chunksSrc = path.join(this.nextDir, 'server', 'chunks');
        if (await fs.pathExists(chunksSrc)) {
          console.log(`Copying server chunks from ${chunksSrc}`);
          const chunksDest = path.join(buildDir, '.next', 'server', 'chunks');
          await fs.ensureDir(chunksDest);
          await fs.copy(chunksSrc, chunksDest);
        }

        // Copy @opentelemetry dependencies if they exist
        // This is required because standalone build fails to trace them if instrumentation.js was excluded
        let otelSrc = path.join(this.projectDir, 'node_modules', '@opentelemetry');
        console.log(`Checking for @opentelemetry at ${otelSrc}`);
        if (!(await fs.pathExists(otelSrc))) {
          console.log('Not found in project node_modules, checking root...');
          otelSrc = path.join(this.projectDir, '../../node_modules', '@opentelemetry');
          console.log(`Checking for @opentelemetry at ${otelSrc}`);
        }

        if (await fs.pathExists(otelSrc)) {
          console.log(`Copying @opentelemetry dependencies from ${otelSrc}`);
          const otelDest = path.join(buildDir, 'node_modules', '@opentelemetry');
          await fs.ensureDir(otelDest);
          await fs.copy(otelSrc, otelDest);
        } else {
          console.warn(`WARNING: @opentelemetry dependencies not found at ${otelSrc}`);
        }
      }

      // Patch for missing styled-jsx in top-level node_modules
      const topLevelStyledJsx = path.join(buildDir, 'node_modules', 'styled-jsx');
      if (!(await fs.pathExists(topLevelStyledJsx))) {
        console.log('styled-jsx missing in top level node_modules. Attempting to locate and copy...');
        try {
          // Find styled-jsx directory deep inside
          const { stdout } = await execAsync(`find . -type d -name styled-jsx | head -n 1`, { cwd: buildDir });
          const foundPath = stdout.trim();
          if (foundPath) {
            console.log(`Found styled-jsx at ${foundPath}, copying to top level.`);
            await execAsync(`cp -R "${foundPath}" "${topLevelStyledJsx}"`, { cwd: buildDir });
          }
        } catch (e) {
          console.warn('Failed to patch styled-jsx', e);
        }
      }
    }

    if (!useStandalone) {
      // OLD LOGIC
      if (entryPoints.length === 0) {
        console.warn(`No specific entry points found for group ${groupName}. Tracing runtime only.`);
      }

      if (await fs.pathExists(path.join(this.projectDir, 'runner.js'))) {
        entryPoints.push(path.join(this.projectDir, 'runner.js'));
      }

      // Explicitly add server.js if it exists (e.g. from standalone output)
      if (await fs.pathExists(path.join(this.projectDir, 'server.js'))) {
        entryPoints.push(path.join(this.projectDir, 'server.js'));
      }

      // 2. Bundle dependencies
      // Prefer @vercel/nft to copy a minimal set of files (smaller images, faster builds).
      // Set KNATIVE_NEXT_ENABLE_NFT=false to force the fallback behavior.
      let traced = false;
      const enableNft = process.env.KNATIVE_NEXT_ENABLE_NFT !== 'false';

      if (enableNft && entryPoints.length > 0) {
        try {
          const result = await nodeFileTrace(entryPoints, {
            base: this.projectDir,
            processCwd: this.projectDir,
          });

          for (const file of result.fileList) {
            const src = path.join(this.projectDir, file);
            const dest = path.join(buildDir, file);
            await fs.copy(src, dest);
          }
          traced = true;
        } catch (e) {
          console.warn(`Dependency tracing failed for ${groupName}, falling back to full copy.`, e);
        }
      }

      if (!traced) {
        const localNodeModules = path.join(this.projectDir, 'node_modules');
        const rootNodeModules = path.join(this.projectDir, '../../node_modules');

        if (await fs.pathExists(localNodeModules)) {
          await execAsync(`cp -R "${localNodeModules}" "${path.join(buildDir, 'node_modules')}"`);
        } else if (await fs.pathExists(rootNodeModules)) {
          await execAsync(`cp -R "${rootNodeModules}" "${path.join(buildDir, 'node_modules')}"`);
        } else {
          console.warn('Could not find node_modules to copy!');
        }

        // Copy .next/server
        await fs.copy(path.join(this.nextDir, 'server'), path.join(buildDir, '.next', 'server'));

        // Copy entry points if they are not in .next/server
        for (const ep of entryPoints) {
          const rel = path.relative(this.projectDir, ep);
          if (!rel.startsWith('.next') && !rel.startsWith('node_modules')) {
            await fs.copy(ep, path.join(buildDir, rel));
          }
        }
      }

      // 4. Copy Runtime Extras
      const extras = ['public', 'next.config.js', 'package.json', 'runner.js', 'cache-handler.js'];
      for (const extra of extras) {
        const src = path.join(this.projectDir, extra);
        if (await fs.pathExists(src)) {
          await fs.copy(src, path.join(buildDir, extra));
        }
      }

      // Ensure .next/static is copied
      const staticSrc = path.join(this.nextDir, 'static');
      const staticDest = path.join(buildDir, '.next', 'static');
      await fs.ensureDir(path.join(buildDir, '.next'));

      // Use fs.copy for cross-platform compatibility
      try {
        await fs.copy(staticSrc, staticDest);
      } catch (e) {
        console.warn('Failed to copy .next/static', e);
      }

      // Copy routes-manifest.json and other required manifests
      const manifests = [
        'routes-manifest.json',
        'prerender-manifest.json',
        'server/pages-manifest.json',
        'server/middleware-manifest.json',
      ];
      for (const m of manifests) {
        const src = path.join(this.nextDir, m);
        if (await fs.pathExists(src)) {
          await fs.copy(src, path.join(buildDir, '.next', m));
        }
      }
    } // End !useStandalone

    // 5. Generate Dockerfile
    const dockerfileContent = `
# Use a build argument to configure the Node.js version (default: 18)
ARG NODE_VERSION=18
FROM node:\${NODE_VERSION}-alpine
WORKDIR /app
ENV NODE_ENV production
ENV NEXT_TELEMETRY_DISABLED 1

# Add nextjs user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy all files
COPY . .

# Set permissions
RUN chown -R nextjs:nodejs /app

USER nextjs

EXPOSE 3000
ENV PORT 3000
ENV HOSTNAME "0.0.0.0"

CMD ["node", "${serverJsPath}"]
`;
    await fs.writeFile(path.join(buildDir, 'Dockerfile'), dockerfileContent);

    // 6. Build Docker Image
    const imageName = buildGroupImageName(this.baseImageName, groupName);

    try {
      await execAsync(`/usr/local/bin/minikube image build -t ${imageName} .`, { cwd: buildDir });
    } catch (e) {
      console.error(`Failed to build image for ${groupName}`, e);
      throw e;
    }

    return imageName;
  }
}
