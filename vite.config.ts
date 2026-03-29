import { defineConfig } from "vite-plus";

export default defineConfig({
	fmt: {
		ignorePatterns: ["dist/**", "reference-submodules/**"],
		useTabs: true,
		singleQuote: false,
		printWidth: 120,
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
