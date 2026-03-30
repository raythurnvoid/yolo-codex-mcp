import { readFile } from "node:fs/promises";

type GuidanceResource = {
	fileName: string;
	mimeType: "text/markdown";
	name: string;
	uri: string;
};

const guidanceResources: GuidanceResource[] = [
	{
		fileName: "operating-guide.md",
		mimeType: "text/markdown",
		name: "operating-guide",
		uri: "yolo-codex-mcp://guides/operating-guide.md",
	},
];

export function createResourcesListResult() {
	return {
		resources: guidanceResources.map(({ fileName: _fileName, ...resource }) => resource),
	};
}

export async function createResourcesReadResult(uri: string) {
	const resource = guidanceResources.find((candidate) => candidate.uri === uri) ?? null;
	if (resource === null) {
		return null;
	}

	return {
		contents: [
			{
				uri: resource.uri,
				mimeType: resource.mimeType,
				text: await readFile(new URL(`../mcp-resources/${resource.fileName}`, import.meta.url), "utf8"),
			},
		],
	};
}
