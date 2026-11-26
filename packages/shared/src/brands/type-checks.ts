import type * as plain from '../brand/index.js'
import type { Brand } from '../brand/index.js'
import type { AssertEqual, Expect } from '../schemas/query/types.js'
import type { EntityId } from './ids.js'
import type { Cursor, IsoDateTime, SessionPublicId } from './wire.js'

// feat-262 (plan Р2): the `Brand` of `shared/brand` has the shape ArkType's `.brand()` infers, so
// a schema's output and a value branded by a constructor are one type. Nothing imports this file;
// it exists to be compiled, and a change of ArkType's brand shape stops the build here.
export type BrandShapeChecks = [
    Expect<AssertEqual<Brand<string, 'EntityId'>, EntityId>>,
    // The wire brands of `shared/brand` (feat-268) are the types the schemas infer.
    Expect<AssertEqual<plain.EntityId, EntityId>>,
    Expect<AssertEqual<plain.IsoDateTime, IsoDateTime>>,
    Expect<AssertEqual<plain.Cursor, Cursor>>,
    Expect<AssertEqual<plain.SessionPublicId, SessionPublicId>>,
]
