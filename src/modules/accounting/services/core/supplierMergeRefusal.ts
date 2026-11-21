/** A supplier merge refused before anything moved (or rolled back whole); its message is safe to show. */
export class SupplierMergeRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupplierMergeRefusal';
  }
}
