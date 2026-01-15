package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/knative-next/cli/config"
	"knative.dev/distribution-builder/generator"
	"knative.dev/distribution-builder/runner"
	"knative.dev/distribution-builder/runnergen"
)

func main() {
	dryRun := flag.Bool("dry-run", false, "Simulate deployment")
	skipAssets := flag.Bool("skip-assets", false, "Skip static asset offloading")
	flag.Parse()

	rootDir, _ := os.Getwd()
	configScript := filepath.Join(rootDir, "scripts", "print-config.ts")

	// 1. Load Config
	fmt.Println("📖 Loading Configuration...")
	cfg, err := config.LoadConfig(configScript)
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	fmt.Printf("🚀 Starting Deployment for: %s [Mode: %s]\n", cfg.Name, cfg.DistributionMode)
	if *dryRun {
		fmt.Println("🔍 DRY RUN ENABLED")
	}

	// 2. Static Asset Offloading
	if !*skipAssets {
		fmt.Println("\n📦 Offloading Static Assets...")
		// In a real scenario, we would import the offloader package directly.
		// For now, we reuse the existing binary to match the previous architecture, or import logic.
		// Let's call the binary for simplicity in this migration step (or we can refactor later).
		// Actually, executing binary is cleaner than dealing with go.mod replace directives right now.
		offloaderBin := filepath.Join(rootDir, "packages/static-offloader/static-offloader")
		
		args := []string{"--root", rootDir}
		if *dryRun {
			args = append(args, "--dry-run")
		}

		cmd := exec.Command(offloaderBin, args...)
		cmd.Stderr = os.Stderr
		cmd.Stdout = os.Stdout // Stream output

		// Pipe Config JSON to Stdin
		stdin, _ := cmd.StdinPipe()
		go func() {
			defer stdin.Close()
			json.NewEncoder(stdin).Encode(cfg.Infrastructure)
		}()

		if err := cmd.Run(); err != nil {
			log.Fatalf("Static Offloader Failed: %v", err)
		}
	} else {
		fmt.Println("⏩ Skipping Static Assets")
	}

	// 3. Application Build & Granular Distribution
	fmt.Println("\n🏗️  Building Application...")

	distDir := filepath.Join(rootDir, "dist-isolated")
	os.RemoveAll(distDir)
	os.MkdirAll(distDir, 0755)

	standaloneSrc := filepath.Join(rootDir, "apps/file-manager/.next/standalone")

	if cfg.DistributionMode == "monolith" {
		fmt.Printf("Copying Standalone Output from %s...\n", standaloneSrc)
		cpCmd := exec.Command("cp", "-R", standaloneSrc+"/", distDir)
		cpCmd.Stdout = os.Stdout
		cpCmd.Stderr = os.Stderr
		if err := cpCmd.Run(); err != nil {
			log.Fatalf("Failed to copy standalone files: %v", err)
		}
		
		patchServerJS(filepath.Join(distDir, "apps/file-manager/server.js"))
		generateDockerfile(distDir, "bun", "apps/file-manager/server.js")
		
		// Build & Deploy Monolith
		imageTag := fmt.Sprintf("%s/%s:latest", cfg.Infrastructure.DockerRegistry, cfg.Name)
		buildAndPushDocker(rootDir, distDir, imageTag, *dryRun)
		deployKnative(cfg.Name, imageTag, cfg, *dryRun)

	} else if cfg.DistributionMode == "page" || cfg.DistributionMode == "granular" {
		fmt.Println("🚀 Granular (Multi-Zone) Mode Active: Generating Zone Apps...")

		// 1. Source Discovery
		// Scan apps/file-manager/app (Source) instead of build output
		appName := "apps/file-manager"
		sourceAppDir := filepath.Join(rootDir, appName)
		appDir := filepath.Join(sourceAppDir, "src/app")
		
		gen := generator.NewGenerator(sourceAppDir, distDir)
		
		// Collect Routes
		var routes []string
		err := filepath.Walk(appDir, func(path string, info os.FileInfo, err error) error {
			if err != nil { return err }
			if !info.IsDir() && (info.Name() == "page.js" || info.Name() == "page.tsx") {
				relPath, _ := filepath.Rel(appDir, filepath.Dir(path))
				if relPath == "." { relPath = "home" }
				routes = append(routes, relPath)
			}
			return nil
		})
		if err != nil {
			log.Fatalf("Failed to scan routes: %v", err)
		}

		fmt.Printf("found %d routes: %v\n", len(routes), routes)

		// 2. Parallel Processing
		// We use a semaphore to limit concurrency (optional, but good for build resource safety)
		// Let's use 3 concurrent builds for now.
		concurrency := 3
		sem := make(chan struct{}, concurrency)
		errChan := make(chan error, len(routes))
		
		for _, routeName := range routes {
			// Determine Service Name
			sanitizedRoute := strings.ReplaceAll(routeName, "/", "-")
			sanitizedRoute = strings.ToLower(sanitizedRoute)
			serviceName := fmt.Sprintf("%s-%s", cfg.Name, sanitizedRoute)

			// DEBUG FILTER: Only processing home for verification
			if !strings.Contains(serviceName, "home") {
				continue
			}

			// Start Goroutine
			go func(rName, sName string) {
				sem <- struct{}{} // Acquire token
				defer func() { <-sem }() // Release token
				
				fmt.Printf("\n[Parallel] Processing Route: %s (Service: %s)\n", rName, sName)
				
				// A. Generate Zone App (Clone & Prune)
				zonePath, err := gen.GenerateZoneApp(cfg.Name, rName)
				if err != nil {
					fmt.Printf("❌ Failed to generate zone for %s: %v\n", rName, err)
					errChan <- err
					return
				}
				
				// B. Compile (Next Build)
				fmt.Printf("🏗️  Compiling Zone: %s...\n", sName)
				cmd := exec.Command("bun", "run", "build")
				cmd.Dir = zonePath
				// Redirect output to avoid mixed logs, or capture and print on error
				// cmd.Stdout = os.Stdout 
				// cmd.Stderr = os.Stderr
				// Make sure we set env vars if needed? 
				// We assume standard build works.
				if output, err := cmd.CombinedOutput(); err != nil {
					fmt.Printf("❌ Build failed for %s: %v\nOutput:\n%s\n", sName, err, string(output))
					errChan <- err
					return
				}
				
				// C. Bytecode Compilation Workflow (Phase 2.5)
				// Instead of just copying standalone, we use the runner package for:
				// 1. Copy Standalone + NFT Dependencies
				// 2. Shim Runtime Modules
				// 3. Prune unnecessary files
				// 4. Compile to bytecode binary
				
				deployDir := filepath.Join(zonePath, "dist-deploy")
				os.RemoveAll(deployDir)
				os.MkdirAll(deployDir, 0755)
				
				fmt.Printf("📦 Preparing deployment for %s...\\n", sName)
				
				// 1. Copy Standalone + NFT Dependencies
				if err := runner.CopyStandalone(zonePath, deployDir); err != nil {
					fmt.Printf("❌ Failed to copy standalone for %s: %v\\n", sName, err)
					errChan <- err
					return
				}
				
				// 2. Shim Runtime Modules (React, styled-jsx, etc.)
				if err := runner.ShimReactServerDom(zonePath, deployDir); err != nil {
					fmt.Printf("⚠️ Warning: React shim failed for %s: %v\\n", sName, err)
				}
				if err := runner.ShimRuntimeModules(zonePath, deployDir); err != nil {
					fmt.Printf("⚠️ Warning: Runtime shim failed for %s: %v\\n", sName, err)
				}
				
				// 3. Patch External Modules (auto-create index.js proxies)
				if err := runner.PatchExternalModules(deployDir); err != nil {
					fmt.Printf("⚠️ Warning: External module patching failed for %s: %v\\n", sName, err)
				}
				
				// 4. Prune node_modules (remove non-linux, .d.ts, .map, etc.)
				if err := runner.PruneNodeModules(deployDir); err != nil {
					fmt.Printf("⚠️ Warning: Prune failed for %s: %v\\n", sName, err)
				}
				
				// 5. Generate Custom Runner and Compile to Bytecode Binary
				// Using custom bun-runner.ts wrapper that uses startServer directly
				// This avoids the complex internal requires of server.js

				// Find relative app dir (where .next exists)
				var relativeAppDir string
				_ = filepath.Walk(deployDir, func(path string, info os.FileInfo, err error) error {
					if info != nil && info.Name() == "server.js" && !strings.Contains(path, "node_modules") {
						relDir, _ := filepath.Rel(deployDir, filepath.Dir(path))
						relativeAppDir = relDir
						return io.EOF
					}
					return nil
				})
				if relativeAppDir == "" {
					relativeAppDir = "."
				}
				
				// 5. Generate Custom Runner Wrapper (bun-runner.ts)
				nextConfig := map[string]interface{}{"output": "standalone"}
				_, err = runnergen.GenerateRunner(nextConfig, deployDir, relativeAppDir)
				if err != nil {
					fmt.Printf("❌ Failed to generate runner for %s: %v\n", sName, err)
					errChan <- err
					return
				}
				
				// 5.5 Copy build script for Bun.build() API with plugins
				buildScriptDst := filepath.Join(deployDir, "build-with-plugin.ts")
				// Embed the build script inline for reliability
				buildScriptContent := `// Build script using Bun.build() API with plugins for build-time transformation
const pathFixerPlugin = {
  name: "path-fixer",
  setup(build) {
    console.log("DEBUG: path-fixer plugin setup at BUILD TIME");
    build.onLoad({ filter: /bun-runner\.ts$/ }, async (args) => {
      console.log("DEBUG: Transforming bun-runner.ts at BUILD TIME");
      let contents = await Bun.file(args.path).text();
      contents = contents.replace(
        /const require = createRequire\(import\.meta\.url\);/g,
        "const require = createRequire(process.cwd() + '/package.json');"
      );
      return { contents, loader: "ts" };
    });
  },
};

const entrypoint = process.argv[2] || "bun-runner.ts";
const outfile = process.argv[3] || "server";

console.log("Building " + entrypoint + " -> " + outfile + "...");

// Bundle with plugins to transform the code
const bundleResult = await Bun.build({
  entrypoints: [entrypoint],
  outdir: "./bundle-temp",
  target: "bun",
  minify: true,
  sourcemap: "none",
  plugins: [pathFixerPlugin],
  external: ["*"],
});

if (!bundleResult.success) {
  console.error("Bundle failed:", bundleResult.logs);
  process.exit(1);
}

console.log("Bundle successful. Compiling to bytecode...");

// Compile the bundled output to bytecode
const proc = Bun.spawn([
  "bun", "build", "--compile", "--bytecode", "--minify", "--sourcemap=none",
  "--target=bun-linux-x64", "--external:*", "--external:next/*",
  "--external:next/dist/server/lib/start-server",
  "./bundle-temp/bun-runner.js", "--outfile", outfile
], { stdout: "inherit", stderr: "inherit" });

const exitCode = await proc.exited;
await Bun.$` + "`rm -rf ./bundle-temp`" + `.quiet();
if (exitCode !== 0) process.exit(exitCode);
console.log("Successfully compiled: " + outfile);
`
				os.WriteFile(buildScriptDst, []byte(buildScriptContent), 0644)
				fmt.Printf("📦 Copied build script for %s\n", sName)
				
				// 6. Generate Multi-Stage Dockerfile (compiles bun-runner.ts inside container)
				fmt.Printf("📦 Generating multi-stage Dockerfile for %s...\n", sName)
				generateAlpineDockerfile(deployDir)
				
				// 7. Build and Push Docker Image (bytecode compilation happens inside Docker)
				
				// 7. Build and Push Docker Image
				imageTag := fmt.Sprintf("%s/%s:latest", cfg.Infrastructure.DockerRegistry, sName)
				buildAndPushDocker(rootDir, deployDir, imageTag, *dryRun)
				deployKnative(sName, imageTag, cfg, *dryRun)
				
				errChan <- nil
			}(routeName, serviceName)
		}
		
		// Wait for completion
		for i := 0; i < len(routes); i++ {
			if err := <-errChan; err != nil {
				fmt.Printf("⚠️  One of the builds failed: %v\n", err)
			}
		}
	}

	fmt.Println("\n✅ Deployment Complete!")
}

func patchServerJS(path string) {
	content, err := os.ReadFile(path)
	if err != nil {
		log.Fatalf("Failed to read server.js: %v", err)
	}
	targetLine := "process.env.__NEXT_PRIVATE_STANDALONE_CONFIG ="
	patch := `
if (process.env.ASSET_PREFIX) {
  console.log('Applying Runtime ASSET_PREFIX:', process.env.ASSET_PREFIX);
  nextConfig.assetPrefix = process.env.ASSET_PREFIX;
}
` + targetLine
	newContent := strings.Replace(string(content), targetLine, patch, 1)
	if err := os.WriteFile(path, []byte(newContent), 0644); err != nil {
		log.Fatalf("Failed to patch server.js: %v", err)
	}
}

func generateDockerfile(dir, runner, entrypoint string) {
	dockerfile := fmt.Sprintf(`FROM oven/bun:alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
CMD ["%s", "%s"]
`, runner, entrypoint)
	if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte(dockerfile), 0644); err != nil {
		log.Fatalf("Failed to write Dockerfile: %v", err)
	}
}

// generateAlpineDockerfile creates a multi-stage Dockerfile for bytecode compilation in container
func generateAlpineDockerfile(dir string) {
	dockerfile := `# Generated by Knative Next Builder (Multi-Stage Bytecode Mode)
# Stage 1: Build bytecode binary using Bun
FROM oven/bun:alpine AS builder

WORKDIR /build


# Copy all files (standalone output + runner)
COPY . .

# Patch ALL files containing build-machine paths to use container paths
RUN sed -i 's|/Users/banna/alpheya/pocs/Knative-open-nextjs|/app|g' \
    dist-isolated/file-manager-home/.next/required-server-files.json \
    dist-isolated/file-manager-home/server.js 2>/dev/null || true

# Verify paths patched
RUN grep "outputFileTracingRoot" dist-isolated/file-manager-home/.next/required-server-files.json | head -1

# Compile using build script that applies plugins at BUILD time
# The build-with-plugin.ts uses Bun.build() API to transform bun-runner.ts
# before compiling to bytecode binary
RUN bun run build-with-plugin.ts bun-runner.ts server

# Stage 2: Bun runtime (NOT distroless - needed for binary execution)
FROM oven/bun:1-alpine

WORKDIR /app

# Copy compiled binary
COPY --from=builder /build/server /app/server

# Copy node_modules and .next artifacts
COPY --from=builder /build/node_modules /app/node_modules
COPY --from=builder /build/dist-isolated /app/dist-isolated

ENV NODE_ENV=production
ENV NODE_PATH=/app/node_modules
ENV PORT=8080
ENV HOSTNAME=0.0.0.0

CMD ["./server"]
`
	if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte(dockerfile), 0644); err != nil {
		log.Fatalf("Failed to write Dockerfile: %v", err)
	}
}

func buildAndPushDocker(rootDir, contextDir, tag string, dryRun bool) {
	if _, err := os.Stat(filepath.Join(contextDir, "Dockerfile")); os.IsNotExist(err) {
		log.Printf("⚠️ No Dockerfile in %s. Skipping.\n", contextDir)
		return
	}
	fmt.Printf("\n🐳 Building Docker Image: %s...\n", tag)
	if dryRun {
		fmt.Printf("[Dry Run] docker build -t %s .\n", tag)
		fmt.Printf("[Dry Run] docker push %s\n", tag)
		return
	}
	
	cmd := exec.Command("docker", "build", "--platform", "linux/amd64", "-t", tag, ".")
	cmd.Dir = contextDir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		log.Fatalf("Docker Build Failed: %v", err)
	}

	cmdPush := exec.Command("docker", "push", tag)
	cmdPush.Stdout = os.Stdout
	cmdPush.Stderr = os.Stderr
	if err := cmdPush.Run(); err != nil {
		log.Fatalf("Docker Push Failed: %v", err)
	}
}

func deployKnative(serviceName, imageTag string, cfg *config.Config, dryRun bool) {
	fmt.Printf("\n🔥 Deploying Knative Service: %s...\n", serviceName)
	timestamp := time.Now().Format(time.RFC3339)
	ksvc := fmt.Sprintf(`
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: %s
  namespace: default
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/min-scale: "0"
        knative-next/deployed-at: "%s" 
    spec:
      containers:
        - image: %s
          env:
            - name: DATABASE_URL
              value: "%s"
            - name: ASSET_PREFIX
              value: "%s"
            - name: MINIO_ENDPOINT
              value: "storage.googleapis.com"
            - name: MINIO_PORT
              value: "443"
            - name: MINIO_USE_SSL
              value: "true"
            - name: MINIO_ACCESS_KEY
              value: "%s"
            - name: MINIO_SECRET_KEY
              value: "%s"
`, serviceName, timestamp, imageTag, cfg.Infrastructure.DatabaseService.ConnectionString, cfg.Infrastructure.S3Service.PublicURL, cfg.Infrastructure.S3Service.AccessKey, cfg.Infrastructure.S3Service.SecretKey)

	if dryRun {
		fmt.Println(ksvc)
		return
	}
	
	cmd := exec.Command("kubectl", "apply", "-f", "-")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	stdin, _ := cmd.StdinPipe()
	go func() {
		defer stdin.Close()
		io.WriteString(stdin, ksvc)
	}()
	if err := cmd.Run(); err != nil {
		log.Fatalf("Kubectl Apply Failed: %v", err)
	}
}
