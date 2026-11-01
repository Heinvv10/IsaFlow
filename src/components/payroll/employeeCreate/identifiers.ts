/**
 * The form's copy of isValidSarsTaxNumber and isValidSaIdNumber. Those two are pure but live in irp5ValidationEngine,
 * which imports the database layer, so a page cannot import them. employeePayOnCreate.test.tsx holds these equal to
 * the engine's, and the server re-checks with the engine's own.
 */
export const isValidEmployeeTaxNumber = (value: string) => /^[01239]\d{9}$/.test(value.trim());
export const isValidEmployeeIdNumber = (value: string) => /^\d{13}$/.test(value.trim());
