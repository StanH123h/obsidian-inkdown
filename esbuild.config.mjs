import esbuild from "esbuild";
import fs from "fs";
import { builtinModules } from "module";
import path from "path";

// Print the version on every build and refuse to build when the two files
// disagree. A silent version regression once shipped because a sed pattern
// matched nothing after a revert, and the build still claimed success.
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
if (manifest.version !== pkg.version) {
  console.error(`version mismatch: manifest.json ${manifest.version} vs package.json ${pkg.version}`);
  process.exit(1);
}

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
        console.log(`  deployed v${manifest.version} ->`, dir);
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
  // The editor's own modules are Obsidian's too: an extension must use the
  // copy the editor runs on
  external: ["obsidian", "electron", "@codemirror/state", "@codemirror/view", ...builtinModules],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  // Bake the version into the bundle. The toolbar badge then reports which
  // main.js is loaded, rather than what manifest.json says -- the two are
  // separate files and a sync service can deliver them at different times.
  // Builds deployed to a test vault get the build time too: between releases
  // the version stays put, and this is what tells one deployed build from the
  // next. A release build leaves it out, so building the same commit always
  // gives the same main.js -- the community directory rebuilds each release
  // from source and checks that it matches the one attached.
  define: {
    __HW_VERSION__: JSON.stringify(manifest.version),
    __HW_BUILD__: JSON.stringify(targets.length ? new Date().toLocaleString("sv-SE", { hour12: false }).slice(5, 16) : ""),
  },
  minify: production,
  plugins: [deploy],
});

if (production) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
