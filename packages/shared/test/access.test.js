import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
    PERMISSIONS,
    ROLES,
    ROLE_DEFINITIONS,
    STAFF_ROLES,
    canAssignRole,
    isRole,
    isStaffRole,
    roleHasPermission,
} from '../dist/access/index.js'

// feat-240 (Р2, Р11): the expectations are written here, not read from the catalog, so a mistake
// in the catalog cannot confirm itself.
const EXPECTED_PERMISSIONS = {
    user: [],
    support_operator: ['users.read', 'audit.read.account', 'kb.read'],
    kb_editor: ['kb.read', 'kb.write'],
    user_admin: ['users.read', 'users.roles.assign', 'audit.read', 'audit.read.account'],
    admin: [...PERMISSIONS],
}

test('the roles and their order are those of the user_role enum', () => {
    assert.deepEqual([...ROLES], ['user', 'support_operator', 'kb_editor', 'user_admin', 'admin'])
})

test('each role has exactly the permissions of the plan', () => {
    for (const role of ROLES) {
        assert.deepEqual(
            [...ROLE_DEFINITIONS[role].permissions].sort(),
            [...EXPECTED_PERMISSIONS[role]].sort(),
            role,
        )
        for (const permission of PERMISSIONS) {
            assert.equal(
                roleHasPermission(role, permission),
                EXPECTED_PERMISSIONS[role].includes(permission),
                `${role} ${permission}`,
            )
        }
    }
})

test('every permission of a role is in the catalog, and admin has all of them', () => {
    for (const role of ROLES) {
        for (const permission of ROLE_DEFINITIONS[role].permissions) {
            assert.ok(PERMISSIONS.includes(permission), `${role}: ${permission}`)
        }
    }
    assert.deepEqual([...ROLE_DEFINITIONS.admin.permissions].sort(), [...PERMISSIONS].sort())
})

test('audit.read implies audit.read.account', () => {
    for (const role of ROLES) {
        if (roleHasPermission(role, 'audit.read')) {
            assert.ok(roleHasPermission(role, 'audit.read.account'), role)
        }
    }
})

test('a role delegates exactly when it has users.roles.assign', () => {
    for (const role of ROLES) {
        assert.equal(
            ROLE_DEFINITIONS[role].assignableRoles.length > 0,
            roleHasPermission(role, 'users.roles.assign'),
            role,
        )
    }
})

const isDelegate = (role) => role === 'admin' || roleHasPermission(role, 'users.roles.assign')

test('no role but admin gives a delegating role, so delegation never widens', () => {
    for (const role of ROLES) {
        if (role === 'admin') continue
        for (const given of ROLE_DEFINITIONS[role].assignableRoles) {
            assert.ok(!isDelegate(given), `${role} gives ${given}`)
        }
    }
})

test('the delegation closure of each role is its own assignableRoles', () => {
    for (const role of ROLES) {
        const reachable = new Set(ROLE_DEFINITIONS[role].assignableRoles)
        // Give a role, then act as its holder, as long as that reaches more roles.
        let grew = true
        while (grew) {
            grew = false
            for (const held of [...reachable]) {
                for (const next of ROLE_DEFINITIONS[held].assignableRoles) {
                    if (!reachable.has(next)) {
                        reachable.add(next)
                        grew = true
                    }
                }
            }
        }
        assert.deepEqual(
            [...reachable].sort(),
            [...ROLE_DEFINITIONS[role].assignableRoles].sort(),
            role,
        )
    }
})

// The whole table actor × current role × new role, from the plan (Р6, rule 2).
const MANAGED_BY_USER_ADMIN = ['user', 'support_operator', 'kb_editor']
const expectedAssign = (actor, from, to) => {
    if (actor === 'admin') return true
    if (actor === 'user_admin') {
        return MANAGED_BY_USER_ADMIN.includes(from) && MANAGED_BY_USER_ADMIN.includes(to)
    }
    return false
}

test('canAssignRole follows the delegation table for every transition', () => {
    let checked = 0
    for (const actor of ROLES) {
        for (const from of ROLES) {
            for (const to of ROLES) {
                assert.equal(
                    canAssignRole(actor, from, to),
                    expectedAssign(actor, from, to),
                    `${actor}: ${from} -> ${to}`,
                )
                checked += 1
            }
        }
    }
    assert.equal(checked, 125)
})

test('user_admin cannot touch an admin or a user_admin, nor give either', () => {
    for (const from of ROLES) {
        assert.equal(canAssignRole('user_admin', from, 'admin'), false, from)
        assert.equal(canAssignRole('user_admin', from, 'user_admin'), false, from)
    }
    for (const to of ROLES) {
        assert.equal(canAssignRole('user_admin', 'admin', to), false, to)
        assert.equal(canAssignRole('user_admin', 'user_admin', to), false, to)
    }
})

test('staff roles are the roles with a permission', () => {
    assert.deepEqual([...STAFF_ROLES], ['support_operator', 'kb_editor', 'user_admin', 'admin'])
    assert.equal(isStaffRole('user'), false)
    assert.equal(isStaffRole(null), false)
    assert.equal(roleHasPermission(undefined, 'kb.read'), false)
})

test('isRole accepts the catalog only', () => {
    for (const role of ROLES) assert.ok(isRole(role))
    for (const value of ['', 'Admin', 'root', null, 1, undefined])
        assert.equal(isRole(value), false)
})
