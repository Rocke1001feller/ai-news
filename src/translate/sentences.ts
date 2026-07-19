/**
 * English sentence splitter for the bilingual pipeline.
 *
 * Splits on sentence-ending punctuation followed by whitespace + a likely
 * sentence start, while protecting common abbreviations and decimals so
 * "Mr. Bezos said..." or "valued at 3.5 billion" are not cut mid-sentence.
 * Errors are fail-safe: two sentences merged into one still read fine.
 */

const ABBREVIATIONS = [
  'Mr', 'Mrs', 'Ms', 'Dr', 'Prof', 'Sr', 'Jr', 'St', 'Mt', 'vs', 'etc',
  'e.g', 'i.e', 'U.S', 'U.K', 'Inc', 'Ltd', 'Corp', 'No', 'Fig', 'al',
  'ca', 'approx', 'Dept', 'Est', 'Ave', 'Jan', 'Feb', 'Mar', 'Apr', 'Jun',
  'Jul', 'Aug', 'Sep', 'Sept', 'Oct', 'Nov', 'Dec',
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ABBREV_RE = new RegExp(
  `\\b(?:${ABBREVIATIONS.map(escapeRe).join('|')})\\.`,
  'g',
);

const DECIMAL_RE = /\d+\.\d+/g;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s]+/g;
const PLACEHOLDER_RE = /§(\d+)§/g;

/** Split text into sentences. Input should already be whitespace-normalized. */
export function splitSentences(text: string): string[] {
  const s = text.replace(/\s+/g, ' ').trim();
  if (!s) return [];

  const saved: string[] = [];
  const hold = (m: string) => {
    saved.push(m);
    return `§${saved.length - 1}§`;
  };

  const work = s.replace(URL_RE, hold).replace(DECIMAL_RE, hold).replace(ABBREV_RE, hold);

  // Split at whitespace that follows [terminal punctuation + optional closing
  // quote/paren] and precedes a likely sentence start (quote/paren/placeholder/alnum).
  const parts = work.split(/(?<=[.!?…]+["'”’)\]]?)\s+(?=["'“‘(§A-Za-z0-9])/);

  return parts
    .map((p) => p.replace(PLACEHOLDER_RE, (_, i) => saved[Number(i)]).trim())
    .filter((p) => p.length > 0);
}
