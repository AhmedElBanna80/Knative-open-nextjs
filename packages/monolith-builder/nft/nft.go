package nft

import (
	"encoding/json"
	"fmt"
	"os"
)

type NFTTrace struct {
	Version int      `json:"version"`
	Files   []string `json:"files"`
}

// ParseNFT reads a Vercel NFT (Node File Trace) JSON file and returns the list of files.
func ParseNFT(path string) ([]string, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("failed to read NFT file: %w", err)
	}

	var trace NFTTrace
	if err := json.Unmarshal(content, &trace); err != nil {
		return nil, fmt.Errorf("failed to parse NFT JSON: %w", err)
	}

	return trace.Files, nil
}
