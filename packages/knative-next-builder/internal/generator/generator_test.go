package generator

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGenerateRunner(t *testing.T) {
	tmpDir := t.TempDir()
	relativeAppDir := "apps/test-app"
	
	config := map[string]interface{}{
		"env": map[string]interface{}{
			"TEST_VAR": "test_value",
		},
	}

	path, err := GenerateRunner(config, tmpDir, relativeAppDir)
	if err != nil {
		t.Fatalf("GenerateRunner failed: %v", err)
	}

	if filepath.Base(path) != "bun-runner.ts" {
		t.Errorf("Expected filename bun-runner.ts, got %s", filepath.Base(path))
	}

	contentBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("Failed to read generated file: %v", err)
	}
	content := string(contentBytes)

	// Check for key components in the generated content
	checks := []string{
		`console.log('DEBUG: Runner init');`,
		`const nextConfig = {"env":{"TEST_VAR":"test_value"}};`,
		`const relativeAppDir = "apps/test-app";`,
		`process.env[key] = String(value);`,
	}

	for _, check := range checks {
		if !strings.Contains(content, check) {
			t.Errorf("Generated content missing expected string: %s", check)
		}
	}
}

func TestGeneratePackageJSON(t *testing.T) {
	tmpDir := t.TempDir()

	err := GeneratePackageJSON(tmpDir)
	if err != nil {
		t.Fatalf("GeneratePackageJSON failed: %v", err)
	}

	pkgPath := filepath.Join(tmpDir, "package.json")
	contentBytes, err := os.ReadFile(pkgPath)
	if err != nil {
		t.Fatalf("Failed to read package.json: %v", err)
	}

	var pkg map[string]interface{}
	if err := json.Unmarshal(contentBytes, &pkg); err != nil {
		t.Fatalf("Failed to parse package.json: %v", err)
	}

	if pkg["name"] != "knative-built-app" {
		t.Errorf("Expected package name 'knative-built-app', got %v", pkg["name"])
	}

	deps, ok := pkg["dependencies"].(map[string]interface{})
	if !ok {
		t.Fatalf("dependencies field matches expected type")
	}

	expectedDeps := []string{"next", "react", "react-dom", "sharp"}
	for _, dep := range expectedDeps {
		if _, exists := deps[dep]; !exists {
			t.Errorf("Missing dependency: %s", dep)
		}
	}
}

func TestGenerateRunnerErrors(t *testing.T) {
	// Test permission error
	if _, err := GenerateRunner(nil, "/root/protected", "app"); err == nil {
		t.Error("Expected error for protected directory, got nil")
	}

	// Test marshal error
	badConfig := map[string]interface{}{
		"fn": func() {},
	}
	if _, err := GenerateRunner(badConfig, t.TempDir(), "app"); err == nil {
		t.Error("Expected error for unmarshallable config, got nil")
	}
}

func TestGeneratePackageJSONErrors(t *testing.T) {
	// Test permission error
	if err := GeneratePackageJSON("/root/protected"); err == nil {
		t.Error("Expected error for protected directory, got nil")
	}
}
