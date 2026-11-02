export default function SiblingForm({ v }: { v: string }) {
  return (
    <div className="grid">
      <label className="text-sm">Company name *</label>
      <input   value={v}  onChange={() => {}} />
      <label>Province</label>
      <select name="province" value={v}>
        <option>GP</option>
      </select>
      <label>Notes</label>
      <textarea rows={3} />
      <label htmlFor="done">Already named</label>
      <input id="done" />
      <label>Has aria</label>
      <input aria-label="Has aria" />
      <label>Spread</label>
      <input {...rest} />
      <label>Hidden</label>
      <input type="hidden" />
      <label>Wraps <input /></label>
      <label>Not adjacent</label>
      {flag && <span />}
      <input />
    </div>
  );
}
