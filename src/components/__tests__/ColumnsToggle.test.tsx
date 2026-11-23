import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../test/renderWithProviders';
import ColumnsToggle from '../ColumnsToggle';

describe('ColumnsToggle', () => {
  beforeEach(() => window.localStorage.clear());

  it('starts at 2 columns and switches to 1 and back, remembering the choice', () => {
    renderWithProviders(<ColumnsToggle />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to 1 column' }));
    expect(screen.getByRole('button', { name: 'Switch to 2 columns' })).toBeInTheDocument();
    expect(window.localStorage.getItem('pixdex.phoneColumns')).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to 2 columns' }));
    expect(window.localStorage.getItem('pixdex.phoneColumns')).toBe('2');
  });

  it('treats an unknown stored value as 2 columns', () => {
    window.localStorage.setItem('pixdex.phoneColumns', '7');
    renderWithProviders(<ColumnsToggle />);
    expect(screen.getByRole('button', { name: 'Switch to 1 column' })).toBeInTheDocument();
  });
});
