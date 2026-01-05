package analyzer

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestAnalyze(t *testing.T) {
	// Setup temporary project directory
	tmpDir := t.TempDir()
	nextDir := filepath.Join(tmpDir, ".next")
	if err := os.MkdirAll(nextDir, 0755); err != nil {
		t.Fatalf("Failed to create .next dir: %v", err)
	}

	// Create required-server-files.json
	config := map[string]interface{}{
		"env": map[string]interface{}{
			"DB_HOST": "localhost",
		},
	}
	requiredFiles := RequiredServerFiles{
		Config: config,
	}
	data, err := json.Marshal(requiredFiles)
	if err != nil {
		t.Fatalf("Failed to marshal config: %v", err)
	}
	
	reqFilePath := filepath.Join(nextDir, "required-server-files.json")
	if err := os.WriteFile(reqFilePath, data, 0644); err != nil {
		t.Fatalf("Failed to write required-server-files.json: %v", err)
	}

	// Run Analyze
	result, err := Analyze(tmpDir)
	if err != nil {
		t.Fatalf("Analyze failed: %v", err)
	}

	if result.ProjectDir != tmpDir {
		t.Errorf("Expected ProjectDir %s, got %s", tmpDir, result.ProjectDir)
	}

	envMap, ok := result.NextConfig["env"].(map[string]interface{})
	if !ok {
		t.Fatalf("Expected env map in NextConfig")
	}

	if envMap["DB_HOST"] != "localhost" {
		t.Errorf("Expected DB_HOST localhost, got %v", envMap["DB_HOST"])
	}
}

func TestAnalyzeMissingFile(t *testing.T) {
	tmpDir := t.TempDir()
	nextDir := filepath.Join(tmpDir, ".next")
	if err := os.MkdirAll(nextDir, 0755); err != nil {
		t.Fatalf("Failed to create .next dir: %v", err)
	}

	// don't create required-server-files.json

	_, err := Analyze(tmpDir)
	if err == nil {
		t.Error("Expected error for missing required-server-files.json, got nil")
	}
}

func TestAnalyzeInvalidJSON(t *testing.T) {
	tmpDir := t.TempDir()
	nextDir := filepath.Join(tmpDir, ".next")
	if err := os.MkdirAll(nextDir, 0755); err != nil {
		t.Fatalf("Failed to create .next dir: %v", err)
	}

	reqFilePath := filepath.Join(nextDir, "required-server-files.json")
	if err := os.WriteFile(reqFilePath, []byte("{invalid-json"), 0644); err != nil {
		t.Fatalf("Failed to write invalid json file: %v", err)
	}

	_, err := Analyze(tmpDir)
	if err == nil {
		t.Error("Expected error for invalid json, got nil")
	}
}
