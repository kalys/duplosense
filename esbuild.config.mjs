import * as esbuild from "esbuild";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nm = path.join(__dirname, "node_modules");

const nodePolyfillPlugin = {
  name: "node-polyfills",
  setup(build) {
    // Redirect Node.js built-ins to their browser polyfill packages
    build.onResolve({ filter: /^(node:)?events$/ }, () => ({
      path: path.join(nm, "events", "events.js"),
    }));

    build.onResolve({ filter: /^(node:)?buffer$/ }, () => ({
      path: path.join(nm, "buffer", "index.js"),
    }));

    build.onResolve({ filter: /^(node:)?process$/ }, () => ({
      path: path.join(nm, "process", "browser.js"),
    }));

    // Stub debug with a noop — node-poweredup only uses it for logging
    build.onResolve({ filter: /^debug$/ }, () => ({
      path: "debug",
      namespace: "node-stub",
    }));
    build.onLoad({ filter: /^debug$/, namespace: "node-stub" }, () => ({
      contents: `export default function debug() { return function() {}; }`,
    }));

    // Stub out 'module' (createRequire is used for optional noble dependency)
    build.onResolve({ filter: /^(node:)?module$/ }, () => ({
      path: "module",
      namespace: "node-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({
      contents: `
        function noop() { return noop; }
        noop.enable = noop;
        noop.disable = noop;
        noop.enabled = false;
        export function createRequire() {
          return function() { return noop; };
        }`,
    }));

  },
};

const watch = process.argv.includes("--watch");

const ctx = await esbuild.context({
  entryPoints: ["src/index.js"],
  bundle: true,
  format: "iife",
  globalName: "Duplo",
  outfile: "bundle.js",
  sourcemap: true,
  platform: "browser",
  define: {
    "process.env.NODE_ENV": '"production"',
    global: "window",
  },
  banner: { js: "// Duplo bundle" },
  footer: { js: "window.Duplo = Duplo;" },
  plugins: [nodePolyfillPlugin],
  logLevel: "info",
});

if (watch) {
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
