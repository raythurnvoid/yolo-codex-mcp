import { defineConfig } from "vite-plus";

export default defineConfig({
	fmt: {
		printWidth: 120,
		singleQuote: false,
		useTabs: true,
	},
	lint: {
		ignorePatterns: ["dist/**", "reference-submodules/**"],
		options: {
			typeAware: true,
			typeCheck: true,
		},
	},
	pack: {
		entry: {
			server: "src/server.ts",
		},
		format: ["esm"],
		platform: "node",
	},
});
