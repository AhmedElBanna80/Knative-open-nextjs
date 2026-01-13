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
		return fmt.Errorf("NFT parse failed: %w", err)
	}

	// 2. Isolate
	if err := o.isolator.Isolate(cfg.SrcDir, cfg.OutputDir, files); err != nil {
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
