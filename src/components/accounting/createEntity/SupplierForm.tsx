import { INPUT, LABEL } from './styles';

interface Props {
  name: string;
  email: string;
  phone: string;
  onName: (v: string) => void;
  onEmail: (v: string) => void;
  onPhone: (v: string) => void;
}

export function SupplierForm({ name, email, phone, onName, onEmail, onPhone }: Props) {
  return (
    <>
      <div>
        <label className={LABEL}>Supplier Name *</label>
        <input type="text" value={name} onChange={e => onName(e.target.value)}
          placeholder="e.g. ACME Trading" className={INPUT} autoFocus />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={LABEL}>Email *</label>
          <input type="email" value={email} onChange={e => onEmail(e.target.value)}
            placeholder="info@supplier.co.za" className={INPUT} />
        </div>
        <div>
          <label className={LABEL}>Phone</label>
          <input type="tel" value={phone} onChange={e => onPhone(e.target.value)}
            placeholder="012 345 6789" className={INPUT} />
        </div>
      </div>
    </>
  );
}
