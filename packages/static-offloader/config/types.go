package config

// Config mirrors the structure of cn-next.config.ts
type Config struct {
	Infrastructure Infrastructure `json:"infrastructure"`
}

type Infrastructure struct {
	S3Service S3Service `json:"s3_service"`
}

type S3Service struct {
	Endpoint  string `json:"endpoint"`
	Bucket    string `json:"bucket"`
	Region    string `json:"region"`
	AccessKey string `json:"access_key"`
	SecretKey string `json:"secret_key"`
	PublicURL string `json:"public_url"`
	UseSSL    bool   `json:"use_ssl"`
}
