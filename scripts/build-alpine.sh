#!/bin/bash
set -e

# Configuration
APP_DIR=${1:-"apps/file-manager"}
OUTPUT_DIR="packages/knative-next-builder/dist-deploy"
TARGET="bun-linux-x64-musl"

# Explicitly add Bun to PATH
export PATH="/Users/banna/.bun/bin:$PATH"

echo "Building for Alpine Linux ($TARGET)..."
echo "Project: $APP_DIR"
echo "Output: $OUTPUT_DIR"

# Ensure builder is ready (optional, or just go run)
# We will use go run to be sure
# Assuming we are at repo root

if [ ! -d "$APP_DIR" ]; then
  echo "Error: App directory $APP_DIR does not exist."
  exit 1
fi

# Run the builder
# We switch to the builder directory to ensure go.mod resolution works
# Note: we need to adjust paths since we are changing CWD

# We use /opt/homebrew/bin/go if available, else go
GO_BIN="go"
if [ -f "/opt/homebrew/bin/go" ]; then
    GO_BIN="/opt/homebrew/bin/go"
fi

# Resolve absolute paths first
ABS_APP_DIR=$(realpath "$APP_DIR")
mkdir -p "$OUTPUT_DIR"
ABS_OUTPUT_DIR=$(realpath "$OUTPUT_DIR")

pushd packages/knative-next-builder > /dev/null

$GO_BIN run cmd/builder/main.go \
  -dir "$ABS_APP_DIR" \
  -output "$ABS_OUTPUT_DIR" \
  -target "$TARGET" \
  -cleanup=true

popd > /dev/null

echo "Build complete. Output in $OUTPUT_DIR"
