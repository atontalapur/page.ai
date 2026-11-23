// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import AgentText from './AgentText';

afterEach(cleanup);

describe('AgentText', () => {
  it('renders paragraphs, inline code, bold, code blocks and lists', () => {
    const text = [
      'Now I can see the issue. The `getProduct` function is **wrong**:',
      '```sql',
      'select * from products where id = $1 or slug = $1',
      '```',
      '',
      'The table has:',
      '- `id` as `serial`',
      '- `slug` as `text`',
    ].join('\n');
    const { container } = render(<AgentText text={text} />);

    expect([...container.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      'Now I can see the issue. The getProduct function is wrong:',
      'The table has:',
    ]);
    expect(container.querySelector('strong')?.textContent).toBe('wrong');
    expect(container.querySelector('pre')?.textContent).toBe(
      'select * from products where id = $1 or slug = $1',
    );
    expect([...container.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'id as serial',
      'slug as text',
    ]);
    expect(container.querySelectorAll('li code')).toHaveLength(4);
  });

  it('keeps markup in the text as text', () => {
    const { container } = render(<AgentText text={'<img src=x onerror=alert(1)> and `<b>`'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toBe('<img src=x onerror=alert(1)> and <b>');
  });
});
