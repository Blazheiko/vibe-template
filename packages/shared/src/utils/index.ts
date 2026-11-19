export * from './phone.js'
export { UTC_TIME_ZONE, allowedTimeZones, isAllowedTimeZone } from './time-zone.js'
export {
    UA_BROWSERS,
    UA_DEVICE_TYPES,
    UA_OPERATING_SYSTEMS,
    USER_AGENT_MAX_LENGTH,
    describeDevice,
    parseUserAgent,
    type ParsedUserAgent,
    type UaBrowser,
    type UaDeviceType,
    type UaOperatingSystem,
} from './user-agent.js'
