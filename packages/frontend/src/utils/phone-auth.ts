/** Whether the build offers sign-in and registration by phone (VITE_AUTH_PHONE_ENABLED). */
export const isPhoneAuthEnabled = (): boolean => import.meta.env.VITE_AUTH_PHONE_ENABLED === 'true'
