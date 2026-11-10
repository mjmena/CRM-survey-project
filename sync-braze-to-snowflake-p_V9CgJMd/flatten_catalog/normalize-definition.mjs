// Expands `option_sets` references and `matrix` questions into plain single/multi
// questions, one per matrix row, keyed `<matrix>__<row slug>`. The renderers submit
// answers under those keys, so DIM_SURVEY_QUESTIONS must use the same expansion.
// Inline copies (keep in sync): poll-iam.html, prism_template_for_landingpage.liquid,
// and the preview template in prism-survey-agent-system-prompt.md.
export function normalizeDefinition(def) {
  const sets = def.option_sets || {};
  const opts = o => (typeof o === 'string' ? sets[o] || [] : o);
  const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const questions = {};
  const expanded = {};
  for (const [k, q] of Object.entries(def.questions || {})) {
    if (q.type !== 'matrix') {
      questions[k] = q.options === undefined ? q : Object.assign({}, q, { options: opts(q.options) });
      continue;
    }
    expanded[k] = (q.rows || []).map(row => {
      const rk = k + '__' + slug(row);
      questions[rk] = {
        type: q.multi ? 'multi' : 'single',
        question: q.question + ' — ' + row,
        row: row,
        matrix: { key: k, question: q.question, help_text: q.help_text },
        required: q.required,
        min_select: q.min_select,
        show_results: q.show_results,
        auto_advance: false,
        options: opts(q.options),
        show_if_answer: q.rows_from
          ? { question: q.rows_from, op: 'array_contains', values: [row] }
          : q.show_if_answer,
      };
      return rk;
    });
  }
  const pages = (def.pages || []).map(p => Object.assign({}, p, {
    groups: (p.groups || []).map(g => Object.assign({}, g, {
      questions: g.questions.flatMap(qk => expanded[qk] || [qk]),
    })),
  }));
  return Object.assign({}, def, { pages, questions });
}
