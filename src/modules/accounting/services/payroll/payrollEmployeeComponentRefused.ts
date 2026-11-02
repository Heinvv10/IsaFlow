/** Raised before any write, so the caller can answer it as a 400 (a 4xx commits). */
export class EmployeeComponentRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmployeeComponentRefused';
  }
}
