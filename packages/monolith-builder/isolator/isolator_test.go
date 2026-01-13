package isolator

import (
	"os"
	"path/filepath"
	"testing"
)

func TestIsolate(t *testing.T) {
	// 1. Setup Source Directory
	srcDir, _ := os.MkdirTemp("", "iso-src")
	defer os.RemoveAll(srcDir)
	
	// Create dummy files
	// src/app/page.js
	// src/node_modules/foo/index.js
	os.MkdirAll(filepath.Join(srcDir, "app"), 0755)
	os.MkdirAll(filepath.Join(srcDir, "node_modules", "foo"), 0755)
	os.WriteFile(filepath.Join(srcDir, "app/page.js"), []byte("page"), 0644)
	os.WriteFile(filepath.Join(srcDir, "node_modules/foo/index.js"), []byte("foo"), 0644)

	// 2. Setup Dest Directory
	destDir, _ := os.MkdirTemp("", "iso-dest")
	defer os.RemoveAll(destDir)

	// 3. Define File List (Relative to srcDir)
	files := []string{
		"app/page.js",
		"node_modules/foo/index.js",
	}

	// 4. Execute Isolate
	err := Isolate(srcDir, destDir, files)
	if err != nil {
		t.Fatalf("Isolate failed: %v", err)
	}

	// 5. Verify
	if _, err := os.Stat(filepath.Join(destDir, "app/page.js")); os.IsNotExist(err) {
		t.Error("app/page.js not copied")
	}
	if _, err := os.Stat(filepath.Join(destDir, "node_modules/foo/index.js")); os.IsNotExist(err) {
		t.Error("node_modules/foo/index.js not copied")
	}
}
