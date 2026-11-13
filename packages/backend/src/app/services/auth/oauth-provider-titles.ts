// The name of an OAuth provider as people read it: in mails and notices.
const PROVIDER_TITLES: Record<string, string> = {
    google: 'Google',
    facebook: 'Facebook',
    github: 'GitHub',
    gitlab: 'GitLab',
}

/** A provider this list does not know keeps its own name. */
export const providerTitle = (provider: string): string => PROVIDER_TITLES[provider] ?? provider
