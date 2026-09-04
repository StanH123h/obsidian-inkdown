import esbuild from "esbuild";
import builtins from "builtin-modules";
import fs from "fs";
import path from "path";

// .dev-targets 里每行一个插件目录，构建后把产物拷过去。
// iCloud 不同步 symlink，所以 iPad 那份必须是真实拷贝。
const targets = fs.existsSync(".dev-targets")
  ? fs.readFileSync(".dev-targets", "utf8").split("\n").map(s => s.trim()).filter(Boolean)
  : [];

const deploy = {
  name: "deploy",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length) return;
      for (const dir of targets) {
        if (!fs.existsSync(dir)) { console.warn("  跳过（目录不存在）:", dir); continue; }
        for (const f of ["main.js", "manifest.json", "styles.css"])
          if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dir, f));
        console.log("  已部署 ->", dir);
      }
    });
  },
};

const production = process.argv[2] === "production";

// Obsidian 在运行时提供 "obsidian" 和 electron 这些模块，所以打包时要把它们排除掉。
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
