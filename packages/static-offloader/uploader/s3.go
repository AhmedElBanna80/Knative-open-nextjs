package uploader

import (
	"context"
	"fmt"
	"mime"
	"os"
	"path/filepath"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	cnf "github.com/knative-next/static-offloader/config"
)

// S3Uploader implements the Uploader interface using AWS SDK v2
type S3Uploader struct {
	Client    *s3.Client
	Bucket    string
	PublicURL string
}

// NewS3Uploader initializes an S3 client from the given domain config
func NewS3Uploader(ctx context.Context, infrastructure cnf.Infrastructure) (*S3Uploader, error) {
	s3Config := infrastructure.S3Service

	// Load AWS Configuration
	// We use the credentials from the config object
	creds := credentials.NewStaticCredentialsProvider(
		s3Config.AccessKey,
		s3Config.SecretKey,
		"",
	)

	// Custom Endpoint Resolver for MinIO/GCS compatibility
	endpointResolver := aws.EndpointResolverWithOptionsFunc(func(service, region string, options ...interface{}) (aws.Endpoint, error) {
		return aws.Endpoint{
			URL:           s3Config.Endpoint,
			SigningRegion: s3Config.Region,
		}, nil
	})

	cfg, err := config.LoadDefaultConfig(ctx,
		config.WithRegion(s3Config.Region),
		config.WithCredentialsProvider(creds),
		config.WithEndpointResolverWithOptions(endpointResolver),
	)
	if err != nil {
		return nil, fmt.Errorf("unable to load SDK config: %w", err)
	}

	client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.UsePathStyle = true // Often needed for non-AWS S3
	})

	return &S3Uploader{
		Client:    client,
		Bucket:    s3Config.Bucket,
		PublicURL: s3Config.PublicURL,
	}, nil
}

func (s *S3Uploader) Upload(localPath, remoteKey string) (string, error) {
	file, err := os.Open(localPath)
	if err != nil {
		return "", fmt.Errorf("failed to open file %s: %w", localPath, err)
	}
	defer file.Close()

	// Detect Content-Type
	contentType := mime.TypeByExtension(filepath.Ext(localPath))
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	_, err = s.Client.PutObject(context.TODO(), &s3.PutObjectInput{
		Bucket:      aws.String(s.Bucket),
		Key:         aws.String(remoteKey),
		Body:        file,
		ContentType: aws.String(contentType),
		// CacheControl? ACL? (Usually public-read if not using policy)
	})

	if err != nil {
		return "", fmt.Errorf("failed to put object %s: %w", remoteKey, err)
	}

	return fmt.Sprintf("%s/%s", s.PublicURL, remoteKey), nil
}
