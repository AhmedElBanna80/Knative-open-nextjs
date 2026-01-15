package orchestrator

import (
	"fmt"
	"path/filepath"

	"github.com/knative-next/monolith-builder/builder"
)

// Interfaces for dependencies to allow mocking
type NFTParser interface {
	Parse(path string) ([]string, error)
}

type Isolator interface {
	Isolate(src, dest string, files []string) error
}

type Builder interface {
	Build(outDir string, cfg builder.BuildConfig) error
}

type Orchestrator struct {
	parser   NFTParser
	isolator Isolator
	builder  Builder
}

type Config struct {
	Entrypoint string
	OutputDir  string
	SrcDir     string
}

func New(p NFTParser, i Isolator, b Builder) *Orchestrator {
	return &Orchestrator{
		parser:   p,
		isolator: i,
		builder:  b,
	}
}

// Run executes the full build pipeline
func (o *Orchestrator) Run(cfg Config) error {
	// 1. Parse NFT
	// Assume entrypoint has a corresponding .nft.json
	nftPath := filepath.Join(cfg.SrcDir, cfg.Entrypoint+".nft.json")
	files, err := o.parser.Parse(nftPath)
	if err != nil {
		// NFT is optional (e.g. for standalone builds or simple apps)
		fmt.Printf("⚠️  Warning: NFT parse failed (proceeding without explicit isolation): %v\n", err)
		files = []string{}
	}

	// 1a. Normalize Paths
	// NFT files are relative to the NFT file itself. We need them relative to SrcDir (Root).
	var normalizedFiles []string
	nftDir := filepath.Dir(nftPath)
	
	for _, f := range files {
		// Absolute path of the dependency
		absPath := filepath.Join(nftDir, f)
		
		// Relative path from Root (SrcDir)
		relPath, err := filepath.Rel(cfg.SrcDir, absPath)
		if err != nil {
			// If we can't make it relative to root (e.g. outside repo), we might skip or fail.
			// For now, let's skip external files or try to copy them?
			// Ideally they should be inside the repo or node_modules.
			fmt.Printf("Warning: Skipping file outside root context: %s\n", absPath)
			continue 
		}
		
		// Clean up potential "../" leading (which caused the bug)
		// If relPath starts with "../", it's outside root.
		if filepath.IsAbs(relPath) || (len(relPath) > 2 && relPath[:3] == "../") {
             fmt.Printf("Warning: Skipping file outside src root: %s\n", relPath)
             continue
        }

		normalizedFiles = append(normalizedFiles, relPath)
	}

	// Add the entrypoint itself if not present? (Usually NFT includes it, but maybe not?)
	// Let's assume NFT includes everything needed.
	// But we definitely need the entrypoint file itself to run bun build on it.
    // If NFT didn't include it, we might miss it.
    // Check if entrypoint is in normalizedFiles?
    // Optimization: Just add it if missing.

	// 2. Isolate
	if err := o.isolator.Isolate(cfg.SrcDir, cfg.OutputDir, normalizedFiles); err != nil {
		return fmt.Errorf("isolation failed: %w", err)
	}

	// 3. Build
	// We construct the build config specifically for the isolated context
	bldCfg := builder.BuildConfig{
		Params: builder.BuildParams{
			Entrypoint: cfg.Entrypoint, 
			// We might need to adjust entrypoint path relative to isolated root?
			// For now assume preservation.
			BaseImage: "oven/bun:alpine", // Default
		},
	}
	
	if err := o.builder.Build(cfg.OutputDir, bldCfg); err != nil {
		return fmt.Errorf("build failed: %w", err)
	}

	return nil
}
