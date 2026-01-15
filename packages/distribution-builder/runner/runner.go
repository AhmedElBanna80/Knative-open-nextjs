package runner

import (
	"encoding/json"
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
		"--minify", // Enabled for production builds
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
	cmd.Dir = projectDir // Run from the project directory so relative paths work
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

// CopyDependenciesFromTrace uses .nft.json files in .next to identify and copy used node_modules
func CopyDependenciesFromTrace(projectDir, outputDir string) error {
	nextDir := filepath.Join(projectDir, ".next")

	type TraceFile struct {
		Version int      `json:"version"`
		Files   []string `json:"files"`
	}

	// Set of files to copy (avoid duplicates)
	// We store the resolved absolute source path
	filesToCopy := make(map[string]bool)

	fmt.Println("Scanning .nft.json files for dependencies...")
	err := filepath.Walk(nextDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() && strings.HasSuffix(path, ".nft.json") {
			// Parse trace file
			data, err := os.ReadFile(path)
			if err != nil {
				return fmt.Errorf("failed to read trace file %s: %w", path, err)
			}
			var trace TraceFile
			if err := json.Unmarshal(data, &trace); err != nil {
				return fmt.Errorf("failed to parse trace file %s: %w", path, err)
			}

			traceDir := filepath.Dir(path)
			for _, file := range trace.Files {
				// Resolve absolute path
				absPath := filepath.Join(traceDir, file)
				
				// Clean the path to handle .. segments
				absPath = filepath.Clean(absPath)
				
				// Only copy if it contains node_modules explicitly
				// This avoids copying source files (which are already in dist-deploy via COPY . .)
				// and ensures we only target external dependencies which might be outside the app root.
				if strings.Contains(absPath, "node_modules") {
                    // Optimization filters
                    // 1. Skip TypeScript (dev tool) - actually keep it for verifying setup if needed
                    // if strings.Contains(absPath, "node_modules/typescript") {
                    //    continue
                    // }
                    // 2. Skip @types (dev definitions)
                    if strings.Contains(absPath, "node_modules/@types") {
                        continue
                    }
                    // 3. Skip definition files
                    if strings.HasSuffix(absPath, ".d.ts") {
                        continue
                    }
                    // 4. Skip ESLint
                    if strings.Contains(absPath, "node_modules/eslint") {
                        continue
                    }
                    // 5. Skip non-linux platform binaries (Simple heuristic for Container target)
                    // We assume the target is always linux for these builds.
                    lower := strings.ToLower(absPath)
                    if strings.Contains(lower, "darwin") || strings.Contains(lower, "macos") || strings.Contains(lower, "win32") || strings.Contains(lower, "windows") {
                         continue
                    }

					filesToCopy[absPath] = true
				}
			}
		}
		return nil
	})

	if err != nil {
		return fmt.Errorf("failed to walk .next dir for traces: %w", err)
	}

	fmt.Printf("Found %d unique dependency files from traces.\n", len(filesToCopy))

	for srcPath := range filesToCopy {
		// Determine relative path inside outputDir/node_modules
		// The srcPath is something like /Users/.../node_modules/pg/lib/index.js
		// We want dest to be outputDir/node_modules/pg/lib/index.js
		
		// Find the last occurrence of "node_modules" to handle nested deps if necessary, 
		// but typically we want the root relative path.
		// A reliable way is to split by "node_modules/" and take the last part? 
		// Or if we run from a monorepo, we might have multiple node_modules layers.
		// However, for the final image, we flatten everything into /app/node_modules usually, 
		// or we preserve the structure?
		// "Bun" runtime will look in /app/node_modules.
		// So we should find the *segment* after the last "node_modules/".
		
		parts := strings.Split(srcPath, "node_modules/")
		if len(parts) < 2 {
			continue // Should not happen given the filter check above
		}
		
		// Take the part after the last node_modules/
		relPackagePath := parts[len(parts)-1]
		
		destPath := filepath.Join(outputDir, "node_modules", relPackagePath)
		
		// Copy
		if err := copyFile(srcPath, destPath); err != nil {
			fmt.Printf("Warning: Failed to copy trace file %s: %v\n", srcPath, err)
			// Don't fail the build, just warn
		}
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

	// Use Trace files to ensure all runtime dependencies are present
	if err := CopyDependenciesFromTrace(projectDir, outputDir); err != nil {
		return fmt.Errorf("failed to copy dependencies from trace: %w", err)
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
		
		// Debug logging for .next
		if strings.Contains(path, ".next") {
			fmt.Printf("DEBUG: Visiting %s (Dir: %v)\n", path, info.IsDir())
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

// ShimRuntimeModules ensures critical runtime modules (e.g. styled-jsx, @swc/helpers) 
// are available in the output node_modules for the compiled binary.
func ShimRuntimeModules(projectDir, outputDir string) error {
	modules := []string{"styled-jsx", "@swc/helpers", "@next/env", "pg"}
	fmt.Printf("Shimming runtime modules: %v\n", modules)

	for _, mod := range modules {
		// Try to find module in project root or monorepo root
		sources := []string{
			filepath.Join(projectDir, "node_modules", mod),
			filepath.Join(projectDir, "../../node_modules", mod),
		}

		found := false
		for _, src := range sources {
			if _, err := os.Stat(src); err == nil {
				dest := filepath.Join(outputDir, "node_modules", mod)
				fmt.Printf("  Shim: %s -> %s\n", src, dest)
				if err := copyDir(src, dest); err != nil {
					return fmt.Errorf("failed to shim module %s: %w", mod, err)
				}
				
				// Patch for @swc/helpers: Create physical '_' directory to bypass potential export resolution issues
				if mod == "@swc/helpers" {
					underscoreDir := filepath.Join(dest, "_")
					cjsDir := filepath.Join(dest, "cjs")
					if err := os.MkdirAll(underscoreDir, 0755); err != nil {
						fmt.Printf("Warning: failed to create @swc/helpers/_ dir: %v\n", err)
					} else {
						// Copy/Symlink cjs entries to _
						// Key: _interop_require_default -> cjs/_interop_require_default.cjs
						files, _ := os.ReadDir(cjsDir)
						for _, f := range files {
							if strings.HasSuffix(f.Name(), ".cjs") {
								// Create a proxy .js file in _ that requires the cjs one
								// e.g. _/_interop_require_default.js -> module.exports = require('../cjs/_interop_require_default.cjs')
								baseName := strings.TrimSuffix(f.Name(), ".cjs")
								proxyFile := filepath.Join(underscoreDir, baseName+".js")
								content := fmt.Sprintf("module.exports = require('../cjs/%s');", f.Name())
								if err := os.WriteFile(proxyFile, []byte(content), 0644); err != nil {
									fmt.Printf("Warning: failed to create proxy for %s: %v\n", baseName, err)
								}
							}
						}
						fmt.Println("  Patched @swc/helpers with physical '_' directory proxies.")
					}
				}
				
				// Patch for @next/env: Create root index.js if main points to dist/index.js
				// Bun compiled binary might struggle with package.json 'main' resolution for externals?
				if mod == "@next/env" {
					proxyFile := filepath.Join(dest, "index.js")
					if _, err := os.Stat(proxyFile); os.IsNotExist(err) {
						content := "module.exports = require('./dist/index.js');"
						if err := os.WriteFile(proxyFile, []byte(content), 0644); err != nil {
							fmt.Printf("Warning: failed to create proxy for @next/env: %v\n", err)
						} else {
							fmt.Println("  Patched @next/env with root index.js proxy.")
						}
					}
				}

				// Patch for pg: Create root index.js pointing to ./lib/index.js
				if mod == "pg" {
					proxyFile := filepath.Join(dest, "index.js")
					if _, err := os.Stat(proxyFile); os.IsNotExist(err) {
						content := "module.exports = require('./lib/index.js');"
						if err := os.WriteFile(proxyFile, []byte(content), 0644); err != nil {
							fmt.Printf("Warning: failed to create proxy for pg: %v\n", err)
						} else {
							fmt.Println("  Patched pg with root index.js proxy.")
						}
					}
				}



				found = true
				break
			}
		}
		if !found {
			fmt.Printf("Warning: runtime module %s not found in search paths\n", mod)
		}
	}
	return nil
}

// PatchNextInternals is a specific case of patching, kept for backward compatibility if needed, 
// but we really want to patch everything.
func PatchNextInternals(outputDir string) error {
	return PatchExternalModules(outputDir)
}

// PatchExternalModules iterates over all node_modules and creates index.js proxies if missing
func PatchExternalModules(outputDir string) error {
	nodeModulesDir := filepath.Join(outputDir, "node_modules")
	
	// Helper to patch a specific package dir
	patchPackage := func(pkgDir string) error {
		// Check for package.json
		pkgJsonPath := filepath.Join(pkgDir, "package.json")
		pkgJsonBytes, err := os.ReadFile(pkgJsonPath)
		if os.IsNotExist(err) {
			return nil // Not a package
		} else if err != nil {
			return fmt.Errorf("failed to read package.json: %w", err)
		}

		// Check if index.js already exists
		indexJsPath := filepath.Join(pkgDir, "index.js")
		if _, err := os.Stat(indexJsPath); err == nil {
			return nil
		}

		// Parse package.json to find "main"
		var pkgStruct struct {
			Main string `json:"main"`
		}
		if err := json.Unmarshal(pkgJsonBytes, &pkgStruct); err != nil {
			return nil // invalid json, skip
		}

		if pkgStruct.Main != "" {
			// Create proxy index.js pointing to Main
			target := pkgStruct.Main
			// If target is relative, make sure it starts with ./
			if !strings.HasPrefix(target, ".") && !strings.HasPrefix(target, "/") {
				target = "./" + target
			}
			
			content := fmt.Sprintf("module.exports = require('%s');", target)
			if err := os.WriteFile(indexJsPath, []byte(content), 0644); err != nil {
				return fmt.Errorf("failed to write proxy: %w", err)
			}
			fmt.Printf("Auto-Patched %s with index.js proxy -> %s\n", filepath.Base(pkgDir), target)
		}
		return nil
	}

	entries, err := os.ReadDir(nodeModulesDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}

		// Handle scoped packages
		if strings.HasPrefix(name, "@") {
			scopeDir := filepath.Join(nodeModulesDir, name)
			scopeEntries, err := os.ReadDir(scopeDir)
			if err == nil {
				for _, scopeEntry := range scopeEntries {
					if scopeEntry.IsDir() {
						if err := patchPackage(filepath.Join(scopeDir, scopeEntry.Name())); err != nil {
							fmt.Printf("Warning: failed to patch %s/%s: %v\n", name, scopeEntry.Name(), err)
						}
					}
				}
			}
			continue
		}

		// Normal package
		fullPath := filepath.Join(nodeModulesDir, name)
		if err := patchPackage(fullPath); err != nil {
			fmt.Printf("Warning: failed to patch %s: %v\n", name, err)
		}
	}
	
	// Also specifically patch next/dist/compiled for internal Next.js deps
	// These are nested deep inside next
	nextCompiledDir := filepath.Join(nodeModulesDir, "next", "dist", "compiled")
	compiledEntries, err := os.ReadDir(nextCompiledDir)
	if err == nil {
		for _, entry := range compiledEntries {
			if entry.IsDir() {
				if err := patchPackage(filepath.Join(nextCompiledDir, entry.Name())); err != nil {
					// Suppress generic warning, might be common
				}
			}
		}
	}

	return nil
}

// PruneNodeModules removes unnecessary files from the output node_modules
func PruneNodeModules(outputDir string) error {
	nodeModulesDir := filepath.Join(outputDir, "node_modules")
	
	fmt.Println("Pruning unnecessary files from node_modules...")
	
	bytesFreed := int64(0)
	
	err := filepath.Walk(nodeModulesDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // ignore errors
		}
		
		rel, _ := filepath.Rel(nodeModulesDir, path)
		lower := strings.ToLower(path)
		
		shouldRemove := false
		
		// 1. Typescript (Required by Next.js verify-setup, even in prod sometimes)
		// if strings.Contains(rel, "typescript") && info.IsDir() && filepath.Base(path) == "typescript" {
		// 	shouldRemove = true
		// }
		// 2. @types
		if strings.Contains(rel, "@types") && info.IsDir() && filepath.Base(path) == "@types" {
			shouldRemove = true
		}
		// 3. Definition files
		if !info.IsDir() && strings.HasSuffix(lower, ".d.ts") {
			shouldRemove = true
		}
		// 4. Source maps
		if !info.IsDir() && strings.HasSuffix(lower, ".js.map") {
			shouldRemove = true
		}
        // 5. Test files
        if !info.IsDir() && (strings.HasSuffix(lower, ".test.js") || strings.HasSuffix(lower, ".spec.js")) {
            shouldRemove = true
        }
        // 6. Markdown files
        if !info.IsDir() && (strings.HasSuffix(lower, ".md") || strings.HasSuffix(lower, ".markdown")) {
            shouldRemove = true
        }

		// 7. Non-Linux Platform Binaries
		if strings.Contains(lower, "darwin") || strings.Contains(lower, "macos") || strings.Contains(lower, "win32") || strings.Contains(lower, "windows") {
			shouldRemove = true
		}
		
		if shouldRemove {
			if info.IsDir() {
				// Calculate size roughly (not recursive here, just skip)
				// Actually os.RemoveAll will free it.
				// We can't easily know size before removing dir recursively in walk.
				os.RemoveAll(path)
				return filepath.SkipDir
			} else {
				bytesFreed += info.Size()
				os.Remove(path)
			}
		}
		
		return nil
	})
	
	fmt.Printf("Pruning complete. Freed approx %d bytes (plus directories).\n", bytesFreed)
	return err
}
