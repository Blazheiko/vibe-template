import { ROLES, isRole, type Role } from 'shared/access'

// What `user:set-role` is asked to do (feat-240, roles plan Р7).

export interface UserSetRoleArgs {
    email: string
    role: Role
}

export const USAGE = 'Usage: pnpm --filter backend user:set-role --email <email> --role <role>'

export function parseUserSetRoleArgs(args: readonly string[]): UserSetRoleArgs {
    let email: string | undefined
    let role: string | undefined
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]
        const value = args[index + 1]
        if (arg === '--email' || arg === '--role') {
            if (value === undefined || value.startsWith('--')) {
                throw new Error(`${arg} needs a value. ${USAGE}`)
            }
            if (arg === '--email') {
                if (email !== undefined) throw new Error(`--email is given twice. ${USAGE}`)
                email = value
            } else {
                if (role !== undefined) throw new Error(`--role is given twice. ${USAGE}`)
                role = value
            }
            index += 1
        } else {
            throw new Error(`Unknown argument "${String(arg)}". ${USAGE}`)
        }
    }
    if (email === undefined || email.trim() === '') throw new Error(`No --email given. ${USAGE}`)
    if (role === undefined) throw new Error(`No --role given. ${USAGE}`)
    if (!isRole(role)) throw new Error(`Unknown role "${role}". Roles: ${ROLES.join(', ')}.`)
    return { email, role }
}
