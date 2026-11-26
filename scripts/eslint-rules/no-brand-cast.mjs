// no-brand-cast (feat-263, ADR 0007 Р10): a value becomes a branded type (UserId, PasskeyId,
// EntityId…) only in a constructor module or through a schema, never by an `as` / `<T>` cast in
// the code that uses it. The rule asks the type checker for the final type of the cast, so an
// alias (`type X = UserId`), a renamed import or `as unknown as UserId` is caught, and a new brand
// needs no list: a brand is any type with the `' brand'` property of `Brand<T, Id>`
// (packages/shared/src/brand). It looks at the cast type and the members of its unions and
// intersections, not into the fields of an object type: `row as Row` of a row with branded
// columns is a cast of a row, not of an id. Constructor modules and tests are left out in the
// config (eslint.config.ts).

const BRAND_KEY = ' brand'

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

        /** @param {import('typescript').Type} type */
        const isBranded = (type) => {
            if (type.isUnion()) return type.types.some(isBranded)
            return checker.getPropertyOfType(type, BRAND_KEY) !== undefined
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
