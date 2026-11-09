/**
 * 构建脚本：把 src/main.js 连同 CodeMirror 依赖打包成 client/entry.mjs。
 *
 * 插件静态服务只暴露 <plugin>/client/* 子树（server/plugins.ts 的
 * resolvePluginClientFile），所以产物必须自包含、无 bare import、不能跨出 client/。
 * 用法：npm install && npm run build
 */
import { build } from "esbuild";

await build({
	entryPoints: ["src/main.js"],
	bundle: true,
	format: "esm",
	outfile: "client/entry.mjs",
	target: "es2022",
	charset: "utf8",
	minify: false, // 入库可读；要体积可改 true
	banner: {
		js: "/* vscode-editor-pro 客户端 bundle —— 由 npm run build 生成，源码在 src/ */",
	},
});
console.log("built → client/entry.mjs");
