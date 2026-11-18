// feat-222: what a clean-up service reports. `matched` rows qualified, `changed` were actually
// deleted or updated (0 on a dry run). A scheduled job passes it on as its JobResult.
export interface PurgeCounts {
    matched: number
    changed: number
}
