import esbuild from "esbuild";
import builtins from "builtin-modules";
import fs from "fs";
import path from "path";

// One plugin directory per line in .dev-targets; build output is copied there.
// iCloud does not sync symlinks, so the iPad copy has to be a real one.
const targets = fs.existsSync(".dev-targets")
  ? fs.readFileSync(".dev-targets", "utf8").split("\n").map(s => s.trim()).filter(Boolean)
  : [];

const deploy = {
  name: "deploy",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length) return;
      for (const dir of targets) {
        if (!fs.existsSync(dir)) { console.warn("  skipped (no such directory):", dir); continue; }
        for (const f of ["main.js", "manifest.json", "styles.css"])
          if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dir, f));
        console.log("  deployed ->", dir);
      }
    });
  },
};

const production = process.argv[2] === "production";

// Obsidian provides "obsidian" and the electron modules at runtime, so keep them
// out of the bundle.
const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtins],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: production,
  plugins: [deploy],
});

if (production) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
