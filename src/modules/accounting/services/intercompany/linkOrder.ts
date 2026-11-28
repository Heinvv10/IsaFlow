/** Pure: which side of a link a document goes on. A link names the connection's LOW company as A and its HIGH company as B (guard 1000 / 1002). */
export interface LinkDoc { type: string; id: string }

export function orderLinkDocs(senderIsLow: boolean, source: LinkDoc, target: LinkDoc): { a: LinkDoc; b: LinkDoc } {
  return senderIsLow ? { a: source, b: target } : { a: target, b: source };
}
