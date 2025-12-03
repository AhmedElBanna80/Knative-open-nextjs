import fs from 'fs';
import path from 'path';
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';

const [, , entryFile, outputDir, ...restArgs] = process.argv;

if (!entryFile || !outputDir) {
    console.error('Usage: ts-node scripts/isolate.ts <entry-file> <output-dir>');
    process.exit(1);
}

// Parse arguments manually
let imageName = '';
let serviceName = '';
let assetPrefix = '';

for (let i = 0; i < restArgs.length; i++) {
    if (restArgs[i] === '--image') imageName = restArgs[i + 1];
    if (restArgs[i] === '--service') serviceName = restArgs[i + 1];
    if (restArgs[i] === '--asset-prefix') assetPrefix = restArgs[i + 1];
}

const absEntryFile = path.resolve(entryFile);
const absOutputDir = path.resolve(outputDir);
const nftFile = absEntryFile + '.nft.json';

if (!existsSync(nftFile)) {
    console.error(`NFT file not found: ${nftFile}`);
    process.exit(1);
}

console.log(`Reading NFT trace from: ${nftFile}`);
const nftContent = JSON.parse(readFileSync(nftFile, 'utf-8'));
const files = nftContent.files || [];
const nftDir = path.dirname(nftFile);

console.log(`Found ${files.length} files to trace.`);

// Helper to copy file preserving structure
function copyFile(src: string, destRoot: string, relativePath: string) {
    const destPath = path.join(destRoot, relativePath);
    const destDir = path.dirname(destPath);
    if (!existsSync(destDir)) {
        mkdirSync(destDir, { recursive: true });
    }
    if (existsSync(src)) {
        cpSync(src, destPath);
    } else {
        console.warn(`Warning: File not found ${src}`);
    }
}

// 1. Copy traced files
files.forEach((file: string) => {
    // 'file' is relative to nftDir
    const srcPath = path.resolve(nftDir, file);

    // We need to determine the relative path from the "standalone root" or "project root"
    // to keep the structure consistent.
    // Let's assume we want to preserve the path relative to the project root.
    // But we are running this script from project root.

    // A simple heuristic: calculate relative path from CWD (project root).
    const relPath = path.relative(process.cwd(), srcPath);

    // However, the standalone build might have files outside CWD? (e.g. /tmp) - unlikely for Next.js standalone.
    // But `standalone` folder itself is inside `.next/standalone`.

    // If we want the output to be runnable, we should probably mirror the `standalone` folder structure.
    // The `entryFile` is inside `.next/standalone/...`.

    // Let's find the `standalone` directory in the path of `entryFile`.
    const standaloneMarker = '.next/standalone/';
    const markerIndex = absEntryFile.indexOf(standaloneMarker);

    if (markerIndex === -1) {
        console.error('Entry file must be inside a .next/standalone directory.');
        process.exit(1);
    }

    const standaloneRoot = absEntryFile.substring(0, markerIndex + standaloneMarker.length);

    // Now calculate relative path of the srcPath from standaloneRoot
    const relToStandalone = path.relative(standaloneRoot, srcPath);

    // If the file is OUTSIDE standalone root (e.g. original source files?), we might have an issue.
    // But standalone build usually copies everything into standalone.
    // Exception: `public` folder or `static` folder might be symlinked or outside?
    // The NFT usually points to files *inside* standalone if they were copied there, OR original files.

    // Let's try to copy to `outputDir` using `relToStandalone`.
    // If `relToStandalone` starts with `..`, it means it's outside standalone root.

    if (relToStandalone.startsWith('..')) {
        console.warn(`Skipping file outside standalone root: ${relToStandalone}`);
        return;
    }

    copyFile(srcPath, absOutputDir, relToStandalone);
});

// 2. Find and copy server.js
// We assume server.js is at `apps/<app-name>/server.js` or `server.js` relative to standalone root.
// We can try to find it by walking up from the entry file until we hit standalone root.
// Or just look for common locations.

const standaloneMarker = '.next/standalone/';
const markerIndex = absEntryFile.indexOf(standaloneMarker);
const standaloneRoot = absEntryFile.substring(0, markerIndex + standaloneMarker.length);

// Try to find server.js
// For monorepo: apps/file-manager/server.js
// For single repo: server.js
// We can guess based on the entry file path.
// Entry: .../standalone/apps/file-manager/.next/...
// So we look for .../standalone/apps/file-manager/server.js

const relativeEntryDir = path.dirname(path.relative(standaloneRoot, absEntryFile));
// e.g. apps/file-manager/.next/server/app/dashboard

const parts = relativeEntryDir.split(path.sep);
// We look for the part that is the app root.
// Usually it's before `.next`.
const nextIndex = parts.indexOf('.next');
let appRootRel = '';
if (nextIndex !== -1) {
    appRootRel = parts.slice(0, nextIndex).join(path.sep);
}

const serverJsRel = path.join(appRootRel, 'server.js');
const serverJsPath = path.join(standaloneRoot, serverJsRel);

if (existsSync(serverJsPath)) {
    console.log(`Found server.js at ${serverJsRel}`);
    copyFile(serverJsPath, absOutputDir, serverJsRel);

    // Patch server.js to respect ASSET_PREFIX
    const serverJsDest = path.join(absOutputDir, serverJsRel);
    let serverJsContent = readFileSync(serverJsDest, 'utf-8');
    // Replace "assetPrefix":"" with "assetPrefix":"VALUE"
    // We use a regex to be safe about spacing
    if (assetPrefix) {
        serverJsContent = serverJsContent.replace(/"assetPrefix"\s*:\s*""/, `"assetPrefix":"${assetPrefix}"`);
        console.log(`Patched server.js with hardcoded assetPrefix: ${assetPrefix}`);
        writeFileSync(serverJsDest, serverJsContent);
    }

    // 2.1 Copy all node_modules from standalone
    // The standalone build already prunes node_modules to production dependencies.
    // Copying all of them ensures server.js has everything it needs (next, react, styled-jsx, etc.)
    const nodeModulesRel = 'node_modules';
    const nodeModulesSrc = path.join(standaloneRoot, nodeModulesRel);

    if (existsSync(nodeModulesSrc)) {
        console.log(`Copying node_modules from ${nodeModulesSrc}`);
        const nodeModulesDest = path.join(absOutputDir, nodeModulesRel);
        // Use recursive copy.
        // Note: This might overwrite files copied by NFT, which is fine as they are identical.
        cpSync(nodeModulesSrc, nodeModulesDest, { recursive: true, force: true });
    } else {
        console.warn(`Could not find node_modules at ${nodeModulesSrc}`);
    }

    // 2.2 Copy .next directory (manifests, etc.)
    // server.js needs the build manifests (BUILD_ID, routes-manifest.json, etc.)
    // We copy the .next directory from the app root in standalone.
    const dotNextRel = path.join(appRootRel, '.next');
    const dotNextSrc = path.join(standaloneRoot, dotNextRel);

    if (existsSync(dotNextSrc)) {
        console.log(`Copying .next directory from ${dotNextSrc}`);
        const dotNextDest = path.join(absOutputDir, dotNextRel);
        cpSync(dotNextSrc, dotNextDest, { recursive: true, force: true });

        // 2.3 Patch client-reference-manifest files to fix assetPrefix for dynamic imports
        if (assetPrefix) {
            console.log(`Patching client-reference-manifest files with assetPrefix...`);
            try {
                const serverDir = path.join(dotNextDest, 'server');
                if (existsSync(serverDir)) {
                    // Recursively find all client-reference-manifest.js files
                    const findManifestFiles = (dir: string): string[] => {
                        const results: string[] = [];
                        const entries = fs.readdirSync(dir, { withFileTypes: true });
                        for (const entry of entries) {
                            const fullPath = path.join(dir, entry.name);
                            if (entry.isDirectory()) {
                                results.push(...findManifestFiles(fullPath));
                            } else if (entry.name.endsWith('client-reference-manifest.js')) {
                                results.push(fullPath);
                            }
                        }
                        return results;
                    };

                    const manifestFiles = findManifestFiles(serverDir);

                    for (const manifestFile of manifestFiles) {
                        let content = readFileSync(manifestFile, 'utf-8');
                        const before = content;

                        // Replace all instances of "/_next/static/" with "static/" (relative)
                        // This removes the /_next prefix and leading slash so Next.js joins with assetPrefix correctly
                        content = content.replaceAll('"/_next/static/', '"static/');

                        // For entryJSFiles and entryCSSFiles, ensure they are relative "static/..."
                        // They usually appear as "static/chunks/..." which is already relative.
                        // We just ensure we don't accidentally make them absolute.
                        content = content.replaceAll('"static/chunks/', '"static/chunks/');
                        content = content.replaceAll('"static/css/', '"static/css/');
                        content = content.replaceAll('"static/media/', '"static/media/');

                        if (content !== before) {
                            writeFileSync(manifestFile, content);
                        }
                    }
                    console.log(`Patched ${manifestFiles.length} client-reference-manifest files`);
                }
            } catch (e) {
                console.warn(`Warning: Could not patch client-reference-manifest files:`, e);
            }
        }
    } else {
        console.warn(`Could not find .next directory at ${dotNextSrc}`);
    }
} else {
    console.warn(`Could not find server.js at ${serverJsRel}. You might need to add a custom runner.`);
}

// 3. Create Dockerfile
// We need to know where server.js ended up.
const serverJsDest = path.join(absOutputDir, serverJsRel);
const serverJsRelForDocker = serverJsRel; // path relative to WORKDIR

const dockerfileContent = `
FROM node:18-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production
ENV PORT=3000
CMD ["node", "${serverJsRelForDocker}"]
`;

writeFileSync(path.join(absOutputDir, 'Dockerfile'), dockerfileContent.trim());

// 4. Generate Knative Service Config (if args provided)
if (imageName && serviceName) {
    const ksvcContent = `
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: ${serviceName}
  namespace: default
spec:
  template:
    metadata:
      annotations:
        client.knative.dev/user-image: ${imageName}
        deploy/timestamp: "${new Date().toISOString()}"
    spec:
      containers:
        - image: ${imageName}
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 3000
          env:
            - name: HOSTNAME
              value: "0.0.0.0"
            - name: DATABASE_URL
              value: "postgresql://postgres:postgres@postgres:5432/filemanager"
            ${assetPrefix ? `- name: ASSET_PREFIX
              value: "${assetPrefix}"` : ''}
`;
    writeFileSync(path.join(absOutputDir, 'ksvc.yaml'), ksvcContent.trim());
    console.log(`Generated ksvc.yaml for service: ${serviceName}`);
}

console.log(`Isolation complete. Output at: ${absOutputDir}`);
