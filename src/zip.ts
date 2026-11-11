/**
 * Minimal deterministic ZIP writer (store method, no compression).
 *
 * `/nan-debug --emit` must produce a shareable archive that is reproducible
 * byte-for-byte from the same inputs (issue #35 S15). `Bun.Archive` is
 * Bun-only, and this package also runs under Node, so the container is built
 * here with `node:buffer` only: sorted entries, fixed 1980-01-01 timestamps,
 * stored (uncompressed) payloads and the UTF-8 name flag. That also keeps the
 * output readable with any unzip tool.
 */

import { Buffer } from "node:buffer";

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const VERSION_NEEDED = 20;
const UTF8_FLAG = 0x0800;
const STORED_METHOD = 0;
/** 1980-01-01 00:00:00, the DOS epoch: fixed for reproducible archives. */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

const CRC_TABLE: Uint32Array = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

/** CRC-32 (IEEE 802.3), as required by the ZIP container. */
export function crc32(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (let i = 0; i < data.length; i++) {
		crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
	name: string;
	data: Uint8Array | string;
}

/**
 * Build a store-method zip from the given entries. Entries are sorted by name
 * so the output does not depend on object/insertion order.
 */
export function createZip(entries: readonly ZipEntry[]): Buffer {
	const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;

	for (const entry of sorted) {
		const name = Buffer.from(entry.name, "utf8");
		const data = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : Buffer.from(entry.data);
		const crc = crc32(data);

		const local = Buffer.alloc(30 + name.length);
		local.writeUInt32LE(LOCAL_FILE_HEADER, 0);
		local.writeUInt16LE(VERSION_NEEDED, 4);
		local.writeUInt16LE(UTF8_FLAG, 6);
		local.writeUInt16LE(STORED_METHOD, 8);
		local.writeUInt16LE(DOS_TIME, 10);
		local.writeUInt16LE(DOS_DATE, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);
		name.copy(local, 30);
		locals.push(local, data);

		const central = Buffer.alloc(46 + name.length);
		central.writeUInt32LE(CENTRAL_DIRECTORY_HEADER, 0);
		central.writeUInt16LE(VERSION_NEEDED, 4);
		central.writeUInt16LE(VERSION_NEEDED, 6);
		central.writeUInt16LE(UTF8_FLAG, 8);
		central.writeUInt16LE(STORED_METHOD, 10);
		central.writeUInt16LE(DOS_TIME, 12);
		central.writeUInt16LE(DOS_DATE, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt16LE(0, 30);
		central.writeUInt16LE(0, 32);
		central.writeUInt16LE(0, 34);
		central.writeUInt16LE(0, 36);
		central.writeUInt32LE(0, 38);
		central.writeUInt32LE(offset, 42);
		name.copy(central, 46);
		centrals.push(central);

		offset += local.length + data.length;
	}

	const centralDirectory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
	end.writeUInt16LE(0, 4);
	end.writeUInt16LE(0, 6);
	end.writeUInt16LE(sorted.length, 8);
	end.writeUInt16LE(sorted.length, 10);
	end.writeUInt32LE(centralDirectory.length, 12);
	end.writeUInt32LE(offset, 16);
	end.writeUInt16LE(0, 20);

	return Buffer.concat([...locals, centralDirectory, end]);
}
