package orchestrator

import (
	"testing"

	"github.com/knative-next/monolith-builder/builder"
)

// Mock dependencies
type MockNFTParser struct {
	Files []string
}
func (m *MockNFTParser) Parse(path string) ([]string, error) {
	return m.Files, nil
}

type MockIsolator struct {
	CapturedFiles []string
	CapturedDest  string
}
func (m *MockIsolator) Isolate(src, dest string, files []string) error {
	m.CapturedFiles = files
	m.CapturedDest = dest
	return nil
}

type MockBuilder struct {
	CapturedDir string
}
func (m *MockBuilder) Build(dir string, cfg builder.BuildConfig) error {
	m.CapturedDir = dir
	return nil
}

func TestRun(t *testing.T) {
	// 1. Setup Mocks
	mockNFT := &MockNFTParser{Files: []string{"a.js", "b.js"}}
	mockIso := &MockIsolator{}
	mockBld := &MockBuilder{}

	orch := New(mockNFT, mockIso, mockBld)

	// 2. Execute
	config := Config{
		Entrypoint: "app/page.js",
		OutputDir:  "/tmp/dist",
		SrcDir:     "/app",
	}
	err := orch.Run(config)
	if err != nil {
		t.Fatalf("Orchestrator Run failed: %v", err)
	}

	// 3. Verify Sequence
	// A. NFT Parse Called (Implicit via Files used in Isolate)
	// B. Isolate Called with correct files
	if len(mockIso.CapturedFiles) != 2 {
		t.Error("Isolator received wrong number of files")
	}
	if mockIso.CapturedDest != "/tmp/dist" {
		t.Errorf("Isolator dest mismatch. Got %s", mockIso.CapturedDest)
	}

	// C. Builder Called on the output dir
	if mockBld.CapturedDir != "/tmp/dist" {
		t.Errorf("Builder dir mismatch. Got %s", mockBld.CapturedDir)
	}
}
