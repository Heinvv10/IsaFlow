/** A page cursor past the end of a published audit result: the caller's input, answered 400 rather than as a fault. */
export class AuditPageCursorError extends Error {
 constructor(readonly total:number){
  super(`Page cursor is past the end of the result (${total} item${total===1?'':'s'})`);
  this.name='AuditPageCursorError';
 }
}
