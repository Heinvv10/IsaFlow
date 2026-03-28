import { describe, it, expect } from 'vitest';
import { validateAsset, validateDisposal, generateAssetNumber, SARS_WEAR_AND_TEAR, type AssetInput, type DisposalInput } from '@/modules/accounting/services/assetService';

describe('Asset Input Validation', () => {
  const validAsset: AssetInput = { name: 'Dell Laptop XPS 15', category: 'computers', purchaseDate: '2026-01-15', cost: 25000, salvageValue: 2500, usefulLifeYears: 3, depreciationMethod: 'straight_line', location: 'Head Office', status: 'available' };
  it('accepts a valid asset', () => { expect(validateAsset(validAsset).success).toBe(true); });
  it('rejects missing name', () => { const r = validateAsset({ ...validAsset, name: '' }); expect(r.success).toBe(false); expect(r.errors).toContainEqual(expect.objectContaining({ field: 'name' })); });
  it('rejects negative cost', () => { expect(validateAsset({ ...validAsset, cost: -1000 }).success).toBe(false); });
  it('rejects zero cost', () => { expect(validateAsset({ ...validAsset, cost: 0 }).success).toBe(false); });
  it('rejects salvage > cost', () => { const r = validateAsset({ ...validAsset, salvageValue: 30000 }); expect(r.success).toBe(false); expect(r.errors).toContainEqual(expect.objectContaining({ field: 'salvageValue' })); });
  it('rejects negative useful life', () => { expect(validateAsset({ ...validAsset, usefulLifeYears: -1 }).success).toBe(false); });
  it('rejects zero useful life', () => { expect(validateAsset({ ...validAsset, usefulLifeYears: 0 }).success).toBe(false); });
  it('rejects invalid depreciation method', () => { expect(validateAsset({ ...validAsset, depreciationMethod: 'invalid' as any }).success).toBe(false); });
  it('accepts valid depreciation methods', () => { for (const m of ['straight_line', 'reducing_balance', 'sum_of_years']) expect(validateAsset({ ...validAsset, depreciationMethod: m as any }).success).toBe(true); });
  it('rejects future purchase date', () => { const f = new Date(); f.setFullYear(f.getFullYear() + 1); expect(validateAsset({ ...validAsset, purchaseDate: f.toISOString().split('T')[0]! }).success).toBe(false); });
  it('rejects invalid date format', () => { expect(validateAsset({ ...validAsset, purchaseDate: 'not-a-date' }).success).toBe(false); });
  it('accepts valid statuses', () => { for (const s of ['available', 'assigned', 'in_maintenance', 'disposed', 'written_off']) expect(validateAsset({ ...validAsset, status: s as any }).success).toBe(true); });
});

describe('Asset Disposal Validation', () => {
  const validDisposal: DisposalInput = { assetId: '123e4567-e89b-12d3-a456-426614174000', disposalDate: '2026-03-15', disposalMethod: 'sale', disposalAmount: 5000, reason: 'End of useful life' };
  it('accepts valid disposal', () => { expect(validateDisposal(validDisposal).success).toBe(true); });
  it('rejects without asset ID', () => { expect(validateDisposal({ ...validDisposal, assetId: '' }).success).toBe(false); });
  it('rejects negative disposal amount', () => { expect(validateDisposal({ ...validDisposal, disposalAmount: -100 }).success).toBe(false); });
  it('allows zero amount for write-offs', () => { expect(validateDisposal({ ...validDisposal, disposalMethod: 'write_off', disposalAmount: 0 }).success).toBe(true); });
  it('requires reason', () => { expect(validateDisposal({ ...validDisposal, reason: '' }).success).toBe(false); });
  it('accepts valid disposal methods', () => { for (const m of ['sale', 'scrap', 'write_off', 'donation', 'theft', 'insurance_claim']) expect(validateDisposal({ ...validDisposal, disposalMethod: m as any }).success).toBe(true); });
});

describe('Asset Number Generation', () => {
  it('generates sequential numbers', () => { expect(generateAssetNumber('computers', 0)).toBe('COMP-0001'); expect(generateAssetNumber('computers', 1)).toBe('COMP-0002'); });
  it('uses correct prefix per category', () => { expect(generateAssetNumber('computers', 0)).toMatch(/^COMP-/); expect(generateAssetNumber('motor_vehicles', 0)).toMatch(/^VEHI-/); expect(generateAssetNumber('furniture', 0)).toMatch(/^FURN-/); expect(generateAssetNumber('office_equipment', 0)).toMatch(/^OFEQ-/); expect(generateAssetNumber('buildings', 0)).toMatch(/^BLDG-/); expect(generateAssetNumber('machinery', 0)).toMatch(/^MACH-/); });
  it('pads numbers to 4 digits', () => { expect(generateAssetNumber('computers', 0)).toBe('COMP-0001'); expect(generateAssetNumber('computers', 99)).toBe('COMP-0100'); expect(generateAssetNumber('computers', 999)).toBe('COMP-1000'); });
});

describe('SARS Wear-and-Tear Categories', () => {
  it('computers 33.33%', () => { expect(SARS_WEAR_AND_TEAR.computers.rate).toBeCloseTo(33.33, 0); expect(SARS_WEAR_AND_TEAR.computers.years).toBe(3); });
  it('motor vehicles 20%', () => { expect(SARS_WEAR_AND_TEAR.motor_vehicles.rate).toBeCloseTo(20, 0); expect(SARS_WEAR_AND_TEAR.motor_vehicles.years).toBe(5); });
  it('furniture 16.67%', () => { expect(SARS_WEAR_AND_TEAR.furniture.rate).toBeCloseTo(16.67, 0); expect(SARS_WEAR_AND_TEAR.furniture.years).toBe(6); });
  it('office equipment 20%', () => { expect(SARS_WEAR_AND_TEAR.office_equipment.rate).toBeCloseTo(20, 0); expect(SARS_WEAR_AND_TEAR.office_equipment.years).toBe(5); });
  it('buildings 5%', () => { expect(SARS_WEAR_AND_TEAR.buildings.rate).toBe(5); expect(SARS_WEAR_AND_TEAR.buildings.years).toBe(20); });
  it('machinery 12.5%', () => { expect(SARS_WEAR_AND_TEAR.machinery.rate).toBe(12.5); expect(SARS_WEAR_AND_TEAR.machinery.years).toBe(8); });
  it('manufacturing equipment 25%', () => { expect(SARS_WEAR_AND_TEAR.manufacturing_equipment.rate).toBe(25); expect(SARS_WEAR_AND_TEAR.manufacturing_equipment.years).toBe(4); });
  it('small tools 50%', () => { expect(SARS_WEAR_AND_TEAR.small_tools.rate).toBe(50); expect(SARS_WEAR_AND_TEAR.small_tools.years).toBe(2); });
  it('aircraft 25%', () => { expect(SARS_WEAR_AND_TEAR.aircraft.rate).toBe(25); expect(SARS_WEAR_AND_TEAR.aircraft.years).toBe(4); });
  it('all have descriptions', () => { for (const [, val] of Object.entries(SARS_WEAR_AND_TEAR)) { expect(val).toHaveProperty('description'); expect(val.description.length).toBeGreaterThan(0); } });
});
