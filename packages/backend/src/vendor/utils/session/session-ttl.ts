import sessionConfig from '#config/session.js'

/** Storage namespace of anonymous sessions stored in Redis: `session:anon_session:<id>`. */
export const ANON_SESSION_NAMESPACE = 'anon_session'

/**
 * Lifetime in seconds of a stored session, for its Redis record and its cookie alike:
 * anonymous sessions (they hold data, e.g. OAuth state) expire like the cookie-held ones,
 * signed-in sessions keep the full age.
 */
export const storedSessionTtl = (userToken: string): number =>
    userToken === ANON_SESSION_NAMESPACE ? sessionConfig.anonAge : sessionConfig.age
