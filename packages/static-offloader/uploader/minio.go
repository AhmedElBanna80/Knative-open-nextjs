package uploader

import (
	"context"
	"fmt"
	"mime"
	"path/filepath"

	"github.com/knative-next/static-offloader/config"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// MinIOUploader implements the Uploader interface using MinIO SDK
type MinIOUploader struct {
	Client    *minio.Client
	Bucket    string
	PublicURL string
}

// NewMinIOUploader initializes a MinIO client from the given domain config
func NewMinIOUploader(ctx context.Context, infrastructure config.Infrastructure) (*MinIOUploader, error) {
	s3Config := infrastructure.S3Service

	// Remove schema from endpoint for MinIO client (it expects host:port)
	endpoint := s3Config.Endpoint
	// simple strip for now, robust solution would use url.Parse
	if len(endpoint) > 8 && endpoint[:8] == "https://" {
		endpoint = endpoint[8:]
	} else if len(endpoint) > 7 && endpoint[:7] == "http://" {
		endpoint = endpoint[7:]
	}

	// Initialize MinIO client object
	minioClient, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(s3Config.AccessKey, s3Config.SecretKey, ""),
		Secure: s3Config.UseSSL,
		Region: s3Config.Region,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create minio client: %w", err)
	}

	return &MinIOUploader{
		Client:    minioClient,
		Bucket:    s3Config.Bucket,
		PublicURL: s3Config.PublicURL,
	}, nil
}

func (u *MinIOUploader) Upload(localPath, remoteKey string) (string, error) {
	ctx := context.Background()

	// Content Type
	contentType := mime.TypeByExtension(filepath.Ext(localPath))
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	// Upload
	_, err := u.Client.FPutObject(ctx, u.Bucket, remoteKey, localPath, minio.PutObjectOptions{
		ContentType: contentType,
		// MinIO SDK handles multipart automatically for large files
	})
	if err != nil {
		return "", fmt.Errorf("failed to upload object: %w", err)
	}

	return fmt.Sprintf("%s/%s", u.PublicURL, remoteKey), nil
}
