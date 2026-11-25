// Fixture of no-brand-cast.test.mjs: the Brand shape of packages/shared/src/brand.
declare const brandKey: ' brand'
export type Brand<T, Id> = T & { readonly [brandKey]: [T, Id] }
export type UserId = Brand<bigint, 'UserId'>
export type Row = { id: UserId; name: string }
