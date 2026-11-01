export function LoopForm({ rows }: { rows: string[] }) {
  return (
    <div>
      {rows.map((r) => (
        <div key={r}>
          <label>Amount</label>
          <input />
        </div>
      ))}
      {Array.from({ length: 2 }, (_, i) => (
        <div key={i}><label>Qty</label><input /></div>
      ))}
      <label>Total</label>
      <input />
    </div>
  );
}
