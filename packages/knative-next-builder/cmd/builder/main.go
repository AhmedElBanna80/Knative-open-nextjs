package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/AhmedElBanna80/Knative-open-nextjs/packages/knative-next-builder/internal/analyzer"
	"github.com/AhmedElBanna80/Knative-open-nextjs/packages/knative-next-builder/internal/generator"
	"github.com/AhmedElBanna80/Knative-open-nextjs/packages/knative-next-builder/internal/runner"
)


func main() {
	if err := Run(os.Args[1:]); err != nil {
		log.Fatal(err)
	}
}

// Run executes the builder logic
func Run(args []string) error {
	var (
		projectDir string
		outputDir  string
		cleanup    bool
	)

	// Create a FlagSet to handle flags for our specific Run call
	// This makes testing easier as we can pass custom args
	fs := flag.NewFlagSet("builder", flag.ExitOnError)
	fs.StringVar(&projectDir, "dir", ".", "Path to the Next.js project root")
	fs.StringVar(&outputDir, "output", "dist", "Output directory for the compiled binary")
	fs.BoolVar(&cleanup, "cleanup", true, "Cleanup temporary files after build")
	var target string
	fs.StringVar(&target, "target", "bun", "Bun build target (e.g. bun-linux-x64)")
	
	if err := fs.Parse(args); err != nil {
		return err
	}

	absProjectDir, err := filepath.Abs(projectDir)
	if err != nil {
		return fmt.Errorf("failed to resolve project directory: %w", err)
	}

	absOutputDir, err := filepath.Abs(outputDir)
	if err != nil {
		return fmt.Errorf("failed to resolve output directory: %w", err)
	}

	fmt.Printf("Building Next.js project at: %s\n", absProjectDir)
	fmt.Printf("Output directory: %s\n", absOutputDir)

	// 1. Analyze
	fmt.Println("Analyzing build artifacts...")
	analysis, err := analyzer.Analyze(absProjectDir)
	if err != nil {
		return fmt.Errorf("analysis failed: %w", err)
	}
	fmt.Printf("Found Next.js project with config for env: %v\n", analysis.NextConfig["env"])

	// 1.5 Copy Standalone (Dependencies)
	fmt.Println("Copying standalone dependencies (NFT)...")
	if err := runner.CopyStandalone(absProjectDir, absOutputDir); err != nil {
		return fmt.Errorf("standalone copy failed: %w", err)
	}

	// 2. Prepare Temp Directory
	// We create temp dir inside .next to ensure node_modules are resolvable by bun build
	tempDir := filepath.Join(absProjectDir, ".next", "knative-builder-tmp")
	if err := os.MkdirAll(tempDir, 0755); err != nil {
		return fmt.Errorf("failed to create temp dir: %w", err)
	}
	if cleanup {
		defer os.RemoveAll(tempDir)
	}

	// 3. Generate Runner
	fmt.Println("Generating main entry point...")
	
	// Generate package.json for dependencies
	if err := generator.GeneratePackageJSON(tempDir); err != nil {
		return fmt.Errorf("failed to generate package.json: %w", err)
	}
	
	// Calculate relative app dir by finding server.js in the output
	// Standalone output structure varies (sometimes strips /Users/foo, sometimes not)
	var relativeAppDir string
	errFound := fmt.Errorf("found")
	err = filepath.Walk(absOutputDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		// Ignore node_modules
		if strings.Contains(path, "node_modules") {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		
		if info.Name() == "server.js" {
			// Found it! Get path relative to absOutputDir
			rel, err := filepath.Rel(absOutputDir, filepath.Dir(path))
			if err != nil {
				return err
			}
			relativeAppDir = rel
			return errFound // Stop searching globally
		}
		return nil
	})
	
	if relativeAppDir == "" {
		return fmt.Errorf("could not find server.js in standalone output to determine app directory")
	}
	fmt.Printf("Detected relative app dir: %s\n", relativeAppDir)

	runnerPath, err := generator.GenerateRunner(analysis.NextConfig, tempDir, relativeAppDir)
	if err != nil {
		return fmt.Errorf("generation failed: %w", err)
	}
	fmt.Printf("Generated runner at: %s\n", runnerPath)

	// 3.5 Shim Hidden Dependencies
	fmt.Println("Shimming Next.js internal dependencies...")
	if err := runner.ShimReactServerDom(absProjectDir, absOutputDir); err != nil {
		log.Printf("Warning: Shim failed: %v", err)
	}
	if err := runner.ShimRuntimeModules(absProjectDir, absOutputDir); err != nil {
		log.Printf("Warning: Runtime Shim failed: %v", err)
	}
	if err := runner.PatchNextInternals(absOutputDir); err != nil {
		log.Printf("Warning: PatchNextInternals failed: %v", err)
	}
	
	// 3.6 Prune Unnecessary Files
	if err := runner.PruneNodeModules(absOutputDir); err != nil {
		log.Printf("Warning: Pruning failed: %v", err)
	}

	// 4. Output Entry Point
	// Strategy: Try to compile a single binary.
	// If that works, we ship it.
	fmt.Printf("Compiling binary with Bun (Target: %s)...\n", target)
	
	// Note: runner.Build signature changed to accept pluginPath and target
	err = runner.Build(absProjectDir, runnerPath, absOutputDir, "server", "", target)
	if err != nil {
		fmt.Printf("⚠️ Binary compilation failed: %v\n", err)
		fmt.Println("Falling back to Script Mode (server.ts)...")
		
		// Fallback Logic from before
		destRunner := filepath.Join(absOutputDir, "server.ts")
		input, err := os.ReadFile(runnerPath)
		if err != nil {
			return fmt.Errorf("failed to read generated runner: %w", err)
		}
		if err := os.WriteFile(destRunner, input, 0755); err != nil {
			return fmt.Errorf("failed to write server.ts: %w", err)
		}
		fmt.Printf("Created entry point: %s\n", destRunner)
	} else {
		fmt.Println("Build complete: server (Binary)")
	}

	// Copy package.json always (needed for runtime patches/assets even in binary mode sometimes, or just safety)
	// Actually, strictly speaking, a binary shouldn't need package.json dependencies if fully bundled.
	// But assets/sharp might still need it? Let's keep it.
	pkgInput, err := os.ReadFile(filepath.Join(tempDir, "package.json"))
	if err == nil {
		os.WriteFile(filepath.Join(absOutputDir, "package.json"), pkgInput, 0644)
	}
	// Also ensure bun-plugin.js doesn't leak or is cleaned up (tempDir handles it)

	// 5. Copy Assets
	fmt.Println("Organizing assets...")
	if err := runner.CopyAssets(absProjectDir, absOutputDir); err != nil {
		return fmt.Errorf("asset copying failed: %w", err)
	}

	fmt.Println("Success! Artifacts ready in", absOutputDir)
	return nil
}

