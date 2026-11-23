import { fireEvent, screen } from '@testing-library/react';
import { TbCalendar, TbStar } from 'react-icons/tb';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/renderWithProviders';
import SortIcons from '../SortIcons';

const options = [
  { value: 'date', label: 'Newest first', icon: TbCalendar },
  { value: 'rating', label: 'Best rated', icon: TbStar },
];

describe('SortIcons', () => {
  it('shows one button per option, the current one pressed', () => {
    renderWithProviders(<SortIcons options={options} value="rating" onChange={() => {}} label="Sort photos" />);
    expect(screen.getByRole('button', { name: 'Best rated' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Newest first' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('calls onChange with the clicked value', () => {
    const onChange = vi.fn();
    renderWithProviders(<SortIcons options={options} value="date" onChange={onChange} label="Sort photos" />);
    fireEvent.click(screen.getByRole('button', { name: 'Best rated' }));
    expect(onChange).toHaveBeenCalledWith('rating');
  });

  it('offers the same choices from the single phone menu button', async () => {
    const onChange = vi.fn();
    renderWithProviders(<SortIcons options={options} value="date" onChange={onChange} label="Sort photos" />);
    // The trigger names the current choice, and so does its menu item.
    fireEvent.click(screen.getByRole('button', { name: 'Sort photos, Newest first' }));
    expect(await screen.findByRole('menuitem', { name: 'Newest first (current)' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Best rated' }));
    expect(onChange).toHaveBeenCalledWith('rating');
  });
});
