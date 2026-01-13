package uploader

import (
	"fmt"
	"strings"

	"github.com/knative-next/static-offloader/config"
)

// Uploader defines the interface for uploading files to a remote store.
type Uploader interface {
	Upload(localPath, remoteKey string) (string, error)
}

// OffloadAssets uploads the given list of assets using the provided uploader
// and configuration. It returns a map of LocalPath -> PublicURL.
func OffloadAssets(cfg config.Config, upl Uploader, assets []string) (map[string]string, error) {
	result := make(map[string]string)

	for _, asset := range assets {
		// Construct the remote key.
		// For Next.js, we typically want to preserve the path structure from the root.
		// asset: ".next/static/css/main.123.css"
		// remoteKey: ".next/static/css/main.123.css" (or maybe configured prefix?)
		
		// Ensure clean paths (remove ./ prefix if present)
		cleanPath := strings.TrimPrefix(asset, "./")
		
		// Upload
		// We use the cleanPath as the key.
		url, err := upl.Upload(asset, cleanPath)
		if err != nil {
			return nil, fmt.Errorf("failed to upload %s: %w", asset, err)
		}

		// Verify the URL matches the config's public URL base?
		// The mock does this.
		result[asset] = url
	}

	return result, nil
}
