# Knative Next.js Framework - Monorepo

A complete framework for deploying Next.js applications on Knative with Fluid Compute characteristics.

## Structure

```
knative-next-framework/
├── packages/
│   └── framework/          # Core framework (compiler, runtime, infrastructure)
│       ├── compiler/       # CLI tool to split Next.js apps into Knative services
│       ├── runtime/        # Runtime clients (Cerbos, MinIO, Postgres)
│       └── infrastructure/ # Kubernetes manifests (Cerbos, MinIO, Neon)
└── apps/
    └── file-manager/       # Example Next.js 16 app with Tailwind CSS
```

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Build the Framework

```bash
npm run build --workspace=packages/framework
```

### 3. Deploy Infrastructure (Kubernetes Required)

```bash
# Deploy Cerbos
kubectl apply -f packages/framework/infrastructure/cerbos/

# Deploy MinIO
kubectl apply -f packages/framework/infrastructure/minio/

# Deploy Postgres
kubectl apply -f packages/framework/infrastructure/postgres/
```

### 4. Build the File Manager App

```bash
cd apps/file-manager
npm run build
```

### 5. Compile for Knative

```bash
node packages/framework/dist/compiler/index.js \
  --dir apps/file-manager \
  --output ./manifests \
  --image your-registry/file-manager:latest
```

### 6. Deploy to Knative

```bash
kubectl apply -f ./manifests
```

## Features

- ✅ **Strict App Router**: Enforces Next.js App Router with PPR
- ✅ **Fluid Compute**: High concurrency, scale-to-zero
- ✅ **Authorization**: Cerbos integration
- ✅ **Storage**: MinIO S3-compatible object storage
- ✅ **Database**: Self-hosted Postgres

- ✅ **Monorepo**: Turborepo for efficient builds

## File Manager App

The example app demonstrates:
- File upload to MinIO
- File listing from MinIO
- Metadata storage in Postgres
- Beautiful Tailwind CSS UI
- Server Actions for mutations

## Development

```bash
# Run File Manager in dev mode
npm run dev --workspace=apps/file-manager

# Build all packages
npm run build
```

## Advanced Builder (Bun + Bytecode)

For production deployments, we use a custom Go-based builder that leverages Bun to compile Next.js applications into single-file executables with **bytecode optimization**.

### Features
- **Bytecode Compilation**: Protects source code and improves startup time (<100ms).
- **Distroless Runtime**: Uses `gcr.io/distroless/cc-debian12` for a minimal, secure footprint.
- **Optimized Size**: Docker images reduced to **~222MB** (from >500MB) via:
    - **NFT Tracing**: Only includes used dependencies.
    - **Auto-Shimming**: Automatically fixes Bun resolution for external modules.
    - **Aggressive Pruning**: Removes unused platform binaries and dev artifacts.
- **Cross-Platform**: Build locally on macOS (ARM64) for GKE (Linux/AMD64).

See [packages/knative-next-builder/README.md](./packages/knative-next-builder/README.md) for full architecture details.

### Usage

**Build for Local (macOS ARM64):**
```bash
# From packages/knative-next-builder
go run cmd/builder/main.go \
  -dir ../../apps/file-manager \
  -output dist-deploy \
  -target bun-darwin-arm64
```

**Build for Local (macOS AMD64):**
```bash
go run cmd/builder/main.go \
  -dir ../../apps/file-manager \
  -output dist-deploy \
  -target bun-darwin-x64
```

**Build for GKE (Linux AMD64):**
```bash
# Used by Cloud Build / Deploy Scripts
go run cmd/builder/main.go \
  -dir ../../apps/file-manager \
  -output dist-deploy \
  -target bun-linux-x64
```
