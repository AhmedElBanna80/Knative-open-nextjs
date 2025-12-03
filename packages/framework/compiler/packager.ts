import fs from 'fs-extra';
import path from 'path';
import { RouteGroup } from './splitter';

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

        console.log(`Packaging service: ${groupName}...`);

        // 1. Identify Entry Points
        // For a Next.js page, the entry point is usually in .next/server/pages/...
        // We need to find the actual JS file for the page.
        const entryPoints: string[] = [];

        for (const pagePath of group.paths) {
            // Convert page path to file path
            // e.g. / -> index.js
            // e.g. /dashboard -> dashboard.js
            // e.g. /blog/[slug] -> blog/[slug].js

            // 1. Pages Router
            let pagesPath = pagePath;
            if (pagesPath === '/') pagesPath = '/index';

            // 2. App Router
            let appPath = pagePath;
            if (appPath === '/') appPath = ''; // path.join handles empty string by ignoring it, so app/ + '' + /page.js -> app/page.js

            // Try different extensions/locations
            const candidates = [
                // Pages Router
                path.join(this.nextDir, 'server', 'pages', `${pagesPath}.js`),
                path.join(this.nextDir, 'server', 'pages', `${pagesPath}.html`),

                // App Router
                path.join(this.nextDir, 'server', 'app', appPath, 'page.js'),
            ];

            for (const c of candidates) {
                if (await fs.pathExists(c)) {
                    entryPoints.push(c);
                    break;
                }
            }
        }

        if (entryPoints.length === 0) {
            console.warn(`No specific entry points found for group ${groupName}. Tracing runtime only.`);
            // Fallback: trace runner.js to ensure we have a working server
            // We assume runner.js is in the project root (or will be copied there)
            // But for tracing we need a file that exists. 
            // If runner.js is not yet in projectDir (it's copied during deploy-app), we might fail.
            // But we are running this from the monorepo context.
            // Let's assume the user has a server.js or we trace the framework's runner.

            // If we can't find a page entry point, it might be a static asset route (like favicon.ico).
            // In that case, we still need the Next.js server to serve it.
            // So we should trace the server.
        }

        // Always add runner.js (or equivalent) to entry points to ensure runtime dependencies are present
        // If runner.js exists in projectDir
        if (await fs.pathExists(path.join(this.projectDir, 'runner.js'))) {
            entryPoints.push(path.join(this.projectDir, 'runner.js'));
        } else {
            // If runner.js doesn't exist, maybe we are in a mode where we rely on next-server?
            // But the Dockerfile uses runner.js.
            // In the Makefile, runner.js is copied BEFORE building the image but AFTER building the app.
            // The compiler runs AFTER building the app.
            // So runner.js might NOT be there yet if we run compiler manually?
            // Wait, Makefile:
            // 1. npm run build (framework & app)
            // 2. cp runner.js to app
            // 3. docker build (app)
            // 4. node compiler

            // So runner.js SHOULD be there when compiler runs in the Makefile flow.
            // But I ran it manually without copying runner.js.
            // I should copy runner.js to the app dir for my manual test.
        }

        // 2. Trace Dependencies
        let fileList: string[] = [];
        let traceFailed = false;

        try {
            const { exec } = require('child_process');
            const util = require('util');
            const execAsync = util.promisify(exec);

            const tracerPath = path.join(__dirname, 'tracer.js');
            // Escape paths
            const entryPointsArgs = entryPoints.map(e => `"${e}"`).join(' ');
            const cmd = `node "${tracerPath}" "${this.projectDir}" ${entryPointsArgs}`;

            console.log(`Tracing dependencies for ${groupName}...`);
            const { stdout } = await execAsync(cmd, { maxBuffer: 1024 * 1024 * 50 }); // 50MB buffer
            fileList = JSON.parse(stdout);
        } catch (e) {
            console.warn(`Tracing failed for group ${groupName}. Falling back to full copy.`, e);
            traceFailed = true;
        }

        // 3. Copy Files
        if (!traceFailed) {
            for (const file of fileList) {
                const src = path.join(this.projectDir, file);
                const dest = path.join(buildDir, file);
                await fs.copy(src, dest);
            }
        } else {
            // Fallback: Copy node_modules and .next/server (we already copy .next/static later)
            console.log(`Copying full node_modules for ${groupName}...`);

            const localNodeModules = path.join(this.projectDir, 'node_modules');
            const rootNodeModules = path.join(this.projectDir, '../../node_modules'); // Assumption for monorepo

            if (await fs.pathExists(localNodeModules)) {
                await fs.copy(localNodeModules, path.join(buildDir, 'node_modules'));
            } else if (await fs.pathExists(rootNodeModules)) {
                console.log('Local node_modules not found, copying from root...');
                await fs.copy(rootNodeModules, path.join(buildDir, 'node_modules'));
            } else {
                console.warn('Could not find node_modules to copy!');
            }

            // Copy .next/server
            await fs.copy(path.join(this.nextDir, 'server'), path.join(buildDir, '.next', 'server'));

            // Copy entry points if they are not in .next/server (e.g. runner.js)
            for (const ep of entryPoints) {
                const rel = path.relative(this.projectDir, ep);
                if (!rel.startsWith('.next') && !rel.startsWith('node_modules')) {
                    await fs.copy(ep, path.join(buildDir, rel));
                }
            }
        }

        // 4. Copy Runtime Extras (runner.js, public folder, etc.)
        // These might not be caught by tracing if they are not directly imported by the page
        const extras = ['public', 'next.config.js', 'package.json', 'runner.js', 'cache-handler.js'];
        for (const extra of extras) {
            const src = path.join(this.projectDir, extra);
            if (await fs.pathExists(src)) {
                await fs.copy(src, path.join(buildDir, extra));
            }
        }

        // Ensure .next/static is copied (client-side chunks)
        // Tracing server files might not catch all client chunks if they are dynamically loaded?
        // For safety, let's copy the whole .next/static folder. It's usually not too huge compared to node_modules.
        // Or we could try to be smarter.
        // Use native cp for better performance/stability with large folders
        const staticSrc = path.join(this.nextDir, 'static');
        const staticDest = path.join(buildDir, '.next', 'static');
        await fs.ensureDir(path.join(buildDir, '.next'));

        try {
            const { exec } = require('child_process');
            const util = require('util');
            const execAsync = util.promisify(exec);
            await execAsync(`cp -r "${staticSrc}" "${staticDest}"`);
        } catch (e) {
            console.warn('Failed to copy .next/static via cp, falling back to fs.copy', e);
            await fs.copy(staticSrc, staticDest);
        }

        // Copy routes-manifest.json and other required manifests
        const manifests = ['routes-manifest.json', 'prerender-manifest.json', 'server/pages-manifest.json', 'server/middleware-manifest.json'];
        for (const m of manifests) {
            const src = path.join(this.nextDir, m);
            if (await fs.pathExists(src)) {
                await fs.copy(src, path.join(buildDir, '.next', m));
            }
        }

        // 5. Generate Dockerfile
        const dockerfileContent = `
FROM node:18-alpine
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

CMD ["node", "runner.js"]
`;
        await fs.writeFile(path.join(buildDir, 'Dockerfile'), dockerfileContent);

        // 6. Build Docker Image
        // Derive image name from base.
        // If base is "dev.local/file-manager:latest", we want "dev.local/file-manager-index:latest"
        // If base is "my-app", we want "my-app-index"

        let imageName = '';
        const separator = this.baseImageName.includes(':') ? ':' : '';
        const [base, tag] = this.baseImageName.split(':');

        if (tag) {
            imageName = `${base}-${groupName}:${tag}`;
        } else {
            imageName = `${base}-${groupName}`;
        }

        // We will return the image name and let the caller handle the actual docker build command execution?
        // Or we do it here. Doing it here is cleaner for the "Packager" abstraction.

        console.log(`Building Docker image ${imageName}...`);
        const { exec } = require('child_process');
        const util = require('util');
        const execAsync = util.promisify(exec);

        try {
            await execAsync(`docker build -t ${imageName} .`, { cwd: buildDir });
        } catch (e) {
            console.error(`Failed to build image for ${groupName}`, e);
            throw e;
        }

        return imageName;
    }
}
