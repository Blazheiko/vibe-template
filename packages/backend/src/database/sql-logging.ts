// Drizzle's logger prints every statement with its parameters. That helps while developing and
// leaks personal data (emails, identifiers, anything bound as a parameter) into the logs of a
// production-like environment, so it is off there.
export const sqlLoggingEnabled = (app: { isProductionLike: boolean }): boolean =>
    !app.isProductionLike
