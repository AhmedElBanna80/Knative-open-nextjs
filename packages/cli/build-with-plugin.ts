/**
 * Bun Build Script with Plugin
 * 
 * This script uses Bun.build() API to apply build-time transformations
 * before compiling to bytecode. The --plugin CLI flag doesn't work for
 * bun build --compile, so we need to use the JavaScript API.
 */

// Define the path-fixer plugin inline
const pathFixerPlugin = {
    name: "path-fixer",
    setup(build) {
        console.log("DEBUG: path-fixer plugin setup called at BUILD TIME");

        // Transform the bun-runner.ts to use runtime paths
        build.onLoad({ filter: /bun-runner\.ts$/ }, async (args) => {
            console.log("DEBUG: Transforming bun-runner.ts at BUILD TIME:", args.path);

            let contents = await Bun.file(args.path).text();

            // Replace createRequire(import.meta.url) with createRequire based on cwd
            // At runtime, process.cwd() will be /app (set by WORKDIR in Dockerfile)
            contents = contents.replace(
                /const require = createRequire\(import\.meta\.url\);/g,
                `// Patched by bun-path-fixer for runtime path resolution
const require = createRequire(process.cwd() + '/package.json');`
            );

            console.log("DEBUG: bun-runner.ts transformed at BUILD TIME");

            return {
                contents,
                loader: "ts",
            };
        });
    },
};

// Get the entrypoint from argv (default: bun-runner.ts)
const entrypoint = process.argv[2] || "bun-runner.ts";
const outfile = process.argv[3] || "server";

console.log(`Building ${entrypoint} -> ${outfile}...`);

// First, bundle with plugins to transform the code
const bundleResult = await Bun.build({
    entrypoints: [entrypoint],
    outdir: "./bundle-temp",
    target: "bun",
    minify: true,
    sourcemap: "none",
    plugins: [pathFixerPlugin],
    external: ["*"], // Externalize all dependencies
});

if (!bundleResult.success) {
    console.error("Bundle failed:", bundleResult.logs);
    process.exit(1);
}

console.log("Bundle successful. Now compiling to bytecode binary...");

// Get the bundled file path
const bundledFile = "./bundle-temp/bun-runner.js";

// Now compile the bundled output to bytecode
const proc = Bun.spawn([
    "bun", "build",
    "--compile",
    "--bytecode",
    "--minify",
    "--sourcemap=none",
    "--target=bun-linux-x64",
    "--external:*",
    "--external:next/*",
    "--external:next/dist/server/lib/start-server",
    bundledFile,
    "--outfile", outfile
], {
    stdout: "inherit",
    stderr: "inherit",
});

const exitCode = await proc.exited;

// Cleanup temp bundle
await Bun.$`rm -rf ./bundle-temp`.quiet();

if (exitCode !== 0) {
    console.error("Compile failed with exit code:", exitCode);
    process.exit(exitCode);
}

console.log(`Successfully compiled: ${outfile}`);
