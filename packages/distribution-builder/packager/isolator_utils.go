package packager

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// patchServerJSConfig rewrites the hardcoded outputFileTracingRoot in server.js
func (iso *Isolator) patchServerJSConfig(serverJsPath string) error {
	content, err := os.ReadFile(serverJsPath)
	if err != nil {
		return err
	}
	
	// We need to find the SourceRoot to replace, similar to required-server-files.json
	appName := "apps/file-manager"
	standaloneSuffix := filepath.Join(appName, ".next/standalone")
	sourceRoot := strings.TrimSuffix(iso.ProjectRoot, standaloneSuffix)
	
	// Fallback logic
	if sourceRoot == iso.ProjectRoot {
		parts := strings.Split(iso.ProjectRoot, ".next")
		if len(parts) > 0 {
			sourceRoot = filepath.Dir(filepath.Dir(parts[0]))
		}
	}
	sourceRoot = filepath.Clean(sourceRoot)
	
	fmt.Printf("DEBUG: Patching server.js. Replacing %s with /app\n", sourceRoot)
	
	strContent := string(content)
	patchedContent := strings.ReplaceAll(strContent, sourceRoot, "/app")
	
	return os.WriteFile(serverJsPath, []byte(patchedContent), 0644)
}
