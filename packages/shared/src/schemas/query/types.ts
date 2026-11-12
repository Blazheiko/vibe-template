// What a client may send in a query string is what the schema accepts, in the client's own
// words: a schema parses strings, so its input type says `string` where the handler gets a
// number, while a client may pass a number and let the URL builder turn it into text.
// `QueryInputOf` derives that type from the schema (feat-183): the keys and their optionality
// come from the input of the schema, the value from what the schema hands to the handler.
export type DateString = string
export type PositiveIntInput = string | number

/** A value as a client sends it: the parsed number, date or flag, or its text. */
export type QueryWireValue<T> = T extends number
    ? number | string
    : T extends Date
      ? DateString
      : T extends boolean
        ? boolean | 'true' | 'false'
        : T

type Flatten<T> = { [K in keyof T]: T[K] } & {}

type WireFields<TIn, TOut> = Flatten<{
    [K in keyof TIn]: QueryWireValue<Exclude<K extends keyof TOut ? TOut[K] : TIn[K], undefined>>
}>

/** The query a client sends to a route whose query schema is `TSchema`. */
export type QueryInputOf<TSchema extends { inferIn: object; infer: object }> = WireFields<
    TSchema['inferIn'],
    TSchema['infer']
>

// The two-function comparison is the standard way to ask a type system whether two types are
// identical (not merely assignable); its type parameters exist to be compared.
/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters */
export type AssertEqual<A, B> =
    (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
export type Expect<T extends true> = T
