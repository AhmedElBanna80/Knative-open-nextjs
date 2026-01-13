package nft

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseNFT(t *testing.T) {
	// 1. Setup Mock NFT File
	tmpDir, _ := os.MkdirTemp("", "nft-test")
	defer os.RemoveAll(tmpDir)

	nftContent := `{
		"version": 1,
		"files": [
			"../shared/utils.js",
			"../../node_modules/react/index.js",
			"page.js"
		]
	}`

	nftPath := filepath.Join(tmpDir, "page.js.nft.json")
	if err := os.WriteFile(nftPath, []byte(nftContent), 0644); err != nil {
		t.Fatalf("Failed to write mock NFT: %v", err)
	}

	// 2. Execute
	files, err := ParseNFT(nftPath)
	if err != nil {
		t.Fatalf("ParseNFT failed: %v", err)
	}

	// 3. Verify
	if len(files) != 3 {
		t.Errorf("Expected 3 files, got %d", len(files))
	}

	expectedFirst := "../shared/utils.js"
	if files[0] != expectedFirst {
		t.Errorf("Expected first file %s, got %s", expectedFirst, files[0])
	}
}
