import { defineConfig } from "vite-plus";

export default defineConfig({
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
