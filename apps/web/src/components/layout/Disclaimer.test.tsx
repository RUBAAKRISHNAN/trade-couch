import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Disclaimer } from './AppShell';

describe('Disclaimer', () => {
  it('always says virtual money, learning only, not advice', () => {
    render(<Disclaimer />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('Virtual money');
    expect(note).toHaveTextContent('For learning only');
    expect(note).toHaveTextContent('Not investment advice');
  });
});
