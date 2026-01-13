package uploader

// MockUploader implements the Upload interface for testing and dry-runs
type MockUploader struct {
	BaseURL       string
	UploadedFiles map[string]string // Key: LocalPath, Value: RemoteURL
}

func (m *MockUploader) Upload(localPath, remoteKey string) (string, error) {
	if m.UploadedFiles == nil {
		m.UploadedFiles = make(map[string]string)
	}
	// Simulate public URL construction using the configured BaseURL
	// In dry-run, BaseURL might be empty or a placeholder
	baseURL := m.BaseURL
	if baseURL == "" {
		baseURL = "https://cdn.example.com"
	}
	
	url := baseURL + "/" + remoteKey
	m.UploadedFiles[localPath] = url
	return url, nil
}
