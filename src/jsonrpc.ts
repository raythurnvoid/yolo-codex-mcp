export type JsonRpcId = number | string | null;

export type JsonRpcRequest = {
	jsonrpc: "2.0";
	id: JsonRpcId;
	method: string;
	params?: unknown;
};

export type JsonRpcNotification = {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
};

export type JsonRpcResponse = {
	jsonrpc: "2.0";
	id: JsonRpcId;
	result: unknown;
};

export type JsonRpcErrorObject = {
	code: number;
	message: string;
	data?: unknown;
};

export type JsonRpcErrorMessage = {
	jsonrpc: "2.0";
	id: JsonRpcId;
	error: JsonRpcErrorObject;
};

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse | JsonRpcErrorMessage;

export function parseJsonRpcMessage(line: string): JsonRpcMessage | null {
	const trimmed = line.trim();
	if (!trimmed) {
		return null;
	}

	const value = JSON.parse(trimmed);
	if (!isRecord(value) || value.jsonrpc !== "2.0") {
		throw new Error("Expected a JSON-RPC 2.0 object");
	}

	if (typeof value.method === "string") {
		if ("id" in value) {
			return {
				jsonrpc: "2.0",
				id: normalizeJsonRpcId(value.id),
				method: value.method,
				params: value.params,
			};
		}

		return {
			jsonrpc: "2.0",
			method: value.method,
			params: value.params,
		};
	}

	if ("result" in value && "id" in value) {
		return {
			jsonrpc: "2.0",
			id: normalizeJsonRpcId(value.id),
			result: value.result,
		};
	}

	if ("error" in value && "id" in value) {
		const error = value.error;
		if (!isRecord(error) || typeof error.code !== "number" || typeof error.message !== "string") {
			throw new Error("Expected a valid JSON-RPC error object");
		}

		return {
			jsonrpc: "2.0",
			id: normalizeJsonRpcId(value.id),
			error: {
				code: error.code,
				message: error.message,
				data: error.data,
			},
		};
	}

	throw new Error("Unrecognized JSON-RPC message shape");
}

export function isJsonRpcRequest(message: JsonRpcMessage): message is JsonRpcRequest {
	return "method" in message && "id" in message;
}

export function isJsonRpcNotification(message: JsonRpcMessage): message is JsonRpcNotification {
	return "method" in message && !("id" in message);
}

export function isJsonRpcResponse(message: JsonRpcMessage): message is JsonRpcResponse {
	return "result" in message;
}

export function isJsonRpcError(message: JsonRpcMessage): message is JsonRpcErrorMessage {
	return "error" in message;
}

export function jsonRpcIdKey(id: JsonRpcId): string {
	if (typeof id === "string") {
		return `string:${id}`;
	}
	if (typeof id === "number") {
		return `number:${id}`;
	}
	return "null";
}

export function createJsonRpcResponse(id: JsonRpcId, result: unknown): JsonRpcResponse {
	return {
		jsonrpc: "2.0",
		id,
		result,
	};
}

export function createJsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcErrorMessage {
	return {
		jsonrpc: "2.0",
		id,
		error: {
			code,
			message,
			data,
		},
	};
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeJsonRpcId(value: unknown): JsonRpcId {
	if (typeof value === "string" || typeof value === "number" || value === null) {
		return value;
	}

	throw new Error("Expected JSON-RPC id to be a string, number, or null");
}
