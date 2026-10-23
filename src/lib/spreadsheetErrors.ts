/**
 * Why an uploaded spreadsheet was refused. Every message is written for the
 * client, so a route may answer it as a 400 as it stands.
 */
export class SpreadsheetRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpreadsheetRefusedError';
  }
}

/** Past a size, row, column or output limit. */
export class SpreadsheetTooLargeError extends SpreadsheetRefusedError {
  constructor(message: string) {
    super(message);
    this.name = 'SpreadsheetTooLargeError';
  }
}

/** Not a workbook, or one whose structure no spreadsheet program writes. */
export class SpreadsheetMalformedError extends SpreadsheetRefusedError {
  constructor(message: string) {
    super(message);
    this.name = 'SpreadsheetMalformedError';
  }
}
