import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { RichText } from './CoachChat';

describe('RichText (AI reply formatting)', () => {
  it('renders bold, bullet and numbered lists, and paragraphs', () => {
    const { container } = render(
      <RichText
        text={'**Good:** you use stops.\n- Small risk\n- Followed plan\n1. Size down\n2. Wait after losses'}
      />,
    );
    expect(container.querySelector('strong')?.textContent).toBe('Good:');
    expect([...container.querySelectorAll('ul li')].map((li) => li.textContent)).toEqual([
      'Small risk',
      'Followed plan',
    ]);
    expect([...container.querySelectorAll('ol li')].map((li) => li.textContent)).toEqual([
      'Size down',
      'Wait after losses',
    ]);
  });

  it('never renders HTML from the model', () => {
    const { container } = render(<RichText text={'<img src=x onerror=alert(1)> **hi**'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
