package runner

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Build compiles the entry point using Bun
func Build(projectDir, entryPoint, outputDir, targetName, pluginPath, target string) error {
	// bun build --compile --minify --target=<target> <entryPoint> --outfile <outputDir>/<targetName>
	
	// Create output dir if not exists
	if err := os.MkdirAll(outputDir, 0755); err != nil {
		return fmt.Errorf("failed to create output dir: %w", err)
	}

	outputPath := filepath.Join(outputDir, targetName)

	args := []string{
		"build",
		"--compile",
		// "--minify", // Disabled for debugging
		"--sourcemap=none",
		"--bytecode",
		"--target=" + target,
	}

	if pluginPath != "" {
		args = append(args, "--plugin", pluginPath)
	}

	// We rely on the standalone node_modules, so we externalize everything
	args = append(args,
		"--external:*",
		"--external:next/*", 
		"--external:next/dist/server/lib/start-server", 
		entryPoint,
		"--outfile",
		outputPath,
	)

	cmd := exec.Command("bun", args...)
	fmt.Printf("Running: bun %s\n", strings.Join(args, " "))
	if err := cmd.Run(); err != nil {
		fmt.Printf("Warning: bun build failed to produce binary (%v). Fallback to copying source script.\n", err)
		
		// Fallback: Copy source to output
		// We append .ts to the targetName for the script
		scriptPath := filepath.Join(outputDir, targetName+".ts")
		if err := copyFile(entryPoint, scriptPath); err != nil {
			return fmt.Errorf("fallback copy failed: %w", err)
		}
		fmt.Printf("Fallback successful: created %s\n", scriptPath)
		return nil
	}

	return nil
}

// CopyStandalone copies the contents of .next/standalone to the output directory
func CopyStandalone(projectDir, outputDir string) error {
	standaloneDir := filepath.Join(projectDir, ".next", "standalone")
	if _, err := os.Stat(standaloneDir); os.IsNotExist(err) {
		return fmt.Errorf("standalone directory not found at %s. Ensure 'output: standalone' is using in next.config.js", standaloneDir)
	}

	fmt.Printf("Copying standalone files from %s to %s...\n", standaloneDir, outputDir)
	if err := copyDir(standaloneDir, outputDir); err != nil {
		return err
	}

	// Fix for missing dependencies in standalone Trace (next, react, react-dom)
	return CopyCriticalDeps(projectDir, outputDir)
}

// CopyCriticalDeps ensures next, react, and react-dom are present in the output node_modules
func CopyCriticalDeps(projectDir, outputDir string) error {
	deps := []string{"next", "react", "react-dom"}
	
	// Potential locations for node_modules: project root or monorepo root (../../)
	// We can try to find them.
	locations := []string{
		filepath.Join(projectDir, "node_modules"),
		filepath.Join(projectDir, "..", "..", "node_modules"), // Monorepo root assumption
	}

	for _, dep := range deps {
		found := false
		for _, loc := range locations {
			src := filepath.Join(loc, dep)
			if _, err := os.Stat(src); err == nil {
				// Found it
				dest := filepath.Join(outputDir, "node_modules", dep)
				
				// Remove existing (if partial)
				os.RemoveAll(dest)
				
				fmt.Printf("Copying critical dependency %s from %s...\n", dep, src)
				if err := copyDir(src, dest); err != nil {
					return fmt.Errorf("failed to copy dep %s: %w", dep, err)
				}
				found = true
				break
			}
		}
		if !found {
			fmt.Printf("Warning: Critical dependency %s not found in standard locations. Build may fail.\n", dep)
		}
	}
	return nil
}

// CopyAssets prepares the assets directory (public + .next/static)
func CopyAssets(projectDir, outputDir string) error {
	assetsDir := filepath.Join(outputDir, "assets")
	if err := os.MkdirAll(assetsDir, 0755); err != nil {
		return fmt.Errorf("failed to create assets dir: %w", err)
	}

	// 1. Copy public -> assets/
	publicDir := filepath.Join(projectDir, "public")
	if _, err := os.Stat(publicDir); err == nil {
		if err := copyDir(publicDir, assetsDir); err != nil {
			return fmt.Errorf("failed to copy public dir: %w", err)
		}
	}

	// 2. Copy .next/static -> assets/_next/static
	// Note: Nginx usually serves /_next/static, so we need to preserve that structure
	nextStaticDir := filepath.Join(projectDir, ".next", "static")
	destNextStatic := filepath.Join(assetsDir, "_next", "static")
	if _, err := os.Stat(nextStaticDir); err == nil {
		if err := os.MkdirAll(filepath.Dir(destNextStatic), 0755); err != nil {
			return fmt.Errorf("failed to create destination _next path: %w", err)
		}
		if err := copyDir(nextStaticDir, destNextStatic); err != nil {
			return fmt.Errorf("failed to copy .next/static: %w", err)
		}
	}

	return nil
}

func copyDir(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		// Calculate relative path
		relPath, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}

		destPath := filepath.Join(dst, relPath)

		if info.IsDir() {
			return os.MkdirAll(destPath, info.Mode())
		}

		return copyFile(path, destPath)
	})
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	// Ensure dest dir exists (for safety, though walk should handle dirs)
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}

	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = io.Copy(out, in)
	if err != nil {
		return err
	}
	
	// Preserve mode
	si, err := os.Stat(src)
	if err == nil {
		os.Chmod(dst, si.Mode())
	}

	return nil
}

// ShimReactServerDom creates a shim for react-server-dom-webpack to bypass Next.js internal hiding
func ShimReactServerDom(projectDir, outputDir string) error {
	shimDir := filepath.Join(outputDir, "node_modules", "react-server-dom-webpack")
	if err := os.MkdirAll(shimDir, 0755); err != nil {
		return fmt.Errorf("failed to create shim dir: %w", err)
	}

	// Source directory (Next.js internals)
	// We might need to handle variations in naming (-experimental, etc)
	// Common path: node_modules/next/dist/compiled/react-server-dom-webpack-experimental/cjs
	// We search locally or in monorepo root
	searchPaths := []string{
		filepath.Join(projectDir, "node_modules", "next", "dist", "compiled", "react-server-dom-webpack-experimental", "cjs"),
		filepath.Join(projectDir, "..", "..", "node_modules", "next", "dist", "compiled", "react-server-dom-webpack-experimental", "cjs"),
	}

	var sourceDir string
	for _, p := range searchPaths {
		if _, err := os.Stat(p); err == nil {
			sourceDir = p
			break
		}
	}

	if sourceDir == "" {
		fmt.Println("Warning: Could not find react-server-dom-webpack source to shim. Binary might fail.")
		return nil
	}

	fmt.Printf("Shimming react-server-dom-webpack from %s\n", sourceDir)

	// Map source patterns to destination filenames
	// Source: react-server-dom-webpack-server.node.production.js or .min.js
	// Dest: server.node.js
	fileMappings := map[string]string{
		"server.node": "server.node.js",
		"client":      "client.js",
		"server.edge": "server.edge.js",
	}
	
	files, err := os.ReadDir(sourceDir)
	if err != nil {
		return err
	}

	for _, f := range files {
		name := f.Name()
		for typeKey, destName := range fileMappings {
			// Basic heuristic: check if filename contains typeKey (e.g. "server.node") and "production"
			if strings.Contains(name, typeKey) && strings.Contains(name, "production") {
				srcFile := filepath.Join(sourceDir, name)
				destFile := filepath.Join(shimDir, destName)
				fmt.Printf("  Shim: %s -> %s\n", name, destName)
				if err := copyFile(srcFile, destFile); err != nil {
					return err
				}
			}
		}
	}

	// Write package.json
	pkgContent := `{
  "name": "react-server-dom-webpack",
  "exports": {
    "./server.node": "./server.node.js",
    "./client": "./client.js",
    "./server.edge": "./server.edge.js"
  }
}`
	if err := os.WriteFile(filepath.Join(shimDir, "package.json"), []byte(pkgContent), 0644); err != nil {
		return err
	}

	return nil
}
