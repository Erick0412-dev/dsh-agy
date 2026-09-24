// Hook-order gate for the browser half (src/client).
//
// WHY THIS EXISTS. Two shipped bugs in src/client/index.ts were the same defect:
// a component's hook count changed between renders, so React threw mid-render and
// the exception unmounted the whole Settings tree — a white panel that no click
// could revive.
//
//   1. `ModelsTab` ran `useMemo` after an early `return` (white-screened on tab
//      switch) — fixed in a39379e.
//   2. `thinkingSamples` was a lowercase function CALLED directly from the
//      parent's conditional branch while owning a `useState`, so the hook landed
//      on the PARENT's sequence (white-screened on expanding the section) —
//      fixed in 7bd096d.
//
// Both passed `tsc`, the 442 unit tests (the suite runs `environment: 'node'`
// and renders nothing) and CI. Hook order is a property of CALL STRUCTURE that
// neither the type system nor a non-rendering test can observe, so a static
// check is the only layer that covers it.
//
// SCOPE IS DELIBERATELY NARROW: only files that define React components, and
// only the two rules that catch this class of bug. A full `typescript-eslint`
// preset would report hundreds of stylistic findings on day one, and a noisy
// gate gets disabled — which is worse than no gate.
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default [
  {
    files: ['src/client/**/*.ts'],
    // The parser only: no stylistic rules come from these presets, we just need
    // TS syntax (`satisfies`, type annotations) to parse at all.
    languageOptions: { parser: tseslint.parser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // A hook must not be called conditionally, in a loop, or after an early
      // return: this is bug 1, and the form bug 2 collapses into as well.
      'react-hooks/rules-of-hooks': 'error',
      // A hook in a function that is neither a component (PascalCase) nor a
      // custom hook (useXxx) is attributed to its CALLER's fiber — bug 2.
      // `rules-of-hooks` covers most of this; the exhaustive-deps rule is NOT
      // enabled (it is a correctness-of-caching rule, not a crash rule, and it
      // fires on the many intentional omissions in this file).
    },
  },
]
