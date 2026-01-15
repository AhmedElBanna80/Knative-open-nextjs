package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"

	"github.com/knative-next/static-offloader/config"
	"github.com/knative-next/static-offloader/uploader"
)

func main() {
	rootDir := flag.String("root", ".", "Root directory of the Next.js app")
	dryRun := flag.Bool("dry-run", false, "Perform a dry run without uploading")
	flag.Parse()

	// 1. Read Configuration from Stdin
	var infra config.Infrastructure
	input, err := io.ReadAll(os.Stdin)
	if err != nil {
		log.Fatalf("Failed to read config from stdin: %v", err)
	}
	if err := json.Unmarshal(input, &infra); err != nil {
		log.Fatalf("Failed to parse config JSON: %v", err)
	}

	// 2. Locate .next/static
	staticDir := filepath.Join(*rootDir, ".next", "static")
	if _, err := os.Stat(staticDir); os.IsNotExist(err) {
		log.Fatalf("Static directory not found at: %s", staticDir)
	}

	// 3. Scan Files
	var assets []string
	err = filepath.Walk(staticDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() {
			// We want path relative to root, e.g. .next/static/css/main.css
			rel, _ := filepath.Rel(*rootDir, path)
			assets = append(assets, rel)
		}
		return nil
	})
	if err != nil {
		log.Fatalf("Error scanning static assets: %v", err)
	}

	log.Printf("Found %d static assets to offload.", len(assets))

	// 4. Initialize Uploader
	var assetUploader uploader.Uploader
	if *dryRun {
		log.Println("Dry Run: Using Mock Uploader")
		assetUploader = &uploader.MockUploader{
			BaseURL: infra.S3Service.PublicURL,
		}
	} else {
		assetUploader, err = uploader.NewMinIOUploader(context.TODO(), infra)
		if err != nil {
			log.Fatalf("Failed to initialize MinIO Uploader: %v", err)
		}
	}

	// 5. Check Bucket Access (Optional fast fail)
	// ...

	// 6. Execute Upload
	results, err := uploader.OffloadAssets(config.Config{Infrastructure: infra}, assetUploader, assets)
	if err != nil {
		log.Fatalf("Upload failed: %v", err)
	}

	// 7. Output Results (JSON)
	output, _ := json.MarshalIndent(results, "", "  ")
	fmt.Println(string(output))
}
