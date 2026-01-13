package main

import (
	"flag"
	"log"
	"os"
	"os/exec"

	"github.com/knative-next/monolith-builder/builder"
	"github.com/knative-next/monolith-builder/isolator"
	"github.com/knative-next/monolith-builder/nft"
	"github.com/knative-next/monolith-builder/orchestrator"
)

// Real implementations
type RealExecutor struct{}
func (e *RealExecutor) Run(cmd string, args ...string) error {
	c := exec.Command(cmd, args...)
	c.Stdout = os.Stdout
	c.Stderr = os.Stderr
	return c.Run()
}

func main() {
	srcDir := flag.String("src", ".", "Source directory of the app")
	outDir := flag.String("out", "./dist", "Output directory for the isolated build")
	entrypoint := flag.String("entrypoint", "app/page.js", "Entrypoint file relative to src (NFT Source)")
	flag.Parse()

	// Initialize Components
	// We use local adapters to fit the Orchestrator interfaces
	
	p := &NFTAdapter{}
	i := &IsolatorAdapter{}
	b := builder.NewBuilder(&RealExecutor{})

	orch := orchestrator.New(p, i, b)

	cfg := orchestrator.Config{
		Entrypoint: *entrypoint,
		OutputDir:  *outDir,
		SrcDir:     *srcDir,
	}

	log.Printf("Starting build for %s -> %s", *entrypoint, *outDir)
	if err := orch.Run(cfg); err != nil {
		log.Fatalf("Build failed: %v", err)
	}
	log.Println("Build complete.")
}

// Adapters to fit the Orchestrator interfaces

type NFTAdapter struct{}
func (n *NFTAdapter) Parse(path string) ([]string, error) {
	return nft.ParseNFT(path)
}

type IsolatorAdapter struct{}
func (i *IsolatorAdapter) Isolate(src, dest string, files []string) error {
	return isolator.Isolate(src, dest, files)
}
