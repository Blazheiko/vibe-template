// Frontend-facing query input types stay explicit: they say what a client may send (a number or a
// numeric string), which `inferIn` of a parse/default schema does not.
export type DateString = string
export type PositiveIntInput = string | number

// The two-function comparison is the standard way to ask a type system whether two types are
// identical (not merely assignable); its type parameters exist to be compared.
/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters */
export type AssertEqual<A, B> =
    (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
export type Expect<T extends true> = T
