import { runProxyServer } from "./proxy_server.ts";

try {
	await runProxyServer();
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`${message}\n`);
	process.exitCode = 1;
}
