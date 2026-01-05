package plugins

import (
	"fmt"
	"os"
	"path/filepath"
)

const bunPluginTemplate = `import { plugin } from "bun";
import path from "path";

// Locate the root of the Next.js installation
// This finds the path to next/dist relative to the execution context or node_modules
// We start from the current working directory which bun-runner runs in
const findNextDist = () => {
    try {
        // Try standard node_modules resolution
        return path.resolve(process.cwd(), "node_modules/next/dist");
    } catch (e) {
        return null;
    }
};

const NEXT_DIST = findNextDist();
if (!NEXT_DIST) {
    console.warn("Bun Plugin: Could not locate next/dist. Compilation might fail.");
}

// Define the base path for the compiled React Flight artifacts
const FLIGHT_DIR = path.join(NEXT_DIST, "compiled/react-server-dom-webpack-experimental/cjs");

plugin({
  name: "nextjs-internal-resolver",
  setup(build) {
    // Intercept imports for the Client Runtime
    build.onResolve({ filter: /^react-server-dom-webpack\/client$/ }, (args) => {
      return {
        path: path.join(FLIGHT_DIR, "react-server-dom-webpack-client.browser.production.min.js"),
      };
    });

    // Intercept imports for the Node.js Server Runtime
    build.onResolve({ filter: /^react-server-dom-webpack\/server.node$/ }, (args) => {
      return {
        path: path.join(FLIGHT_DIR, "react-server-dom-webpack-server.node.production.min.js"),
      };
    });

    // Intercept imports for the Edge Runtime
    build.onResolve({ filter: /^react-server-dom-webpack\/server.edge$/ }, (args) => {
      return {
        path: path.join(FLIGHT_DIR, "react-server-dom-webpack-server.edge.production.min.js"),
      };
    });

    // Generic Fallback for "react-server-dom-webpack/server" -> Node
    build.onResolve({ filter: /^react-server-dom-webpack\/server$/ }, (args) => {
         return {
            path: path.join(FLIGHT_DIR, "react-server-dom-webpack-server.node.production.min.js"),
        };
    });
  },
});
`

// GenerateBunPlugin creates the bun-plugin.js file in the specified directory
func GenerateBunPlugin(outputDir string) (string, error) {
	pluginPath := filepath.Join(outputDir, "bun-plugin.js")
	if err := os.WriteFile(pluginPath, []byte(bunPluginTemplate), 0644); err != nil {
		return "", fmt.Errorf("failed to write bun-plugin.js: %w", err)
	}
	return pluginPath, nil
}
