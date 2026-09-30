---
"zarrita": minor
---

Read only the needed rows of uncompressed chunks. When an array's only codec is `bytes` and the store supports `getRange`, `get` fetches the rows of each chunk that a selection touches with one range request, instead of the whole chunk. An uncompressed chunk is stored in C order, so those rows are one contiguous run of bytes.
