package analyzer

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

// ParseClientManifest executes the external Bun script to parse the complex JS manifest
// and returns the list of client-side chunks (JS/CSS) required for the page.
func ParseClientManifest(manifestPath string) ([]string, error) {
	// Locate the script relative to the current working directory (assumed project root)
	// In a real CLI, we might bundle this, but for now we assume we run from project root.
	scriptPath := "scripts/resolve-client-manifest.ts"
	
	cmd := exec.Command("bun", scriptPath, manifestPath)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("failed to execute manifest resolver: %s, output: %s", err, string(output))
	}

	// Output should be a JSON array of strings
	trimmed := strings.TrimSpace(string(output))
	var chunks []string
	if err := json.Unmarshal([]byte(trimmed), &chunks); err != nil {
		return nil, fmt.Errorf("failed to parse manifest script output: %w, output: %s", err, trimmed)
	}

	return chunks, nil
}
