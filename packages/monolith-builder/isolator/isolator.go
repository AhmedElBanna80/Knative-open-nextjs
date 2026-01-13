package isolator

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// Isolate copies a list of files from srcRoot to destRoot, preserving structure.
func Isolate(srcRoot, destRoot string, files []string) error {
	for _, file := range files {
		srcPath := filepath.Join(srcRoot, file)
		destPath := filepath.Join(destRoot, file)

		// Create parent directories
		if err := os.MkdirAll(filepath.Dir(destPath), 0755); err != nil {
			return fmt.Errorf("failed to create dir for %s: %w", file, err)
		}

		// Copy File
		if err := copyFile(srcPath, destPath); err != nil {
			return fmt.Errorf("failed to copy %s: %w", file, err)
		}
	}
	return nil
}

func copyFile(src, dest string) error {
	sourceFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer sourceFile.Close()

	destFile, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer destFile.Close()

	_, err = io.Copy(destFile, sourceFile)
	return err
}
