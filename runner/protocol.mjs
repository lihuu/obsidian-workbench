import { StringDecoder } from "node:string_decoder";

/**
 * Pi's RPC stream is strict JSONL. Split only on LF so U+2028/U+2029 inside
 * JSON strings remain part of the record. StringDecoder preserves multi-byte
 * UTF-8 characters split across pipe chunks.
 */
export function createJsonlDecoder(onRecord, onError) {
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	let ended = false;

	const consume = () => {
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			let line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (line.trim()) {
				try {
					onRecord(JSON.parse(line));
				} catch (error) {
					onError(error, line);
				}
			}
			newline = buffer.indexOf("\n");
		}
	};

	return {
		push(chunk) {
			if (ended) throw new Error("JSONL decoder already ended.");
			buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
			consume();
		},
		end() {
			if (ended) return;
			ended = true;
			buffer += decoder.end();
			if (buffer.endsWith("\r")) buffer = buffer.slice(0, -1);
			if (buffer.trim()) {
				try {
					onRecord(JSON.parse(buffer));
				} catch (error) {
					onError(error, buffer);
				}
			}
			buffer = "";
		},
	};
}
