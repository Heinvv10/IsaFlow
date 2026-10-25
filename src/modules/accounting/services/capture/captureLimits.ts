/** Size limits of the capture pipeline, shared by the upload routes and the mailbox mirrors. */

/** The largest file the capture pipeline reads (10 MB): an upload over it is refused, a mirrored email over it (plus base64 overhead) is skipped. */
export const MAX_FILE_SIZE = 10 * 1024 * 1024;
