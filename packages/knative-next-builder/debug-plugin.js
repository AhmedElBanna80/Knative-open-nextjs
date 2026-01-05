import { plugin } from "bun";
import path from "path";
import fs from "fs";

console.log("DEBUG: debug-plugin loaded");

const findNextDist = () => {
    const cwd = process.cwd();
    // In monorepo context, verify where we are
    const candidates = [
        path.join(cwd, "node_modules", "next", "dist"), // local
        path.resolve(cwd, "../../node_modules", "next", "dist") // root
    ];

    for (const loc of candidates) {
        if (fs.existsSync(loc)) {
            console.log("DEBUG: Found next/dist at", loc);
            return loc;
        }
    }
    return null;
};

const NEXT_DIST = findNextDist();
if (!NEXT_DIST) {
    console.error("ERROR: Bun Plugin: Could not locate next/dist.");
} else {
    const FLIGHT_DIR = path.join(NEXT_DIST, "compiled/react-server-dom-webpack-experimental/cjs");
    console.log("DEBUG: FLIGHT_DIR:", FLIGHT_DIR);

    plugin({
      name: "nextjs-internal-resolver",
      setup(build) {
        console.log("DEBUG: Plugin setup called");
        
        build.onResolve({ filter: /^react-server-dom-webpack\/client$/ }, (args) => {
          console.log("DEBUG: Resolving client");
          return {
            path: path.join(FLIGHT_DIR, "react-server-dom-webpack-client.browser.production.min.js"),
          };
        });

        // ... other handlers ...
        build.onResolve({ filter: /^react-server-dom-webpack\/server.node$/ }, (args) => {
             console.log("DEBUG: Resolving server.node");
             return { path: path.join(FLIGHT_DIR, "react-server-dom-webpack-server.node.production.min.js") };
        });
        
         // Generic Fallback
        build.onResolve({ filter: /^react-server-dom-webpack\// }, (args) => {
             console.log("DEBUG: Resolving generic:", args.path);
             return { path: path.join(FLIGHT_DIR, "react-server-dom-webpack-server.node.production.min.js") };
        });
      },
    });
}
