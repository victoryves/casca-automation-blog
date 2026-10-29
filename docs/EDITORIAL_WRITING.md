# CASCA editorial writing

The article pipeline now uses a CASCA house style informed by
[Humanizer](https://github.com/blader/humanizer), with local
[Vale](https://github.com/vale-cli/vale) checks. This is editorial quality control,
not an AI-authorship detector or a promise to pass one.

## Runtime

- The main synthesis path (including deterministic fallback copy) runs
  `ArticleHumanizer` before accepting a new article. The local drafter worker
  also integrates this review. That worker is not yet versioned on upstream
  main; its review integration is preserved in
  `patches/local-drafter-editorial-review.patch` for that pending worker migration.
- Copy editing uses the existing OpenAI editorial client. A separate request
  compares changed copy against the original and the supplied research, checking
  factual meaning, attribution, certainty and English. Numeric/name/quotation
  locks and local checks run first. Two edit attempts are allowed.
- A rejected or unavailable review holds the draft for the existing retry path.
  The drafter no longer silently substitutes the unreviewed original.
- The old Finnish round-trip translation humanizer is no longer invoked.
- `humanizer_review` in artist metadata records the lint engine, advisory rules
  and whether copy was unchanged or passed the separate comparison.
- The final article approval-email preflight repeats mandatory copy checks so
  callers outside generation cannot send scraped UI, chat wrappers, duplicate
  paragraphs or more than four paragraphs. Existing title, word-count, image,
  deduplication and human-publication-approval gates remain in place.

## Voice and sources

`src/utils/editorial-style.ts` is the house voice. Prefer specific documented
works, materials and observations; preserve Northeast Brazilian place names,
artwork titles, source attribution and real uncertainty. Do not invent anecdotes,
visual details or influence to make prose livelier. Humanizer's general rules
are adapted to this factual editorial context: no blanket removal of hedges,
quotations, genuine contrasts or cultural terms.

The vendored Humanizer skill is under `vendor/editorial-skills/humanizer/` with
its upstream MIT license. It is a project reference, not a globally installed
Codex preference. The runtime uses the reviewed house instructions rather than
loading a changing remote prompt. Vale is pinned in `vendor/vale/release.json`.
The local executable is excluded from Git.

## Checks

```sh
python3 scripts/install-editorial-vale.py
npx tsx scripts/check-editorial-style.ts article.txt
npx vitest run tests/editorial-writing.test.ts tests/editorial-title.test.ts
```

The Vale config is `.vale.ini`, with CASCA rules in `config/vale/CASCA/`.
`CASCA_VALE_PATH` can select another executable. Missing the optional vendored
binary uses the mandatory TypeScript checks, recorded as `builtin`; a missing
explicitly configured binary, a failed Vale invocation or a failed audit is an
error. Vale runs offline with a ten-second limit and sends no article to a
remote service. It reports style warnings separately from blocking errors.
The existing OpenAI service receives the original, proposed text and research
for the comparison; this adds an API request when copy changes.

Review suggestions in context. Generic praise and staged openings are warnings,
not proof of AI authorship. Good copy can legitimately contain an unusual phrase,
a dash, a passive construction or a quote with a cliché. Automated and model
checks cannot establish factual truth; sources and human approval remain needed.

No real drafts, emails, publications, credentials or operational databases are
changed by the test suite. Existing published articles are not rewritten.
