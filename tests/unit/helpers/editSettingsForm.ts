// Company Settings keeps Save closed until the loaded form is edited. Let the mocked reads settle (an edit made
// before they do becomes part of the clean baseline), then type into one field.
import { act, fireEvent, screen } from '@testing-library/react';

export async function editSettingsForm(label: string, value = 'edited'): Promise<void> {
  await screen.findAllByLabelText(label);
  await act(() => new Promise<void>((r) => setTimeout(r, 20)));
  fireEvent.change(screen.getAllByLabelText(label)[0] as HTMLElement, { target: { value } });
}
