package uploader

import (
	"testing"

	"github.com/knative-next/static-offloader/config"
)

// MockUploader definition moved to mock.go

// TestStaticAssetOffload verifies that the offloader correctly:
// 1. Accepts a GKE-production-like configuration
// 2. Identifies static assets
// 3. Delegation upload to the S3 client
func TestStaticAssetOffload(t *testing.T) {
	// 1. Setup GKE-like Configuration (The "Test Config Variables")
	cfg := config.Config{
		Infrastructure: config.Infrastructure{
			S3Service: config.S3Service{
				Endpoint:  "s3.us-east-1.amazonaws.com",
				Bucket:    "knative-next-assets-prod",
				Region:    "us-east-1",
				AccessKey: "AKIA_TEST_ACCESS_KEY",
				SecretKey: "SECRET_TEST_KEY",
				PublicURL: "https://assets.knative-next.dev",
				UseSSL:    true,
			},
		},
	}

	// 2. Setup Mock Uploader
	mockS3 := &MockUploader{
		BaseURL: cfg.Infrastructure.S3Service.PublicURL,
	}
	
	// 3. Define Assets to Offload (Simulating .next/static)
	assets := []string{
		".next/static/css/main.12345.css",
		".next/static/chunks/app-123.js",
	}

	// 4. Executing the Logic (This function doesn't exist yet - TDD!)
	// We expect a map of Source -> PublicURL back
	uploaded, err := OffloadAssets(cfg, mockS3, assets)

	if err != nil {
		t.Fatalf("OffloadAssets failed: %v", err)
	}

	// 5. Assertions
	if len(uploaded) != 2 {
		t.Errorf("Expected 2 uploaded files, got %d", len(uploaded))
	}

	expectedURL := cfg.Infrastructure.S3Service.PublicURL + "/.next/static/css/main.12345.css"
	if uploaded[".next/static/css/main.12345.css"] != expectedURL {
		t.Errorf("URL mismatch. Expected %s, got %s", expectedURL, uploaded[".next/static/css/main.12345.css"])
	}
}
