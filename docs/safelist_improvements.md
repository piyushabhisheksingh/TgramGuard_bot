# Safelist Improvements

This release makes it easier to keep false positives under control without constantly hand-curating every inflection of a word.

## Automatic inflections for safelist terms

All safelist sources (`data/safe_terms_custom.txt`, dictionary wordlists, Supabase rows, etc.) now expand common English inflections automatically. When you add a term such as `assistant`, the bot will also safelist `assistants`, `assisting`, `assisted`, `assister`, and `assisters` without extra entries. This dramatically reduces churn for “ass/anal” collisions across business or academic discussions.

### What it means for maintainers

- Keep adding the *base* term; the bot covers `s`, `es`, `ed`, `ing`, `er`, `ers`, and the usual `y → ies/ied/ier` conversions where they make sense.
- You can still add specialized spellings (e.g. Hinglish phrases) and they will be honored as-is.
- The existing `npm run safelist:format` command still normalizes your lists—run it whenever you batch-edit the data files.

## Richer built-in safeguards

We widened the core regex safelist to cover:

- Broader assistant/associate/assess/assure/assignment families.
- Additional benign “cock” compounds (plural peacocks, cocktails, cockerels, cockneys, Cockburn, etc.).
- Extended Dickensian surnames and `-gandhi` variants.
- Analytics/analytical(adverbs) forms so “analytics report” or “analytical reasoning” no longer trigger reviews.

These are baked into `src/filters/lexicon.js`, so you benefit even without custom dictionaries.

## Tips for future additions

1. Add the most natural base spelling to `data/safe_terms_custom.txt` (one per line).
2. Run `npm run safelist:format` to keep the file tidy.
3. Restart the bot (or use the `/safelist_suggest` admin command) if you want the changes to load immediately.

With the new inflection support you rarely need to list every plural/tense, which should keep safelist maintenance lightweight even as your communities grow.
