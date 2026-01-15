package analyzer

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// ParseNFT reads a Next.js NFT (Node File Trace) JSON file and returns the list of file paths.
// The paths in the JSON are relative to the .nft.json file itself.
// This function resolves them to be relative to the provided projectRoot.
func ParseNFT(nftPath string, projectRoot string) ([]string, error) {
	data, err := os.ReadFile(nftPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read NFT file: %w", err)
	}

	var trace NFTTrace
	if err := json.Unmarshal(data, &trace); err != nil {
		return nil, fmt.Errorf("failed to parse NFT JSON: %w", err)
	}

	nftDir := filepath.Dir(nftPath)
	var resolvedFiles []string

	for _, file := range trace.Files {
		// NFT paths are relative to the json file
		absPath := filepath.Join(nftDir, file)
		
		// Relativize to project root to get clean paths
		relToRoot, err := filepath.Rel(projectRoot, absPath)
		if err != nil {
			// If we can't relativize, it might be outside root (unlikely for standalone, but possible for system libs)
			// For now, warn and skip, or keep absolute? 
			// Standalone build usually copies everything into project root or deps.
			fmt.Printf("Warning: could not relativize path %s to root %s: %v\n", absPath, projectRoot, err)
			continue
		}
		resolvedFiles = append(resolvedFiles, relToRoot)
	}

	return resolvedFiles, nil
}
