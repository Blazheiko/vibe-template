// no-brand-cast (feat-263, ADR 0007 Р10): a value becomes a branded type (UserId, PasskeyId,
// EntityId…) only in a constructor module or through a schema, never by an `as` / `<T>` cast in
// the code that uses it. The rule asks the type checker for the final type of the cast, so an
// alias (`type X = UserId`), a renamed import or `as unknown as UserId` is caught, and a new brand
// needs no list: a brand is any type with the `' brand'` property of `Brand<T, Id>`
// (packages/shared/src/brand). It looks at the cast type and the members of its unions and
// intersections, not into the fields of an object type: `row as Row` of a row with branded
// columns is a cast of a row, not of an id. Constructor modules and tests are left out in the
// config (eslint.config.ts).

import ts from 'typescript'

const BRAND_KEY = ' brand'

/**
 * A generic instance (`Promise<X>`, `X[]`, `[X]`): its type arguments are its elements. The flags
 * come from the installed compiler: their numbers changed between TypeScript 5 and 6.
 * @param {import('typescript').Type} type
 * @returns {type is import('typescript').TypeReference}
 */
const isTypeReference = (type) => {
    if ((type.flags & ts.TypeFlags.Object) === 0) return false
    const object = /** @type {import('typescript').ObjectType} */ (type)
    return (object.objectFlags & ts.ObjectFlags.Reference) !== 0
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Disallow casts to a branded type outside its constructor module',
        },
        messages: {
            brandCast:
                "Cast to the branded type '{{type}}': brand a value through its constructor (app/domain, shared/brand) or a schema, not with a cast (ADR 0007).",
        },
        schema: [],
    },
    create(context) {
        const services = context.sourceCode.parserServices
        if (services?.program === undefined || services.program === null) return {}
        const checker = services.program.getTypeChecker()

        /**
         * feat-271: also the element of a container that holds the brand (an array, a tuple, a
         * Promise, a Set, a Map, a Record or another generic type argument, through its index
         * signatures) and the constraint of a type parameter (`<T extends UserId | null>(v) => v
         * as T`). Fields of an object type stay out (see the header).
         * @param {import('typescript').Type} type
         * @param {Set<import('typescript').Type>} seen
         * @returns {boolean}
         */
        const isBranded = (type, seen = new Set()) => {
            if (seen.has(type)) return false
            seen.add(type)
            if (type.isUnion() || type.isIntersection()) {
                if (checker.getPropertyOfType(type, BRAND_KEY) !== undefined) return true
                return type.types.some((member) => isBranded(member, seen))
            }
            if (type.isTypeParameter()) {
                const constraint = checker.getBaseConstraintOfType(type)
                return (
                    constraint !== undefined && constraint !== type && isBranded(constraint, seen)
                )
            }
            if (checker.getPropertyOfType(type, BRAND_KEY) !== undefined) return true
            const args = isTypeReference(type) ? checker.getTypeArguments(type) : []
            if (args.some((arg) => isBranded(arg, seen))) return true
            return checker.getIndexInfosOfType(type).some((info) => isBranded(info.type, seen))
        }

        /** @param {any} node */
        const check = (node) => {
            const annotation = node.typeAnnotation
            if (
                annotation.type === 'TSTypeReference' &&
                annotation.typeName.type === 'Identifier' &&
                annotation.typeName.name === 'const'
            ) {
                return
            }
            const tsNode = services.esTreeNodeToTSNodeMap.get(annotation)
            const type = checker.getTypeFromTypeNode(tsNode)
            if (isBranded(type)) {
                context.report({
                    node,
                    messageId: 'brandCast',
                    // The text of the annotation, not checker.typeToString(): printing a type
                    // from another module asks TypeScript for a module specifier, which throws
                    // for some programs (seen in CI on the RuleTester fixtures).
                    data: { type: context.sourceCode.getText(annotation) },
                })
            }
        }

        return { TSAsExpression: check, TSTypeAssertion: check }
    },
}

export default rule
