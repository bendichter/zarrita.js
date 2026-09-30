import { gzipSync } from "node:zlib";
import type { AbsolutePath, RangeQuery } from "@zarrita/storage";
import { describe, expect, it } from "vitest";
import * as zarr from "../src/index.js";
import { cStride } from "./helpers.js";

/** An in-memory store that serves byte ranges and records every chunk read. */
class RangeStore {
	map = new Map<string, Uint8Array>();
	reads: { key: string; range?: RangeQuery; bytes: number }[] = [];

	get(key: AbsolutePath) {
		let value = this.map.get(key);
		if (value && !key.endsWith("zarr.json")) {
			this.reads.push({ key, bytes: value.length });
		}
		return value;
	}

	getRange(key: AbsolutePath, range: RangeQuery) {
		let value = this.map.get(key);
		if (!value) return undefined;
		let out =
			"suffixLength" in range
				? value.subarray(value.length - range.suffixLength)
				: value.subarray(range.offset, range.offset + range.length);
		this.reads.push({ key, range, bytes: out.length });
		return out;
	}

	set(key: AbsolutePath, value: Uint8Array) {
		this.map.set(key, value);
	}
}

const BYTES: zarr.CodecMetadata[] = [
	{ name: "bytes", configuration: { endian: "little" } },
];

async function int16Array(
	store: RangeStore | Map<string, Uint8Array>,
	shape: number[],
	chunkShape: number[],
	codecs: zarr.CodecMetadata[] = BYTES,
) {
	let arr = await zarr.create(zarr.root(store).resolve("/a"), {
		shape,
		chunkShape,
		dtype: "int16",
		codecs,
	});
	let size = shape.reduce((a, b) => a * b, 1);
	let data = new Int16Array(size);
	for (let i = 0; i < size; i++) data[i] = i % 30000;
	await zarr.set(arr, null, { data, shape, stride: cStride(shape) });
	if (store instanceof RangeStore) store.reads.length = 0;
	return arr;
}

function bytesRead(store: RangeStore) {
	return store.reads.reduce((total, r) => total + r.bytes, 0);
}

describe("partial reads of uncompressed chunks", () => {
	it("reads only the rows a slice touches", async () => {
		let store = new RangeStore();
		let arr = await int16Array(store, [10_000, 10], [10_000, 10]);
		let result = await zarr.get(arr, [zarr.slice(500, 600), 3]);
		expect(Array.from(result.data)).toEqual(
			Array.from({ length: 100 }, (_, i) => (500 + i) * 10 + 3),
		);
		expect(store.reads).toEqual([
			{ key: "/a/c/0/0", range: { offset: 10_000, length: 2000 }, bytes: 2000 },
		]);
	});

	it("reads a single row for a single element", async () => {
		let store = new RangeStore();
		let arr = await int16Array(store, [10_000, 10], [10_000, 10]);
		expect(await zarr.get(arr, [777, 5])).toBe((777 * 10 + 5) % 30000);
		expect(bytesRead(store)).toBe(20);
	});

	it("reads from the first to the last row of a stepped slice", async () => {
		let store = new RangeStore();
		let arr = await int16Array(store, [10_000, 10], [10_000, 10]);
		let result = await zarr.get(arr, [zarr.slice(10, 20, 3), null]);
		expect(result.shape).toEqual([4, 10]);
		expect(result.data[10]).toBe(130);
		expect(bytesRead(store)).toBe(10 * 10 * 2);
	});

	it("reads whole chunks when every row is selected", async () => {
		let store = new RangeStore();
		let arr = await int16Array(store, [10_000, 10], [10_000, 10]);
		await zarr.get(arr, null);
		expect(store.reads).toEqual([{ key: "/a/c/0/0", bytes: 200_000 }]);
	});

	it("reads only the touched rows of each chunk a selection spans", async () => {
		let store = new RangeStore();
		let arr = await int16Array(store, [4000, 10], [1000, 10]);
		await zarr.get(arr, [zarr.slice(990, 1010), 2]);
		expect(store.reads.map((r) => [r.key, r.bytes]).sort()).toEqual([
			["/a/c/0/0", 200],
			["/a/c/1/0", 200],
		]);
	});

	it("reads compressed chunks whole", async () => {
		let store = new RangeStore();
		let arr = await zarr.create(zarr.root(store).resolve("/a"), {
			shape: [1000, 10],
			chunkShape: [1000, 10],
			dtype: "int16",
			codecs: [...BYTES, { name: "gzip", configuration: { level: 1 } }],
		});
		let data = new Int16Array(10_000).map((_, i) => i);
		store.set(
			"/a/c/0/0",
			new Uint8Array(gzipSync(new Uint8Array(data.buffer))),
		);
		let result = await zarr.get(arr, [zarr.slice(10, 20), 0]);
		expect(Array.from(result.data)).toEqual(
			Array.from({ length: 10 }, (_, i) => (10 + i) * 10),
		);
		expect(store.reads).toHaveLength(1);
		expect(store.reads[0].range).toBeUndefined();
	});

	it("reads a chunk that was never written as the fill value", async () => {
		let store = new RangeStore();
		let arr = await zarr.create(zarr.root(store).resolve("/a"), {
			shape: [100, 4],
			chunkShape: [100, 4],
			dtype: "int16",
			codecs: BYTES,
			fillValue: 7,
		});
		let result = await zarr.get(arr, [zarr.slice(10, 20), null]);
		expect(Array.from(result.data)).toEqual(new Array(40).fill(7));
	});

	it("returns the same values as whole-chunk reads", async () => {
		let shape = [60, 7, 5];
		let chunkShape = [25, 7, 5];
		let partial = await int16Array(new RangeStore(), shape, chunkShape);
		let whole = await int16Array(new Map(), shape, chunkShape); // no getRange
		let selections: (zarr.Slice | number | null)[][] = [
			[zarr.slice(3, 9), null, null],
			[4, zarr.slice(1, 5), 2],
			[zarr.slice(20, 52, 5), 3, null],
			[59, 6, 4],
			[zarr.slice(null), zarr.slice(2, 3), null],
		];
		for (let selection of selections) {
			expect(await zarr.get(partial, selection)).toEqual(
				await zarr.get(whole, selection),
			);
		}
	});

	it("handles a store that ignores the range and sends the whole chunk", async () => {
		let store = new RangeStore();
		store.getRange = (key: AbsolutePath) => store.map.get(key);
		let arr = await int16Array(store, [100, 4], [100, 4]);
		let result = await zarr.get(arr, [zarr.slice(50, 52), 0]);
		expect(Array.from(result.data)).toEqual([200, 204]);
	});

	it("handles big-endian data", async () => {
		let store = new RangeStore();
		let arr = await int16Array(
			store,
			[500, 3],
			[500, 3],
			[{ name: "bytes", configuration: { endian: "big" } }],
		);
		let result = await zarr.get(arr, [zarr.slice(100, 103), 1]);
		expect(Array.from(result.data)).toEqual([301, 304, 307]);
		expect(bytesRead(store)).toBe(3 * 3 * 2);
	});
});
