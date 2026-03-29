import { once } from "node:events";
import type { Writable } from "node:stream";

import type { JsonRpcMessage } from "./jsonrpc.ts";

export class JsonRpcLineWriter {
	#stream: Writable;
	#pending: Promise<void> = Promise.resolve();

	public constructor(stream: Writable) {
		this.#stream = stream;
	}

	public write(message: JsonRpcMessage): Promise<void> {
		const line = `${JSON.stringify(message)}\n`;
		this.#pending = this.#pending.then(async () => {
			if (this.#stream.destroyed) {
				throw new Error("Cannot write to a destroyed stream");
			}

			if (!this.#stream.write(line)) {
				await once(this.#stream, "drain");
			}
		});
		return this.#pending;
	}
}
