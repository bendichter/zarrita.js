import type { Readable } from "@zarrita/storage";

import { type Array, getContext } from "../hierarchy.js";
import type { Chunk, DataType, Scalar, TypedArray } from "../metadata.js";
import {
	assertSharedArrayBufferAvailable,
	createBuffer,
	resolveSignal,
} from "../util.js";
import { BasicIndexer } from "./indexer.js";
import type {
	GetOptions,
	Prepare,
	Projection,
	SetFromChunk,
	SetScalar,
	Slice,
} from "./types.js";
import { createQueue } from "./util.js";

function unwrap<D extends DataType>(
	arr: TypedArray<D>,
	idx: number,
): Scalar<D> {
	return ("get" in arr ? arr.get(idx) : arr[idx]) as Scalar<D>;
}

export async function get<
	D extends DataType,
	Store extends Readable,
	Arr extends Chunk<D>,
	Sel extends (null | Slice | number)[],
>(
	arr: Array<D, Store>,
	selection: null | Sel,
	opts: GetOptions,
	setter: {
		prepare: Prepare<D, Arr>;
		setScalar: SetScalar<D, Arr>;
		setFromChunk: SetFromChunk<D, Arr>;
	},
): Promise<
	null extends Sel[number] ? Arr : Slice extends Sel[number] ? Arr : Scalar<D>
> {
	if (opts.useSharedArrayBuffer) {
		assertSharedArrayBufferAvailable();
	}

	let signal = resolveSignal(opts);
	let context = getContext(arr);
	let indexer = new BasicIndexer({
		selection,
		shape: arr.shape,
		chunkShape: arr.chunks,
	});

	// Handle scalar arrays (shape=[]) directly, since the indexer yields nothing
	// for zero-dimensional arrays.
	if (arr.shape.length === 0) {
		let { data } = await arr.getChunk(
			[],
			{ signal },
			{ useSharedArrayBuffer: opts.useSharedArrayBuffer },
		);
		// @ts-expect-error - TS can't narrow this conditional type
		return unwrap(data, 0);
	}

	let size = indexer.shape.reduce((a, b) => a * b, 1);
	let data: TypedArray<D>;
	if (opts.useSharedArrayBuffer) {
		let sample = new context.TypedArray(0);
		if (!("BYTES_PER_ELEMENT" in sample)) {
			console.warn(
				"zarrita: useSharedArrayBuffer is not supported for non-buffer-backed data types.",
			);
			data = new context.TypedArray(size);
		} else {
			let buffer = createBuffer(size * sample.BYTES_PER_ELEMENT, true);
			data = new context.TypedArray(buffer, 0, size);
		}
	} else {
		data = new context.TypedArray(size);
	}
	let out = setter.prepare(
		data,
		indexer.shape,
		context.getStrides(indexer.shape, indexer.outputAxes),
	);

	let queue = opts.createQueue?.() ?? createQueue();
	// Uncompressed chunks can be read in part: only the block a selection touches.
	// An array extension that overrides `getChunk` must see every chunk read,
	// so those arrays read whole chunks through it.
	let getChunkBlock =
		opts.useSharedArrayBuffer || overridesGetChunk(arr)
			? undefined
			: context.getChunkBlock;
	for (const { chunkCoords, mapping } of indexer) {
		queue.add(async () => {
			signal?.throwIfAborted();
			let block = getChunkBlock && selectedBlock(mapping, context.chunkShape);
			if (getChunkBlock && block) {
				let { start, shape } = block;
				let part = await getChunkBlock(chunkCoords, start, shape, { signal });
				if (!part) {
					let data = new context.TypedArray(shape.reduce((a, b) => a * b, 1));
					// @ts-expect-error: TS can't infer that `fillValue` is union (assumes never) but this is ok
					data.fill(context.fillValue);
					part = { data, shape, stride: context.getStrides(shape) };
				}
				let chunk = setter.prepare(part.data, part.shape, part.stride);
				setter.setFromChunk(out, chunk, block.mapping);
				return;
			}
			let { data, shape, stride } = await arr.getChunk(
				chunkCoords,
				{ signal },
				{ useSharedArrayBuffer: opts.useSharedArrayBuffer },
			);
			let chunk = setter.prepare(data, shape, stride);
			setter.setFromChunk(out, chunk, mapping);
		});
	}

	await queue.onIdle();

	// If the final out shape is empty (point selection), return a scalar.
	// @ts-expect-error - TS can't narrow this conditional type
	return indexer.shape.length === 0 ? unwrap(out.data, 0) : out;
}

/**
 * Whether `getChunk` was replaced on this array, as an array extension does.
 * `Array` defines `getChunk` on its prototype, so an own property is an override.
 */
function overridesGetChunk(arr: object): boolean {
	return Object.getOwnPropertyDescriptor(arr, "getChunk") !== undefined;
}

/**
 * The contiguous block of a C-order chunk that a selection reads.
 *
 * Along the first axis the block spans the first to the last row the
 * selection reads. If that is a single row, the block is narrowed in the same
 * way along the next axis, and so on. The axes after that are whole.
 *
 * `start` is where the block begins in the chunk, in items. `shape` has as
 * many axes as the chunk; the axes the block was narrowed to a single index
 * along have length 1. `mapping` is the projections relative to the block.
 * Returns undefined when the block is the whole chunk.
 */
function selectedBlock(
	mapping: Projection[],
	chunkShape: number[],
): { start: number; shape: number[]; mapping: Projection[] } | undefined {
	let start = 0;
	let shape = [...chunkShape];
	let shifted = [...mapping];
	for (let axis = 0; axis < mapping.length; axis++) {
		let range = selectedRange(mapping[axis]);
		if (!range) break;
		let [first, stop] = range;
		let rowItems = chunkShape.slice(axis + 1).reduce((a, b) => a * b, 1);
		start += first * rowItems;
		shape[axis] = stop - first;
		shifted[axis] = shiftProjection(mapping[axis], first);
		if (stop - first > 1) break;
	}
	if (shape.every((size, axis) => size === chunkShape[axis])) return undefined;
	return { start, shape, mapping: shifted };
}

/**
 * The first index along an axis that a chunk projection reads and one past
 * the last, or undefined when the indices are unknown.
 */
function selectedRange(projection: Projection): [number, number] | undefined {
	if (typeof projection.from === "number") {
		return [projection.from, projection.from + 1];
	}
	if (globalThis.Array.isArray(projection.from)) {
		let [start, end, step] = projection.from;
		if (step <= 0 || end <= start) return undefined;
		return [start, start + (Math.ceil((end - start) / step) - 1) * step + 1];
	}
	return undefined;
}

/** A projection relative to the indices read, which start at index `first`. */
function shiftProjection(projection: Projection, first: number): Projection {
	if (typeof projection.from === "number") {
		return { from: projection.from - first, to: null };
	}
	if (
		globalThis.Array.isArray(projection.from) &&
		globalThis.Array.isArray(projection.to)
	) {
		let [start, stop, step] = projection.from;
		return { from: [start - first, stop - first, step], to: projection.to };
	}
	return projection;
}
