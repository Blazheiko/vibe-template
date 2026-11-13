// Imported first by main.ts, for its effect: the one-time token of a mailed link leaves the
// address before the router reads the location and before Sentry starts recording it
// (feat-205). See one-time-url-token.ts.
import { stripUrlTokenFromLocation } from './one-time-url-token'

stripUrlTokenFromLocation()
