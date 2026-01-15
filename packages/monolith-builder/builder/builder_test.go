package builder

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// MockExecutor allows us to verify command execution without running actual Bun
type MockExecutor struct {
	CommandsExecuted []string
}

func (m *MockExecutor) Run(cmd string, args ...string) error {
	m.CommandsExecuted = append(m.CommandsExecuted, cmd+" "+strings.Join(args, " "))
	return nil
}

func TestBuildMonolith(t *testing.T) {
	// 1. Setup
	tmpDir, _ := os.MkdirTemp("", "builder-test")
	defer os.RemoveAll(tmpDir)

	config := BuildConfig{
		Params: BuildParams{
			Zone:      "dashboard",
			BaseImage: "oven/bun:alpine",
			Entrypoint: "server.js",
		},
	}

	mockExec := &MockExecutor{}
	b := NewBuilder(mockExec)

	// 2. Execute
	err := b.Build(tmpDir, config)
	if err != nil {
		t.Fatalf("Build failed: %v", err)
	}

	// 3. Verify Dockerfile Creation
	dockerfilePath := filepath.Join(tmpDir, "Dockerfile")
	if _, err := os.Stat(dockerfilePath); os.IsNotExist(err) {
		t.Error("Dockerfile was not created")
	}

	content, _ := os.ReadFile(dockerfilePath)
	strContent := string(content)

	if !strings.Contains(strContent, "FROM oven/bun:alpine") {
		t.Error("Dockerfile missing Base Image")
	}
	if !strings.Contains(strContent, "COPY --from=builder") {
		t.Error("Dockerfile missing multi-stage copy")
	}

	// 4. Verify Bun Build Command
	if len(mockExec.CommandsExecuted) == 0 {
		t.Error("No commands executed")
	}
	expectedCmd := "bun build --compile --bytecode --minify --sourcemap ./server.js --outfile server"
	found := false
	for _, cmd := range mockExec.CommandsExecuted {
		if cmd == expectedCmd {
			found = true
		}
	}
	if !found {
		t.Errorf("Expected command '%s' not found. Executed: %v", expectedCmd, mockExec.CommandsExecuted)
	}
}
