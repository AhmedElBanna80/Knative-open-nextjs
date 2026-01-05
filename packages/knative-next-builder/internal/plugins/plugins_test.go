package plugins

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGenerateBunPlugin(t *testing.T) {
	tmpDir := t.TempDir()

	path, err := GenerateBunPlugin(tmpDir)
	if err != nil {
		t.Fatalf("GenerateBunPlugin failed: %v", err)
	}

	if filepath.Base(path) != "bun-plugin.js" {
		t.Errorf("Expected filename bun-plugin.js, got %s", filepath.Base(path))
	}

	contentBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("Failed to read generated file: %v", err)
	}
	content := string(contentBytes)

	checks := []string{
		`name: "nextjs-internal-resolver"`,
		`build.onResolve({ filter: /^react-server-dom-webpack\/client$/ }`,
		`const NEXT_DIST = findNextDist();`,
	}

	for _, check := range checks {
		if !strings.Contains(content, check) {
			t.Errorf("Generated plugin missing expected string: %s", check)
		}
	}
}

func TestGenerateBunPluginErrors(t *testing.T) {
	// Test permission error
	if _, err := GenerateBunPlugin("/root/protected"); err == nil {
		t.Error("Expected error for protected directory, got nil")
	}
}
