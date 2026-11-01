export function CollisionForm() {
  const renderRow = () => (
    <p><label>Inner</label><input /></p>
  );
  return (
    <div>
      <label>Name</label>
      <input />
      <label>Name</label>
      <select />
      <label>Taken</label>
      <input />
      <span id="collision-form-taken" />
      <label>{dynamic}</label>
      <input />
      {renderRow()}
    </div>
  );
}

function Field() {
  return <><label>Twice</label><input /></>;
}

export function UsesFieldTwice() {
  return <><Field /><Field /></>;
}

function Row() {
  return <><label>Looped</label><input /></>;
}

export function RendersRowInALoop({ rows }: { rows: string[] }) {
  return <>{rows.map((r) => <Row key={r} />)}</>;
}
