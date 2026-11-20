/**
 * The version of the contract between the daemon and its clients.
 *
 * It moves only when the contract changes, independently of the package version: an add-on
 * compares this number to learn whether the daemon can serve it, while clients built in this
 * repository also compare package versions to decide which daemon is newest.
 */
export const CONTRACT_VERSION = 1;
