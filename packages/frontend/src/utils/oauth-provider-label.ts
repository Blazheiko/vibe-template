// The name of an OAuth provider as people read it. A provider this list does not know keeps
// the name the server gave it.
const LABELS: Record<string, string> = {
    google: 'Google',
    facebook: 'Facebook',
    github: 'GitHub',
    gitlab: 'GitLab',
}

export const oauthProviderLabel = (provider: string): string => LABELS[provider] ?? provider
