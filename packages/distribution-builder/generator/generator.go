package generator

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Generator handles the creation of temporary Zone Apps
type Generator struct {
	MonolithPath string // Path to the source app (e.g., apps/file-manager)
	WorkDir      string // Directory to create zone apps (e.g., dist-zones)
}

func NewGenerator(monolithPath, workDir string) *Generator {
	return &Generator{
		MonolithPath: monolithPath,
		WorkDir:      workDir,
	}
}

// GenerateZoneApp creates a standalone app for a specific route
// 1. Clones the monolith to workDir/appName-routeName
// 2. Prunes all other page.js files
func (g *Generator) GenerateZoneApp(appName, routeName string) (string, error) {
	zoneAppName := fmt.Sprintf("%s-%s", appName, sanitizeName(routeName))
	destPath := filepath.Join(g.WorkDir, zoneAppName)

	// 1. Clone
	fmt.Printf("Generating Zone App: %s -> %s\n", routeName, destPath)
	if err := g.cloneApp(destPath); err != nil {
		return "", fmt.Errorf("failed to clone app: %w", err)
	}

	// 2. Prune
	if err := g.pruneRoutes(destPath, routeName); err != nil {
		return "", fmt.Errorf("failed to prune routes: %w", err)
	}

	return destPath, nil
}

// cloneApp copies the application code.
// Optimization: We could use hardlinks for node_modules to save space/time.
func (g *Generator) cloneApp(dest string) error {
	// Simple recursive copy for now. 
	// Exclude .next, dist-*, node_modules, .git
	return copyDir(g.MonolithPath, dest, []string{".next", "dist", "dist-isolated", "node_modules", ".git"})
}

// pruneRoutes walks the app/ directory and removes any page.js that DOES NOT belong to the target route.
// It preserves layout.js, loading.js, error.js, etc.
func (g *Generator) pruneRoutes(appRoot, targetRoute string) error {
	appDir := filepath.Join(appRoot, "src/app") // App Router Root (src/app)
	
	// targetRoute is like "dashboard" or "users"
	// We want to keep app/dashboard/page.js
	// And remove app/users/page.js
	
	return filepath.Walk(appDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		
		if info.IsDir() {
			return nil
		}
		
		// We only care about page.js files
		if info.Name() == "page.js" || info.Name() == "page.tsx" {
			// Check if this page belongs to our target route.
			
			relPath, err := filepath.Rel(appDir, path)
			if err != nil {
				return err
			}
			
			// relPath examples: "dashboard/page.js", "users/page.js", "page.js" (root)
			
			pageRoute := filepath.Dir(relPath)
			if pageRoute == "." {
				pageRoute = "home" 
			}
			
			// If route mismatch, DELETE.
			if pageRoute != targetRoute {
				fmt.Printf("  Pruning route: %s (Target: %s)\n", pageRoute, targetRoute)
				return os.Remove(path)
			}
		}
		return nil
	})
}

func sanitizeName(name string) string {
	name = strings.ReplaceAll(name, "/", "-")
	return strings.ToLower(name)
}


// Utility: Recursive Copy
func copyDir(src, dest string, excludes []string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		relPath, _ := filepath.Rel(src, path)
		
		// Check excludes
		for _, exc := range excludes {
			if strings.HasPrefix(relPath, exc) {
				if info.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
		}

		destPath := filepath.Join(dest, relPath)

		if info.IsDir() {
			return os.MkdirAll(destPath, info.Mode())
		}

		// Symlink handling? For node_modules?
		// For robustness, let's just copy regular files.
		// If symlink, we could replicate it.
		
		return copyFile(path, destPath)
	})
}

func copyFile(src, dest string) error {
	source, err := os.Open(src)
	if err != nil {
		return err
	}
	defer source.Close()

	destination, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer destination.Close()

	_, err = io.Copy(destination, source)
	return err
}
