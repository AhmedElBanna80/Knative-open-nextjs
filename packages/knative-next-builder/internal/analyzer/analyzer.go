package analyzer

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Analyze reads the .next directory and extracts build metadata
func Analyze(projectDir string) (*AnalysisResult, error) {
	nextDir := filepath.Join(projectDir, ".next")

	requiredServerFilesPath := filepath.Join(nextDir, "required-server-files.json")
	if _, err := os.Stat(requiredServerFilesPath); os.IsNotExist(err) {
		return nil, fmt.Errorf("required-server-files.json not found in %s", nextDir)
	}

	configFile, err := os.ReadFile(requiredServerFilesPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read required-server-files.json: %w", err)
	}

	var requiredServerFiles RequiredServerFiles
	if err := json.Unmarshal(configFile, &requiredServerFiles); err != nil {
		return nil, fmt.Errorf("failed to parse required-server-files.json: %w", err)
	}

	return &AnalysisResult{
		ProjectDir: projectDir,
		NextConfig: requiredServerFiles.Config,
	}, nil
}
