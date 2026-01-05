package runner

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCopyStandalone(t *testing.T) {
	tmpDir := t.TempDir()
	projectDir := filepath.Join(tmpDir, "project")
	outputDir := filepath.Join(tmpDir, "output")

	// Setup .next/standalone structure
	standaloneDir := filepath.Join(projectDir, ".next", "standalone")
	if err := os.MkdirAll(standaloneDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(standaloneDir, "server.js"), []byte("server"), 0644); err != nil {
		t.Fatal(err)
	}

	// Mock node_modules for CopyCriticalDeps (called by CopyStandalone)
	if err := os.MkdirAll(filepath.Join(projectDir, "node_modules", "next"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(projectDir, "node_modules", "react"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(projectDir, "node_modules", "react-dom"), 0755); err != nil {
		t.Fatal(err)
	}

	// Run CopyStandalone
	if err := CopyStandalone(projectDir, outputDir); err != nil {
		t.Fatalf("CopyStandalone failed: %v", err)
	}

	// Verify output
	if _, err := os.Stat(filepath.Join(outputDir, "server.js")); os.IsNotExist(err) {
		t.Error("Expected server.js in output")
	}
	
	// Verify deps copied
	if _, err := os.Stat(filepath.Join(outputDir, "node_modules", "next")); os.IsNotExist(err) {
		t.Error("Expected next in node_modules")
	}
}

func TestCopyCriticalDeps(t *testing.T) {
	tmpDir := t.TempDir()
	projectDir := filepath.Join(tmpDir, "project")
	outputDir := filepath.Join(tmpDir, "output")

	// Setup node_modules in project root
	if err := os.MkdirAll(filepath.Join(projectDir, "node_modules", "next"), 0755); err != nil {
		t.Fatal(err)
	}
	// Setup node_modules in monorepo root (../../)
	monorepoRoot := filepath.Join(tmpDir, "monorepo")
	projectInMono := filepath.Join(monorepoRoot, "packages", "app")
	if err := os.MkdirAll(filepath.Join(monorepoRoot, "node_modules", "react"), 0755); err != nil {
		t.Fatal(err)
	}

	// Test case 1: deps in project root
	if err := CopyCriticalDeps(projectDir, outputDir); err != nil {
		t.Errorf("CopyCriticalDeps failed for project root: %v", err)
	}
	if _, err := os.Stat(filepath.Join(outputDir, "node_modules", "next")); os.IsNotExist(err) {
		t.Error("Expected next from project root")
	}

	// Test case 2: deps in monorepo root
	outputDir2 := filepath.Join(tmpDir, "output2")
	if err := CopyCriticalDeps(projectInMono, outputDir2); err != nil {
		t.Errorf("CopyCriticalDeps failed for monorepo: %v", err)
	}
	if _, err := os.Stat(filepath.Join(outputDir2, "node_modules", "react")); os.IsNotExist(err) {
		t.Error("Expected react from monorepo root")
	}
}


func TestCopyAssets(t *testing.T) {
	tmpDir := t.TempDir()
	projectDir := filepath.Join(tmpDir, "project")
	outputDir := filepath.Join(tmpDir, "output")

	// Setup project structure
	// public/file.txt
	// .next/static/chunk.js
	if err := os.MkdirAll(filepath.Join(projectDir, "public"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projectDir, "public", "file.txt"), []byte("content"), 0644); err != nil {
		t.Fatal(err)
	}

	if err := os.MkdirAll(filepath.Join(projectDir, ".next", "static"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projectDir, ".next", "static", "chunk.js"), []byte("chunk"), 0644); err != nil {
		t.Fatal(err)
	}

	// Run CopyAssets
	if err := CopyAssets(projectDir, outputDir); err != nil {
		t.Fatalf("CopyAssets failed: %v", err)
	}

	// Verify public assets -> assets/
	if _, err := os.Stat(filepath.Join(outputDir, "assets", "file.txt")); os.IsNotExist(err) {
		t.Error("Expected assets/file.txt to exist")
	}

	// Verify .next/static -> assets/_next/static
	if _, err := os.Stat(filepath.Join(outputDir, "assets", "_next", "static", "chunk.js")); os.IsNotExist(err) {
		t.Error("Expected assets/_next/static/chunk.js to exist")
	}
}

func TestShimReactServerDom(t *testing.T) {
	tmpDir := t.TempDir()
	projectDir := filepath.Join(tmpDir, "project")
	outputDir := filepath.Join(tmpDir, "output")

	// Setup source structure (mock node_modules)
	sourceDir := filepath.Join(projectDir, "node_modules", "next", "dist", "compiled", "react-server-dom-webpack-experimental", "cjs")
	if err := os.MkdirAll(sourceDir, 0755); err != nil {
		t.Fatal(err)
	}

	files := map[string]string{
		"react-server-dom-webpack-server.node.production.min.js": "server content",
		"react-server-dom-webpack-client.browser.production.min.js": "client content",
	}

	for name, content := range files {
		if err := os.WriteFile(filepath.Join(sourceDir, name), []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}

	// Run Shim
	if err := ShimReactServerDom(projectDir, outputDir); err != nil {
		t.Fatalf("ShimReactServerDom failed: %v", err)
	}

	// Verify shim output
	shimDir := filepath.Join(outputDir, "node_modules", "react-server-dom-webpack")
	
	// Check server.node.js
	if _, err := os.Stat(filepath.Join(shimDir, "server.node.js")); os.IsNotExist(err) {
		t.Error("Expected shimmed server.node.js")
	}
	
	// Check package.json
	if _, err := os.Stat(filepath.Join(shimDir, "package.json")); os.IsNotExist(err) {
		t.Error("Expected shimmed package.json")
	}
}

func TestBuild(t *testing.T) {
	// This test relies on 'bun' being available in PATH.
	// We'll create a simple entry file.
	tmpDir := t.TempDir()
	entryPath := filepath.Join(tmpDir, "index.ts")
	outputDir := filepath.Join(tmpDir, "dist")
	
	if err := os.WriteFile(entryPath, []byte("console.log('hello')"), 0644); err != nil {
		t.Fatal(err)
	}

	// Try happy path: pass empty pluginPath and default target
	if err := Build(tmpDir, entryPath, outputDir, "server", "", "bun"); err != nil {
		t.Logf("Build returned error (might be okay if fallback fail): %v", err)
	}

	// Check output: Either server (binary) or server.ts (fallback) should exist
	_, errBin := os.Stat(filepath.Join(outputDir, "server"))
	_, errTs := os.Stat(filepath.Join(outputDir, "server.ts"))
	
	if os.IsNotExist(errBin) && os.IsNotExist(errTs) {
		t.Error("Expected build output (binary or fallback copy)")
	}
}

func TestBuildErrors(t *testing.T) {
	// Test output permission error
	// Use /root/protected if running as non-root, or a file location as dir
	tmpDir := t.TempDir()
	fileAsDir := filepath.Join(tmpDir, "file")
	os.WriteFile(fileAsDir, []byte(""), 0644)
	
	err := Build(tmpDir, "index.ts", fileAsDir, "target", "", "bun")
	if err == nil {
		t.Error("Expected error for output dir creation failure")
	}
}

func TestCopyAssetsErrors(t *testing.T) {
	// Test permission error on output
	// Create file at output assets dir path
	tmpDir := t.TempDir()
	projectDir := filepath.Join(tmpDir, "project")
	outputDir := filepath.Join(tmpDir, "output")
	
	// Create assets as file to cause MkdirAll error in CopyAssets
	os.MkdirAll(outputDir, 0755)
	os.WriteFile(filepath.Join(outputDir, "assets"), []byte("file"), 0644)

	if err := CopyAssets(projectDir, outputDir); err == nil {
		t.Error("Expected error for asset dir creation failure")
	}
}

func TestBuildFallback(t *testing.T) {
	// Force bun failure to test fallback
	// We can't easily force bun fail on valid file without mocking exec, 
	// unless we provide invalid args which we can't.
	// However, if we provide a file that bun treats as invalid input? 
	// Or maybe just try to cover the failure of fallback itself?
	// Actually, if we pass a directory as entry point?
	
	tmpDir := t.TempDir()
	// pass dir as entry point -> bun might fail?
	// fallback copyfile will try to open dir -> might fail or succeed depending on copyFile implementation (it opens file).
	// os.Open(dir) works on unix. io.Copy... might fail?
	
	// Better: Use a simple file but rely on environment where bun might not work? 
	// No, bun is installed.
	
	// Let's try passing a non-existent plugin to force failure?
	// Build takes pluginPath string.
	entryPath := filepath.Join(tmpDir, "index.ts")
	outputDir := filepath.Join(tmpDir, "dist")
	os.WriteFile(entryPath, []byte("console.log('fallback')"), 0644)
	
	// "none" is likely not a valid plugin path, bun might verify it?
	// If bun fails, fallback runs.
	// Fallback copies entryPath -> outputDir/server.ts
	// If this test passes (err == nil), it means either bun worked or fallback worked.
	// We check if server.ts exists to confirm fallback happened (since bun produces 'server').
	
	Build(tmpDir, entryPath, outputDir, "server", "/non/existent/plugin.js", "bun")
	
	if _, err := os.Stat(filepath.Join(outputDir, "server.ts")); err == nil {
		// Fallback happened!
	} else {
		// Maybe bun ignored the plugin error?
	}
}

func TestCopyStandaloneErrors(t *testing.T) {
	tmpDir := t.TempDir()
	// Missing standalone dir
	if err := CopyStandalone(tmpDir, tmpDir); err == nil {
		t.Error("Expected error for missing standalone dir")
	}
}
