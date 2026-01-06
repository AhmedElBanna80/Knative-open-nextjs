# Knative Next.js Builder

A high-performance builder for deploying Next.js applications to Knative/Kubernetes using [Bun](https://bun.sh) as the runtime and compiler.

## Features

- **Single Binary Compilation**: Compiles Next.js standalone server into a single executable using `bun build --compile`.
- **Distroless Runtime**: Deployment images are based on `gcr.io/distroless/cc-debian12`, minimizing attack surface and size.
- **Optimized Dependency Management**:
    - **NFT Tracing**: Uses Next.js `.nft.json` traces to automatically identify and copy only the required `node_modules`.
    - **Aggressive Pruning**: Removes platform-specific binaries (e.g., `pkg-darwin` on Linux), `.d.ts` files, source maps, and other dev artifacts.
    - **Auto-Shimming**: Automatically creates `index.js` proxies for packages with deep entry points or `exports` maps that Bun's binary runtime might miss.

## Architecture

### 1. Build Phase
The builder operates on the output of `next build` (specifically the `standalone` mode).

1.  **Analysis**: Scans the project structure.
2.  **Copy**: Moves the `standalone` output to a staging directory (`dist-deploy`).
3.  **Trace Resolution**: Parses `.next/server/**/*.nft.json` to find all recursive dependencies not included in `standalone` and copies them.
4.  **Patching**:
    - **Internals**: Fixes Next.js internal paths to work within a compiled binary boundaries.
    - **Externals**: Scans `node_modules` for packages where `main` points to a subdirectory (e.g., `dist/index.js`) and creates root `index.js` shims to ensure resolution compatibility.
5.  **Pruning**:
    - Removes non-Linux binaries (e.g., `darwin-arm64`, `win32-x64`).
    - Removes TypeScript definitions, tests, and docs.
    - *Exception*: Retains `typescript` package as Next.js verifies it at runtime during boot.
6.  **Compilation**:
    - Runs `bun build --compile --minify --bytecode` to produce the `server` binary.
    - **Note**: Dependencies are marked `--external:*`. They are **not bundled** into the binary but are loaded from the optimized `node_modules` folder at runtime. This preserves compatibility with native modules (like `pg`, `sharp`) and complex dynamic requires.

### 2. Runtime Phase
The final Docker image is constructed from the `dist-deploy` directory.

- **Base Image**: `gcr.io/distroless/cc-debian12` (~30MB).
- **Content**:
    - `server` binary (compiled runner).
    - `.next` static assets (manifests, HTML, etc).
    - `node_modules` (pruned, production-only).
    - `public` assets.
- **Performance**:
    - **Size**: ~222MB (amd64), ~290MB (arm64). Reduced from >500MB.
    - **Startup**: <100ms.

## Usage

### Local Build
```bash
./bin/builder -dir ../../apps/file-manager -output dist-deploy -target bun-linux-arm64
```

### Docker Build
```dockerfile
FROM gcr.io/distroless/cc-debian12
WORKDIR /app
COPY . .
CMD ["./server"]
```

## Troubleshooting

### "Cannot find module..."
- **Cause**: Bun's binary compiler might miss specific entry points.
- **Fix**: The `PatchExternalModules` function usually handles this. If a new package fails, check if it needs a manual shim in `ShimRuntimeModules` or if the auto-shim logic needs adjustment.

### "GLIBC not found"
- **Cause**: Running a binary compiled for a different libc version.
- **Fix**: Ensure the build environment (e.g., Debian 12 based) matches the runtime (Distroless cc-debian12).
