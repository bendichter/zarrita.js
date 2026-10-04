---
"zarrita": minor
---

Read only the needed rows of uncompressed chunks. When an array's only codec is `bytes` (or it is a v2 array with no compressor, filters, or F order) and the store supports `getRange`, `get` fetches the rows of each chunk that a selection touches with one range request, instead of the whole chunk. An uncompressed chunk is stored in C order, so those rows are one contiguous run of bytes. A selection that touches a single row is narrowed in the same way along the next axis, so `[t, slice(y0, y1), slice(x0, x1)]` fetches only rows `y0` to `y1` of frame `t`. Arrays wrapped by an extension that overrides `getChunk` still read whole chunks through it.
