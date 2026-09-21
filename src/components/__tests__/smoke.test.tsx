import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

function Hello() {
  return <p>pixdex</p>;
}

describe('frontend test harness', () => {
  it('can render and query a component', () => {
    render(<Hello />);
    expect(screen.getByText('pixdex')).toBeInTheDocument();
  });
});
