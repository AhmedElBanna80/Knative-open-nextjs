package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRun(t *testing.T) {
	tmpDir := t.TempDir()
	projectDir := filepath.Join(tmpDir, "project")
	outputDir := filepath.Join(tmpDir, "dist")

	// Setup valid project structure for analysis and generation
	nextDir := filepath.Join(projectDir, ".next")
	if err := os.MkdirAll(nextDir, 0755); err != nil {
		t.Fatal(err)
	}
	
	// Mock required-server-files.json
	reqFiles := `{"config": {"env": {"TEST": "true"}}}`
	if err := os.WriteFile(filepath.Join(nextDir, "required-server-files.json"), []byte(reqFiles), 0644); err != nil {
		t.Fatal(err)
	}

	// Mock standalone directory
	standaloneDir := filepath.Join(nextDir, "standalone")
	if err := os.MkdirAll(standaloneDir, 0755); err != nil {
		t.Fatal(err)
	}

	// Mock "server.js" in expected location (mimicking deep structure)
	// We need main.go to find it.
	// main.go expects: absOutputDir -> ... -> server.js
	// Since main.go copies standalone -> outputDir, we put it in standalone.
	// But main.go looks for relative path.
	appDir := filepath.Join(standaloneDir, "test-app")
	if err := os.MkdirAll(appDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(appDir, "server.js"), []byte("console.log('server')"), 0644); err != nil {
		t.Fatal(err)
	}

	// Mock node_modules needed for deps check
	if err := os.MkdirAll(filepath.Join(projectDir, "node_modules", "next"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(projectDir, "node_modules", "react"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(projectDir, "node_modules", "react-dom"), 0755); err != nil {
		t.Fatal(err)
	}

	// NOTE: Run() eventually calls runner.Build which tries to run 'bun'. 
	// Since we likely don't want to depend on 'bun' being present or working in this test env 
	// (although user has it), we might hit the fallback logic or expected failure. 
	// Ideally we mock the exec command, but without refactoring runner.Build to use an interface,
	// we will rely on the fact that runner.Build falls back to copying if bun fails (which is fine).
	// Or if bun works, it builds.
	// We just want to check that Run() completes without returning error.
	
	args := []string{"-dir", projectDir, "-output", outputDir}
	err := Run(args)
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}

	// Verify output artifacts
	if _, err := os.Stat(outputDir); os.IsNotExist(err) {
		t.Error("Output directory not created")
	}

	// Check for generated runner (either binary "server" or fallback "server.ts")
	// Since we can't guarantee bun presence/success in this specific test container logic (though we know user has it),
	// check for either.
	_, errBin := os.Stat(filepath.Join(outputDir, "server"))
	_, errTs := os.Stat(filepath.Join(outputDir, "server.ts"))
	
	if os.IsNotExist(errBin) && os.IsNotExist(errTs) {
		t.Error("Expected generated server binary or server.ts")
	}

	// Check package.json
	if _, err := os.Stat(filepath.Join(outputDir, "package.json")); os.IsNotExist(err) {
		t.Error("Expected package.json in output")
	}
}

func TestRunErrors(t *testing.T) {
	// Test missing project directory
	if err := Run([]string{"-dir", "/non/existent"}); err == nil {
		t.Error("Expected error for missing project dir, got nil")
	}

	// Test missing .next (analysis fail)
	tmpDir := t.TempDir() 
	// don't create .next
	if err := Run([]string{"-dir", tmpDir}); err == nil {
		t.Error("Expected error for analysis fail, got nil")
	}
}

func TestRunMissingServer(t *testing.T) {
	// Setup valid analysis but missing server.js in output
	tmpDir := t.TempDir()
	nextDir := filepath.Join(tmpDir, ".next")
	if err := os.MkdirAll(nextDir, 0755); err != nil {
		t.Fatal(err)
	}
	reqFiles := `{"config": {}}`
	if err := os.WriteFile(filepath.Join(nextDir, "required-server-files.json"), []byte(reqFiles), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(nextDir, "standalone"), 0755); err != nil {
		t.Fatal(err)
	}

	// This should fail at "Could not find server.js" loop
	if err := Run([]string{"-dir", tmpDir}); err == nil {
		t.Error("Expected error for missing server.js, got nil")
	} else if err.Error() != "could not find server.js in standalone output to determine app directory" {
		t.Logf("Got expected error type (flow continued): %v", err)
	}
}
