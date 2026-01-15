package packager

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"knative.dev/distribution-builder/analyzer"
)

type Isolator struct {
	ProjectRoot string
	OutputDir   string
}

func NewIsolator(projectRoot, outputDir string) *Isolator {
	return &Isolator{
		ProjectRoot: projectRoot,
		OutputDir:   outputDir,
	}
}

// IsolatePage creates a self-contained directory for a specific page
func (iso *Isolator) IsolatePage(pageName string, nftPath string, clientManifestPath string) error {
	pageDir := filepath.Join(iso.OutputDir, "pages", pageName)
	if err := os.MkdirAll(pageDir, 0755); err != nil {
		return fmt.Errorf("failed to create page dir: %w", err)
	}

	// 1. Parse & Copy NFT (Server Deps)
	serverFiles, err := analyzer.ParseNFT(nftPath, iso.ProjectRoot)
	if err != nil {
		return fmt.Errorf("failed to parse NFT: %w", err)
	}

	// 1a. Explicitly add the Entrypoint (page.js)
	// NFT trace often excludes the file itself.
	entrypointPath := strings.TrimSuffix(nftPath, ".nft.json")
	// Convert to relative path from ProjectRoot if it's absolute?
	// nftPath passed to IsolatePage comes from main.go.
	// main.go constructs it: "path + .nft.json".
	// path was from filepath.Walk(pagesDir). pagesDir is absolute.
	// So nftPath is absolute.
	// We need relative path for copyFile (which expects relative to ProjectRoot).
	
	entrypointRel, err := filepath.Rel(iso.ProjectRoot, entrypointPath)
	if err != nil {
		return fmt.Errorf("failed to resolve entrypoint rel path: %w", err)
	}
	serverFiles = append(serverFiles, entrypointRel)

	// 1b. Merge _not-found dependencies (Implicit dependency for Next.js Server)
	// The server requires _not-found to generate 404s, even if the page doesn't import it.
	// Verify if it exists (it might be _not-found.js at root or inside folder)
	// Based on logs: .../server/app/_not-found/page.js
	// So we look for .../server/app/_not-found/page.js.nft.json
	
	// We construct path relative to known structure.
	// nftPath is .../server/app/[page]/page.js.nft.json (or similar)
	// We need .../server/app/_not-found/page.js.nft.json
	// Actually, easier to use ProjectRoot + relative path.
	// ProjectRoot = .../standalone
	// Relative: apps/file-manager/.next/server/app/_not-found/page.js.nft.json
	
	notFoundRel := "apps/file-manager/.next/server/app/_not-found/page.js.nft.json"
	notFoundAbs := filepath.Join(iso.ProjectRoot, notFoundRel)
	
	if _, err := os.Stat(notFoundAbs); err == nil {
		fmt.Printf("DEBUG: Merging _not-found dependencies from %s\n", notFoundRel)
		extraFiles, err := analyzer.ParseNFT(notFoundAbs, iso.ProjectRoot)
		if err == nil {
			serverFiles = append(serverFiles, extraFiles...)
			// Also ensure the entrypoint itself is copied (NFT excludes entrypoint usually?)
			// ParseNFT returns dependencies. We must ensure the JS file itself is copied.
			// Logic below iterates serverFiles.
			// Does ParseNFT return the input file? usually no.
			// So we must add "apps/file-manager/.next/server/app/_not-found/page.js" to serverFiles?
			// Wait, ParseNFT returns absolute paths or relative?
			// It returns relative to ProjectRoot.
			serverFiles = append(serverFiles, "apps/file-manager/.next/server/app/_not-found/page.js")
		} else {
             fmt.Printf("Warning: failed to parse _not-found NFT: %v\n", err)
        }
	} else {
        // Try alternate location? root _not-found.js?
        // Let's assume standard app router structure for now.
        // fmt.Printf("DEBUG: _not-found NFT not found at %s\n", notFoundRel)
    }

	// 1c. Merge Root Layout dependencies (Implicit dependency for App Router)
	// Every page in App Router needs the Root Layout (app/layout.js) to render.
	// NFT of a leaf page does NOT trace the parent layout.
	// We must explicitly add it.
	
	layoutRel := "apps/file-manager/.next/server/app/layout.js"
	layoutNFT := layoutRel + ".nft.json"
	layoutAbs := filepath.Join(iso.ProjectRoot, layoutNFT)

	if _, err := os.Stat(layoutAbs); err == nil {
		fmt.Printf("DEBUG: Merging Root Layout dependencies from %s\n", layoutNFT)
		extraFiles, err := analyzer.ParseNFT(layoutAbs, iso.ProjectRoot)
		if err == nil {
			serverFiles = append(serverFiles, extraFiles...)
			// Explicitly add layout.js and its data files
			serverFiles = append(serverFiles, layoutRel)
			// Add potential .rsc / .meta / .html if they exist for layout?
			// layout.rsc might exist if static?
			// But mainly the .js is needed.
		} else {
             fmt.Printf("Warning: failed to parse Root Layout NFT: %v\n", err)
        }
	} else {
		fmt.Printf("DEBUG: Root Layout NFT not found at %s (Is this Pages Router?)\n", layoutNFT)
	}

	fmt.Printf("Deep copying %d server files for %s...\n", len(serverFiles), pageName)
	for _, file := range serverFiles {
		if err := iso.copyFile(file, pageDir); err != nil {
			return fmt.Errorf("failed to copy server file %s: %w", file, err)
		}
	}

	// 2. Parse & Copy Client Manifest (Client Chunks)
	if clientManifestPath != "" {
		clientFiles, err := analyzer.ParseClientManifest(clientManifestPath)
		if err != nil {
			fmt.Printf("Warning: failed to client manifest for %s: %v\n", pageName, err)
		} else {
			fmt.Printf("Deep copying %d client chunks for %s...\n", len(clientFiles), pageName)
			for _, file := range clientFiles {
				// Client files are typically like "static/chunks/...", we need to ensure they go into .next/
				// The standalone output usually puts them in .next/static/chunks.
				// The file list from manifest usually starts with "static/".
				// Handle paths starting with /_next/ or _next/
				normalizedFile := strings.TrimPrefix(file, "/")
				normalizedFile = strings.TrimPrefix(normalizedFile, "_next/")

				// Source: ProjectRoot/../[normalizedFile]
				// ProjectRoot is .../apps/file-manager/.next/standalone
				// Parent is .../apps/file-manager/.next
				// normalizedFile is static/chunks/...
				
				srcPath := filepath.Join(filepath.Dir(iso.ProjectRoot), normalizedFile)

				// Dest: pageDir/.next/[normalizedFile]
				destPath := filepath.Join(pageDir, ".next", normalizedFile)

				if err := iso.copyFileExplicit(srcPath, destPath); err != nil {
					// Don't fail hard on optional client chunks, looking for css map or strange paths
					fmt.Printf("Warning: failed to copy client file %s: %v\n", normalizedFile, err)
				}
			}
		}
	}

	// 3. Copy Entrypoint (server.js)
	// We assume a standard server.js exists at the root of the app in standalone
	// e.g. apps/file-manager/server.js
	// We need to copy this to the root of the pageDir
	// TODO: Make this configurable? For now hardcode for file-manager
	appName := "apps/file-manager"
	appServerJs := filepath.Join(appName, "server.js")
	if err := iso.copyFile(appServerJs, pageDir); err != nil {
		return fmt.Errorf("failed to copy server.js: %w", err)
	}

	// [DEBUG BRUTE FORCE] Copy ALL chunks to ensure Layout is present
	// This confirms if missing chunk is the valid theory.
	// If this works, we will optimize later.
	chunksSrc := filepath.Join(iso.ProjectRoot, appName, ".next/server/chunks")
	chunksDest := filepath.Join(pageDir, appName, ".next/server/chunks")
	fmt.Printf("DEBUG: Brute Force Copying ALL CHUNKS from %s to %s\n", chunksSrc, chunksDest)
	if err := iso.copyDir(chunksSrc, chunksDest); err != nil {
		fmt.Printf("Warning: failed to brue force copy chunks: %v\n", err)
	}
	// 3b. Copy Critical Manifests (BUILD_ID, routes-manifest.json, etc.)
	// NFT might miss these if they aren't directly imported by the page.
	// But server.js needs them to boot.
	// PATCH: required-server-files.json contains absolute local paths.
	// We handle it separately to patch it.
	reqServerFilesRel := filepath.Join(appName, ".next/required-server-files.json")
	if err := iso.copyFile(reqServerFilesRel, pageDir); err != nil {
		fmt.Printf("Warning: failed to copy required-server-files.json: %v\n", err)
	} else {
		// We must rewrite paths to /app (Container Root).
		absDest := filepath.Join(pageDir, reqServerFilesRel)
		content, err := os.ReadFile(absDest)
		if err == nil {
			strContent := string(content)
			
			// Fix: iso.ProjectRoot points to .next/standalone, but the file refers to the Source Root.
			// We need to strip the standalone suffix to match the path in the file.
			// Path in file: /Users/banna/alpheya/pocs/Knative-open-nextjs
			// iso.ProjectRoot: /Users/banna/alpheya/pocs/Knative-open-nextjs/apps/file-manager/.next/standalone
			
			// Robust way: Find the index of "/apps/" or just trim known suffix.
			// Since we know appName is "apps/file-manager", we can construct the standalone suffix.
			standaloneSuffix := filepath.Join(appName, ".next/standalone")
			sourceRoot := strings.TrimSuffix(iso.ProjectRoot, standaloneSuffix)
			// Handle simplified case if path separators differ or if it didn't trim (e.g. strict string match)
			if sourceRoot == iso.ProjectRoot {
			    // Fallback: splitting by ".next"
			    parts := strings.Split(iso.ProjectRoot, ".next")
			    if len(parts) > 0 {
			        sourceRoot = filepath.Dir(parts[0]) // strip apps/file-manager
			        // Wait, parts[0] is .../apps/file-manager/
			        // We want .../Knative-open-nextjs
			        // So we need to go up 2 dirs from parts[0]
			        sourceRoot = filepath.Dir(filepath.Dir(parts[0]))
			    }
			}
			
			// Final check to handle clean paths
			sourceRoot = filepath.Clean(sourceRoot)
			
			fmt.Printf("DEBUG: Patching paths. SourceRoot detected as: %s. Replacing with /app\n", sourceRoot)

			patchedContent := strings.ReplaceAll(strContent, sourceRoot, "/app")
			if err := os.WriteFile(absDest, []byte(patchedContent), 0644); err != nil {
				fmt.Printf("Warning: failed to write patched required-server-files.json: %v\n", err)
			} else {
				fmt.Printf("DEBUG: Patched required-server-files.json paths.\n")
			}
		} else {
			fmt.Printf("Warning: failed to read required-server-files.json for patching: %v\n", err)
		}
	}

	// PATCH: routes-manifest.json
	// The problem is that Next.js thinks /dashboard (and others) are STATIC routes, 
	// so it looks for .html/.rsc files that NFT might have missed or are not served correctly in standalone.
	// We want to FORCE DYNAMIC execution to run the JS code we know is present.
	routesManifestRel := filepath.Join(appName, ".next/routes-manifest.json")
	if err := iso.copyFile(routesManifestRel, pageDir); err != nil {
		fmt.Printf("Warning: failed to copy routes-manifest.json: %v\n", err)
	} else {
		// Read, Parse, Modify, Write
		absDest := filepath.Join(pageDir, routesManifestRel)
		content, err := os.ReadFile(absDest)
		if err == nil {
			var routesManifest map[string]interface{}
			if err := json.Unmarshal(content, &routesManifest); err == nil {
				// Clear staticRoutes
				if _, ok := routesManifest["staticRoutes"]; ok {
					fmt.Println("DEBUG: Clearing staticRoutes in routes-manifest.json to FORCE DYNAMIC routing")
					routesManifest["staticRoutes"] = []interface{}{}
				}
				
				// Re-serialize
				newContent, err := json.MarshalIndent(routesManifest, "", "  ")
				if err == nil {
					if err := os.WriteFile(absDest, newContent, 0644); err != nil {
						fmt.Printf("Warning: failed to write patched routes-manifest.json: %v\n", err)
					}
				}
			}
		}
	}

	// PATCH: server.js hardcoded config
	// server.js contains a hardcoded JSON.stringify(nextConfig) which includes "outputFileTracingRoot": "/Users/banna..."
	// We need to patch this file as well to point to /app
	if err := iso.patchServerJSConfig(filepath.Join(pageDir, appServerJs)); err != nil {
		fmt.Printf("Warning: failed to patch server.js config: %v\n", err)
	}

	manifests := []string{
		filepath.Join(appName, ".next/BUILD_ID"),
		// filepath.Join(appName, ".next/routes-manifest.json"), // Handled Above
		// filepath.Join(appName, ".next/prerender-manifest.json"), // EXCLUDED: Force Dynamic
		// filepath.Join(appName, ".next/required-server-files.json"), // Handled above
		filepath.Join(appName, ".next/images-manifest.json"),
		filepath.Join(appName, ".next/server/pages-manifest.json"),
		filepath.Join(appName, ".next/server/app-paths-manifest.json"),
		filepath.Join(appName, ".next/server/middleware-manifest.json"),
		filepath.Join(appName, ".next/server/server-reference-manifest.json"),
		filepath.Join(appName, ".next/server/functions-config-manifest.json"),
		filepath.Join(appName, ".next/server/next-font-manifest.json"),
		filepath.Join(appName, ".next/build-manifest.json"),
		filepath.Join(appName, ".next/react-loadable-manifest.json"),
	}
	
	for _, m := range manifests {
		// These are optional-ish (images might not exist), but BUILD_ID is non-negotiable.
		// We try copy.
		fmt.Printf("DEBUG: Attempting copy of manifest: %s\n", m)
		if err := iso.copyFile(m, pageDir); err != nil {
			fmt.Printf("Warning: failed to copy manifest %s: %v\n", m, err)
		}
	}

	// 4. Force Copy all package.json files from node_modules
	// This ensures that even if NFT missed the package definition (but traced files),
	// Node/Bun can still resolve the package root.
	if err := iso.copyAllPackageJSONs(pageDir); err != nil {
		fmt.Printf("Warning: failed to copy package.json files: %v\n", err)
	}

	// 5. Restore Critical Packages from Root (Hybrid Repair)
	// Standalone might prune these or leave them in an incompatible state.
	// We restore full files from Root to ensure 'require' works.
	criticalPackages := []string{"next", "styled-jsx", "react", "react-dom", "@swc/helpers"}
	for _, pkg := range criticalPackages {
		if err := iso.restorePackageFromRoot(pageDir, pkg); err != nil {
			// Don't fail if root doesn't have it (e.g. styled-jsx might be transitive)
			// But log warning
			fmt.Printf("Warning: failed to restore critical package %s: %v\n", pkg, err)
		}
	}

	// 6. Force Shim next/package.json to be permissive (Remove 'exports' restriction)
	// Even with full files, the Root package.json might restrict access to internal paths via 'exports'.
	// We overwrite it with a simple shims to allow deep requires (e.g. next/dist/server/lib/start-server).
	if err := iso.shimNextPackage(pageDir, true); err != nil {
		fmt.Printf("Warning: failed to shim/overwrite next package: %v\n", err)
	}

	return nil
}

func (iso *Isolator) copyAllPackageJSONs(destRoot string) error {
	srcModules := filepath.Join(iso.ProjectRoot, "node_modules")
	fmt.Printf("📦 Copying package.json files from %s to %s\n", srcModules, destRoot)

	return filepath.Walk(srcModules, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil 
		}
		if !info.IsDir() && info.Name() == "package.json" {
			relPath, err := filepath.Rel(iso.ProjectRoot, path)
			if err != nil {
				return nil
			}
			dest := filepath.Join(destRoot, relPath)
			if err := iso.copyFileExplicit(path, dest); err != nil {
				// ignore
			}
		}
		return nil
	})
}

func (iso *Isolator) restorePackageFromRoot(destRoot, pkgName string) error {
	nextDestDir := filepath.Join(destRoot, "node_modules", pkgName)
	// We check if it exists? 
	// Actually, for "next", we know it exists partially (dist/compiled) but we want to OVERLAY.
	// For "react", it commonly exists.
	// We should probably just OVERLAY to be safe.
	// BUT, syncing 274MB every time...
	// We only strictly needed 'next' overlay.
	// 'styled-jsx' is missing entirely?
	
	// Optimization: Only restore if package.json is missing?
	// But 'next' had NO package.json but had partial files.
	// 'react' likely has package.json in standalone.
	// Let's rely on package.json missing as trigger?
	// BUT `styled-jsx` might be missing directory entirely.
	
	// Strategy: Always try to restore. `copyDir` is fastish if files exist? No it copies.
	
	// Let's proceed with Overlay.
	
	repoRoot := filepath.Dir(filepath.Dir(filepath.Dir(filepath.Dir(iso.ProjectRoot))))
	pkgSrcDir := filepath.Join(repoRoot, "node_modules", pkgName)
	
	// If source doesn't exist in root, skip
	if _, err := os.Stat(pkgSrcDir); os.IsNotExist(err) {
		fmt.Printf("⚠️  Skipping restore of %s: Missing in Root %s\n", pkgName, pkgSrcDir)
		return nil
	}

	// Logging
	fmt.Printf("🔧 Restoring/Overlaying package %s from %s\n", pkgName, pkgSrcDir)
	
	return iso.copyDir(pkgSrcDir, nextDestDir)
}

func (iso *Isolator) shimNextPackage(destRoot string, force bool) error {
	nextDir := filepath.Join(destRoot, "node_modules", "next")
	pkgJson := filepath.Join(nextDir, "package.json")
	
	// Shim if missing OR forced
	if _, err := os.Stat(pkgJson); os.IsNotExist(err) || force {
		fmt.Printf("🔧 Shimming next/package.json (Force: %v) in %s\n", force, nextDir)
		
		if err := os.MkdirAll(nextDir, 0755); err != nil {
			return err
		}

		// 1. Synthetic permissive package.json
		pkgContent := []byte(`{"name": "next", "version": "16.0.0-shim", "main": "index.js"}`)
		if err := os.WriteFile(pkgJson, pkgContent, 0644); err != nil {
			return err
		}

		// 2. Synthetic index.js (Only if missing, logic: if we restored full package, verify index.js exists?)
		// actually, the shim index.js is safe if real index.js is complex.
		// default next index.js exports server stuff.
		// server.js uses deep imports.
		// require('next') is likely for side effects.
		// We'll leave index.js alone if it exists from Full Restore?
		// No, let's shim index.js ONLY if missing.
		
		indexJs := filepath.Join(nextDir, "index.js")
		if _, err := os.Stat(indexJs); os.IsNotExist(err) {
			indexContent := []byte(`module.exports = {};`)
			os.WriteFile(indexJs, indexContent, 0644)
		}
	}
	return nil
}

func (iso *Isolator) copyDir(src, dest string) error {
    return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
        if err != nil { return nil }
        
        relPath, err := filepath.Rel(src, path)
        if err != nil { return nil }
        
        destPath := filepath.Join(dest, relPath)
        
        if info.IsDir() {
            return os.MkdirAll(destPath, 0755)
        }
        
        return iso.copyFileExplicit(path, destPath)
    })
}

func (iso *Isolator) copyFile(relPath string, destRoot string) error {
	src := filepath.Join(iso.ProjectRoot, relPath)
	dest := filepath.Join(destRoot, relPath)

	if err := os.MkdirAll(filepath.Dir(dest), 0755); err != nil {
		return err
	}

	// Symlink handling? Standalone usually essentially copies real files.
	// We'll standard copy.
	s, err := os.Open(src)
	if err != nil {
		return err
	}
	defer s.Close()

	d, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer d.Close()

	_, err = io.Copy(d, s)
	return err
}

func (iso *Isolator) copyFileExplicit(src, dest string) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0755); err != nil {
		return err
	}

	s, err := os.Open(src)
	if err != nil {
		return err
	}
	defer s.Close()

	d, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer d.Close()

	_, err = io.Copy(d, s)
	return err
}
