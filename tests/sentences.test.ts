import { describe, it, expect } from 'vitest';
import { splitSentences } from '../src/translate/sentences.js';

describe('splitSentences', () => {
  it('splits plain sentences', () => {
    expect(splitSentences('Hello world. How are you? I am fine!')).toEqual([
      'Hello world.',
      'How are you?',
      'I am fine!',
    ]);
  });

  it('protects common abbreviations', () => {
    expect(splitSentences('Mr. Bezos said it. Dr. Lee agreed.')).toEqual([
      'Mr. Bezos said it.',
      'Dr. Lee agreed.',
    ]);
  });

  it('protects decimals and urls', () => {
    expect(
      splitSentences('The stock rose 3.5 percent. See https://example.com/a.b for details. Done.'),
    ).toEqual(['The stock rose 3.5 percent.', 'See https://example.com/a.b for details.', 'Done.']);
  });

  it('handles quotes after terminal punctuation', () => {
    expect(splitSentences('He said "we are done." Then he left.')).toEqual([
      'He said "we are done."',
      'Then he left.',
    ]);
  });

  it('returns empty for empty input', () => {
    expect(splitSentences('   ')).toEqual([]);
  });

  it('keeps single sentence intact', () => {
    expect(splitSentences('Just one sentence here')).toEqual(['Just one sentence here']);
  });
});
