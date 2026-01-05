package analyzer

// RequiredServerFiles represents the structure of .next/required-server-files.json
type RequiredServerFiles struct {
	Version int                    `json:"version"`
	Config  map[string]interface{} `json:"config"`
	AppDir  string                 `json:"appDir"`
	Files   []string               `json:"files"`
	Ignore  []string               `json:"ignore"`
}

// RoutesManifest represents the structure of .next/routes-manifest.json
// We might not need deep details here yet, but defining the basic entries.
type RoutesManifest struct {
	Version int `json:"version"`
	// Add other fields if strictly necessary for the builder
}

// AnalysisResult holds the extracted information needed for the build
type AnalysisResult struct {
	ProjectDir string
	NextConfig map[string]interface{}
}
